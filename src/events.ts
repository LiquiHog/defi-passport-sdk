/**
 * Decoding the events a passport logs, so a UI can show what actually happened.
 *
 * DECODE PER TAG, NEVER GENERICALLY. The tempting shape is "a fill is a fill" —
 * read a couple of u64s off a known offset — and it misreads three of the four
 * strategy fills, silently and plausibly. Compare field 3:
 *
 *   sfill  sid ruleId spend    outDelta  fee    refund  floor   schedule / DCA
 *   ofill  sid ruleId spend    outDelta  fee    refund          limit
 *   gfill  sid ruleId cellSide outDelta  fee    refund          grid
 *   bfill  sid ruleId side     spend     outRes fee             balancer
 *
 * A grid's third field is a SIDE and a schedule's is an AMOUNT. Read one as the
 * other and you get a fill of 0 or 1 units that renders perfectly. `bfill` is
 * shifted a whole field relative to the rest, so its `fee` lands where the others
 * keep `refund`.
 *
 * LENGTH IS CHECKED, not assumed. A short log is rejected rather than read past its
 * end, because zeros off the end decode as a fill of nothing at a price of nothing
 * — which looks like data rather than an error.
 *
 * EVERY CRANK EVENT APPEARS TWICE. The passport logs it, then relays it to the
 * registry via `emit_event`, which logs `"ev" + passportAppId + payload`. So the
 * registry is a fleet-wide feed of every passport's fills in one place, and a
 * reader that scans both will see each fill twice. Use `unwrapRelay` to spot the
 * envelope, and pick ONE source per view.
 *
 * `xfill` is the odd one: it comes from `swap`, which an OWNER calls directly, so
 * it has no sid, no rule and no keeper fee. It is a fill in the sense a user means
 * and not in the sense the keeper means; `isCrankFill` separates them.
 */
import { RuleType } from './constants.js';
import { readU64 } from './encode.js';

const TXT = new TextDecoder();

/**
 * Field names per tag, in log order, from the contract's own `log(...)` calls.
 *
 * Tag lengths VARY — 3 for `dir`, 7 for `sbudget` — so matching is longest-first
 * below. A table keyed by a fixed-width tag would mis-slice half of these.
 */
export const EVENT_LAYOUT: Readonly<Record<string, readonly string[]>> = {
  // fills from a keeper crank
  sfill: ['sid', 'ruleId', 'spend', 'outDelta', 'fee', 'refund', 'floor'],
  ofill: ['sid', 'ruleId', 'spend', 'outDelta', 'fee', 'refund'],
  gfill: ['sid', 'ruleId', 'cellSide', 'outDelta', 'fee', 'refund'],
  bfill: ['sid', 'ruleId', 'side', 'spend', 'outResult', 'fee'],
  // an owner-initiated swap, not a crank
  xfill: ['assetIn', 'spend', 'assetOut', 'outDelta'],
  // strategy and rule lifecycle
  sput: ['sid', 'stype'],
  sadd: ['sid', 'ruleId'],
  supd: ['sid', 'ruleId'],
  sfund: ['sid', 'ruleId', 'side', 'release', 'amount'],
  srem: ['sid', 'ruleId'],
  scancel: ['sid'],
  sbudget: ['sid', 'amount'],
  // balances and positions. `lock` carries the NEW TOTAL, not the delta, and is
  // logged by both lock and unlock — the amount that moved is not in the event.
  lock: ['asset', 'locked'],
  pset: ['asset', 'kind'],
  pclr: ['asset'],
  // configuration
  dir: ['appId'],
  sync: ['router', 'budget'],
} as const;

/** Which strategy shape produced a crank fill. */
export const FILL_RULE_TYPE: Readonly<Record<string, RuleType>> = {
  sfill: RuleType.Schedule,
  bfill: RuleType.Balancer,
  gfill: RuleType.Grid,
  ofill: RuleType.Limit,
} as const;

export interface DecodedEvent {
  /** The ASCII tag, e.g. `bfill`. */
  tag: string;
  /** Decoded u64 fields by name, in log order. */
  fields: Record<string, bigint>;
  /** Set for the four crank fills; absent for `xfill` and lifecycle events. */
  ruleType?: RuleType;
}

const TAGS = Object.keys(EVENT_LAYOUT).sort((a, b) => b.length - a.length);

/**
 * One log line to a decoded event, or null when it is not one of ours.
 *
 * Returns null rather than throwing: an app's logs also carry ARC-4 return values
 * and anything a future version adds, so "not recognised" is the common case and
 * not an error. It does NOT tolerate a recognised tag with the wrong length — that
 * means this SDK and the contract disagree, which is worth surfacing as a skip
 * rather than as plausible numbers.
 */
export function decodeEvent(bytes: Uint8Array): DecodedEvent | null {
  const tag = TAGS.find(
    (t) => bytes.length > t.length && TXT.decode(bytes.subarray(0, t.length)) === t,
  );
  if (!tag) return null;
  const names = EVENT_LAYOUT[tag] as readonly string[];
  if (bytes.length !== tag.length + names.length * 8) return null;
  const fields: Record<string, bigint> = {};
  names.forEach((name, i) => {
    fields[name] = readU64(bytes, tag.length + i * 8);
  });
  const ruleType = FILL_RULE_TYPE[tag];
  return ruleType === undefined ? { tag, fields } : { tag, fields, ruleType };
}

/**
 * Unwrap the registry's relay envelope: `"ev" + passportAppId + payload`.
 *
 * The registry logs this for every crank event any registered passport relays, so
 * it is the one place to read the whole fleet's history. Returns null for a log
 * that is not an envelope.
 */
export function unwrapRelay(
  bytes: Uint8Array,
): { passport: bigint; payload: Uint8Array } | null {
  if (bytes.length <= 10 || TXT.decode(bytes.subarray(0, 2)) !== 'ev') return null;
  return { passport: readU64(bytes, 2), payload: bytes.subarray(10) };
}

/** True for the four keeper-crank fills. Excludes `xfill`, an owner swap. */
export const isCrankFill = (tag: string): boolean => tag in FILL_RULE_TYPE;

/**
 * Every event in a transaction, including inner transactions and relays.
 *
 * Pass a transaction as algod or the indexer returns it. Inner transactions are
 * walked because a crank's own log sits on the outer call while the relay lands on
 * an inner one — reading only the top level finds the fill and misses that it was
 * relayed, and reading only the registry finds it once per passport with no route
 * back to which call produced it.
 *
 * `passport` is set from the relay envelope when the event came through one, so a
 * fleet-wide read still knows whose fill it was.
 */
export function eventsIn(
  txn: unknown,
): Array<DecodedEvent & { passport?: bigint }> {
  const out: Array<DecodedEvent & { passport?: bigint }> = [];
  const walk = (t: unknown): void => {
    if (!t || typeof t !== 'object') return;
    const node = t as { logs?: unknown[]; innerTxns?: unknown[]; 'inner-txns'?: unknown[] };
    for (const raw of node.logs ?? []) {
      const bytes =
        raw instanceof Uint8Array
          ? raw
          : typeof raw === 'string'
            ? Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
            : null;
      if (!bytes) continue;
      const relay = unwrapRelay(bytes);
      const ev = decodeEvent(relay ? relay.payload : bytes);
      if (ev) out.push(relay ? { ...ev, passport: relay.passport } : ev);
    }
    for (const inner of node.innerTxns ?? node['inner-txns'] ?? []) walk(inner);
  };
  walk(txn);
  return out;
}
