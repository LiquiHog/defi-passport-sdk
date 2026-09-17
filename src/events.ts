/**
 * Decoding the events a passport logs, so a UI can show what actually happened.
 *
 * DECODE PER TAG, NEVER GENERICALLY. The tempting shape is "a fill is a fill" —
 * read a couple of u64s off a known offset — and it misreads most of the six
 * strategy fills, silently and plausibly. Compare field 3:
 *
 *   sfill  sid ruleId spend    outDelta  fee    refund  floor   schedule / DCA
 *   ofill  sid ruleId spend    outDelta  fee    refund          limit
 *   gfill  sid ruleId cellSide outDelta  fee    refund          grid
 *   bfill  sid ruleId side     spend     outRes fee             balancer
 *   pfill  sid ruleId spend    refund    recipient (32 B)        pay        v1.1.2
 *   lfill  sid ruleId op       used      refund                  folks loan v1.1.2
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
import { encodeAddress } from 'algosdk';
import { RuleType } from './constants.js';
import { readU64 } from './encode.js';

const TXT = new TextDecoder();

/**
 * One field of an event: a named u64, or a named 32-byte address.
 *
 * Addresses arrived with v1.1.2 (`pfill` names its recipient, `lopen` its
 * escrow) and they are not u64-shaped, so a layout is no longer just a list of
 * names. Everything that is not an address is eight bytes, big-endian.
 */
export type EventField = string | { readonly addr: string };
export type EventLayout = readonly EventField[];

/**
 * Field layout per tag, in log order, from the contract's own `log(...)` calls.
 *
 * READ FROM THE EMIT SITES, NOT FROM A DESCRIPTION OF THEM. The v1.1.2 brief
 * described `skim` as three u64s (it is six) and `lopen` with its address last
 * (it is in the middle, between two u64s, at the same total length — a decoder
 * built from the brief would parse cleanly and return the wrong fields).
 *
 * A tag may carry more than one layout — `sprofit` logs two u64s when routing is
 * cleared and five when it is set — so a value here is one layout or a list of
 * alternatives, matched by length.
 *
 * Tag lengths VARY — 3 for `dir`, 8 for `srestore` — so matching is longest-first
 * below. A table keyed by a fixed-width tag would mis-slice half of these.
 */
export const EVENT_LAYOUT: Readonly<Record<string, EventLayout | readonly EventLayout[]>> = {
  // fills from a keeper crank
  sfill: ['sid', 'ruleId', 'spend', 'outDelta', 'fee', 'refund', 'floor'],
  ofill: ['sid', 'ruleId', 'spend', 'outDelta', 'fee', 'refund'],
  gfill: ['sid', 'ruleId', 'cellSide', 'outDelta', 'fee', 'refund'],
  bfill: ['sid', 'ruleId', 'side', 'spend', 'outResult', 'fee'],
  // v1.1.2: a recurring payment's fill names who was paid
  pfill: ['sid', 'ruleId', 'spend', 'refund', { addr: 'recipient' }],
  // v1.1.2: a Folks loan operation. `op` is 0 deposit, 1 withdraw, 2 borrow, 3 repay.
  lfill: ['sid', 'ruleId', 'op', 'used', 'refund'],
  // v1.1.2: `verify_fill` settled a fill — issued inside the fill group by the
  // keeper or counterparty, relayed like a fill, but a verification, not one.
  ovfy: ['sid', 'ruleId', 'refund'],
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
  srestore: ['sid'],
  // v1.1.2: profit routing. Cleared logs `destKind` 0 and nothing else; set
  // logs the whole routing. `dest` 1 owner, 2 reserve, 3 gas; `mode` 0 rate, 1 fixed.
  sprofit: [
    ['sid', 'destKind'],
    ['sid', 'destKind', 'mode', 'value', 'destSid'],
  ],
  // v1.1.2: a skim applied on a fill. `sent` is 1 when it left free balance, 0
  // when it was skipped (owner not opted in, reserve asset mismatch).
  skim: ['sid', 'ruleId', 'asset', 'amount', 'dest', 'sent'],
  // v1.1.2: Folks loan lifecycle. The escrow sits BETWEEN the two u64s.
  lopen: ['sid', { addr: 'escrow' }, 'loanApp'],
  lclose: ['sid'],
  // balances and positions. `lock` carries the NEW TOTAL, not the delta, and is
  // logged by both lock and unlock — the amount that moved is not in the event.
  lock: ['asset', 'locked'],
  pset: ['asset', 'kind'],
  pclr: ['asset'],
  // configuration
  dir: ['appId'],
  sync: ['router', 'budget'],
  // v1.1.2: the owner's gas-asset election changed; 0 means cleared
  gasa: ['asset'],
} as const;

/**
 * Which strategy shape produced a crank fill.
 *
 * `ovfy` is deliberately absent: it is relayed alongside fills and comes from the
 * keeper's side of a crank, but it is `verify_fill` settling one, not a fill of
 * any rule type. Treat it as a crank event without treating it as a fill.
 */
export const FILL_RULE_TYPE: Readonly<Record<string, RuleType>> = {
  sfill: RuleType.Schedule,
  bfill: RuleType.Balancer,
  gfill: RuleType.Grid,
  ofill: RuleType.Limit,
  pfill: RuleType.Pay,
  lfill: RuleType.Folks,
} as const;

export interface DecodedEvent {
  /** The ASCII tag, e.g. `bfill`. */
  tag: string;
  /** Decoded u64 fields by name, in log order. */
  fields: Record<string, bigint>;
  /** Address fields by name, base32-encoded. Present only for tags that carry one. */
  addresses?: Record<string, string>;
  /** Set for the six crank fills; absent for `xfill`, `ovfy` and lifecycle events. */
  ruleType?: RuleType;
}

const TAGS = Object.keys(EVENT_LAYOUT).sort((a, b) => b.length - a.length);

const isAddr = (f: EventField): f is { readonly addr: string } => typeof f !== 'string';
const widthOf = (layout: EventLayout): number => layout.reduce((n, f) => n + (isAddr(f) ? 32 : 8), 0);
const alternatives = (v: EventLayout | readonly EventLayout[]): readonly EventLayout[] =>
  v.length > 0 && Array.isArray(v[0]) ? (v as readonly EventLayout[]) : [v as EventLayout];

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
  // Several layouts may share a tag; the payload length picks one, and a length
  // no layout has means this SDK and the contract disagree — a skip, not a guess.
  const layout = alternatives(EVENT_LAYOUT[tag] as EventLayout | readonly EventLayout[]).find(
    (l) => bytes.length === tag.length + widthOf(l),
  );
  if (!layout) return null;
  const fields: Record<string, bigint> = {};
  const addresses: Record<string, string> = {};
  let off = tag.length;
  for (const f of layout) {
    if (isAddr(f)) {
      addresses[f.addr] = encodeAddress(bytes.subarray(off, off + 32));
      off += 32;
    } else {
      fields[f] = readU64(bytes, off);
      off += 8;
    }
  }
  const ruleType = FILL_RULE_TYPE[tag];
  return {
    tag,
    fields,
    ...(Object.keys(addresses).length ? { addresses } : {}),
    ...(ruleType === undefined ? {} : { ruleType }),
  };
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

/** True for the six keeper-crank fills. Excludes `xfill` (an owner swap) and `ovfy`. */
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
