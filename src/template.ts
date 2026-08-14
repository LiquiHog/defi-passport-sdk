/**
 * Rule-tail layouts in one place, and strategy templates built on top of them.
 *
 * WHY THIS FILE EXISTS AT ALL. Tail offsets are described in the contract as prose,
 * and re-deriving them by hand at each reader is a reliable source of bugs: a
 * length guard that still expects the old size parses one field short and silently
 * reads the rest at the wrong offset. Offsets copied from prose drift; offsets in
 * a table the builders are checked against cannot.
 *
 * THE THREE-WAY SPLIT IS THE POINT. The contract already separates CONFIG from
 * RUNTIME, because `update_rule` rewrites config and splices the runtime window
 * back byte-for-byte — that is what lets an owner re-price a live rule without
 * rewinding an interval gate or forging a fill count. A template needs a SECOND
 * cut inside config that the contract has no reason to make:
 *
 *   RUNTIME      the crank owns it. Never in a template.
 *   DENOMINATED  config, but meaningful only for ONE asset pair and size:
 *                amounts, price ratios, absolute value floors, asset ids.
 *   PORTABLE     config that is scale-free: basis points, intervals, flags.
 *
 * "NOT PER ASSET" IS NOT THE SAME LINE, and this is the trap the whole file is
 * arranged around. `sellFloor` is not an asset id — it is an absolute position
 * value in quote units. `buyNum/buyDen` are not asset ids — they are a price
 * ratio for one pair. Carried into a different pair they are not merely wrong,
 * they are wrong in the direction that widens what a keeper may skim, which is
 * the exact hazard the mandatory bounds exist to close.
 *
 * SO `applyTemplate` REFUSES TO CARRY THEM, structurally: the denominated fields
 * are a REQUIRED argument, so a stale price cannot be inherited by omission. The
 * type checker rejects the unsafe copy before it is written, rather than a comment
 * asking the caller not to write it.
 *
 * WHAT THE CONTRACT ALREADY GUARANTEES, so this layer does not have to: a copied
 * rule fails CLOSED. `_validate` refuses a balancer with either price bound
 * missing, and refuses any rule whose `boundsExpire` is not in the future — so a
 * naively duplicated tail carrying last month's numbers is rejected at creation
 * rather than going live and quietly never filling. The residual risk is a bound
 * that is stale but still in future and slack, which is why templates carry a
 * DURATION and re-derive the timestamp.
 */
import { RuleType } from './constants.js';
import { balTail, gridTail, limitTail, schedTail } from './encode.js';
import type { AnchorSpec, Num } from './types.js';

/** How one uint64 field in a tail is classified. */
export type FieldKind =
  /** The crank owns it; `update_rule` restores it byte-for-byte. */
  | 'runtime'
  /** Scale-free config: safe to carry to another pair or size. */
  | 'portable'
  /** Config denominated in a specific asset, price or size. */
  | 'denominated'
  /** An absolute unix timestamp. A template stores a duration instead. */
  | 'deadline'
  /** Derived from another field (an array length). Never carried. */
  | 'structural'
  /** Present in the layout but required to be 0 by `_validate`. */
  | 'reserved';

export interface TailField {
  readonly name: string;
  readonly offset: number;
  readonly kind: FieldKind;
}

export interface TailLayout {
  readonly type: RuleType;
  /** Fixed length in bytes, excluding any variable-length anchor array. */
  readonly length: number;
  /** `[offset, length)` of the contiguous runtime window. */
  readonly runtime: readonly [number, number];
  readonly fields: readonly TailField[];
  /** Bytes of variable-length tail per anchor, 0 if the type has none. */
  readonly anchorStride: number;
}

const F = (name: string, offset: number, kind: FieldKind): TailField => ({
  name,
  offset,
  kind,
});

/**
 * The layouts, mirroring the contract's CONFIG | RUNTIME block.
 *
 * A GRID HAS NO PORTABLE CONFIG AT ALL, which is worth stating rather than
 * leaving as an empty list to be read as an oversight. `side` is the runtime
 * window and the other three fields are amounts, so a grid's entire shape is
 * denominated. A grid "template" can only be the RATIOS between those amounts
 * plus a size, which is a derivation the caller does — not a copy.
 */
export const RULE_LAYOUT: Readonly<Record<RuleType, TailLayout>> = {
  [RuleType.Schedule]: {
    type: RuleType.Schedule,
    length: 64,
    runtime: [32, 16],
    anchorStride: 24,
    fields: [
      F('batch', 0, 'denominated'),
      F('tolBps', 8, 'portable'),
      F('staticFloor', 16, 'denominated'),
      F('interval', 24, 'portable'),
      F('lastTs', 32, 'runtime'),
      F('collected', 40, 'runtime'),
      F('nAnchors', 48, 'structural'),
      F('maxReceived', 56, 'denominated'),
    ],
  },
  [RuleType.Balancer]: {
    type: RuleType.Balancer,
    length: 112,
    runtime: [32, 8],
    anchorStride: 24,
    fields: [
      F('target', 0, 'denominated'),
      F('bandBps', 8, 'portable'),
      // NOT a price. An absolute position-value floor in quote units, so it is
      // denominated for the same reason `target` is.
      F('sellFloor', 16, 'denominated'),
      F('interval', 24, 'portable'),
      F('lastTs', 32, 'runtime'),
      F('buyNum', 40, 'denominated'),
      F('buyDen', 48, 'denominated'),
      F('virtAsset', 56, 'denominated'),
      F('virtLeg', 64, 'denominated'),
      F('sellNum', 72, 'denominated'),
      F('sellDen', 80, 'denominated'),
      F('tolBps', 88, 'reserved'),
      F('nAnchors', 96, 'reserved'),
      F('boundsExpire', 104, 'deadline'),
    ],
  },
  [RuleType.Grid]: {
    type: RuleType.Grid,
    length: 32,
    runtime: [0, 8],
    anchorStride: 0,
    fields: [
      F('side', 0, 'runtime'),
      F('quoteIn', 8, 'denominated'),
      F('baseAmt', 16, 'denominated'),
      F('quoteOut', 24, 'denominated'),
    ],
  },
  [RuleType.Limit]: {
    type: RuleType.Limit,
    length: 56,
    runtime: [16, 16],
    anchorStride: 0,
    fields: [
      F('amountIn', 0, 'denominated'),
      F('targetOut', 8, 'denominated'),
      F('filledIn', 16, 'runtime'),
      F('collected', 24, 'runtime'),
      F('flags', 32, 'portable'),
      F('minFill', 40, 'denominated'),
      F('expiresTs', 48, 'deadline'),
    ],
  },
};

function layoutOf(type: RuleType): TailLayout {
  const l = RULE_LAYOUT[type];
  if (!l) throw new Error(`unknown rule type ${type}`);
  return l;
}

function readU64(tail: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(tail[offset + i] ?? 0);
  return v;
}

/**
 * Every field of a raw tail, by name, with its classification.
 *
 * REJECTS A SHORT TAIL rather than reading zeros off the end. A check that only
 * asserts a minimum length keeps passing after a tail grows, and every field past
 * the old end reads back as 0 — so a fully configured rule appears unconfigured,
 * with nothing anywhere reporting a problem. Failing on the length is the only
 * version of this that cannot quietly mislead you.
 */
export function readTail(
  type: RuleType,
  tail: Uint8Array,
): { fields: Record<string, bigint>; kinds: Record<string, FieldKind>; anchors: bigint[][] } {
  const l = layoutOf(type);
  if (tail.length < l.length) {
    throw new Error(
      `tail for type ${type} is ${tail.length} bytes, layout needs ${l.length}`,
    );
  }
  const fields: Record<string, bigint> = {};
  const kinds: Record<string, FieldKind> = {};
  for (const f of l.fields) {
    fields[f.name] = readU64(tail, f.offset);
    kinds[f.name] = f.kind;
  }
  const anchors: bigint[][] = [];
  if (l.anchorStride > 0) {
    const extra = tail.length - l.length;
    if (extra % l.anchorStride !== 0) {
      throw new Error(
        `tail has ${extra} trailing bytes, not a multiple of ${l.anchorStride}`,
      );
    }
    for (let o = l.length; o < tail.length; o += l.anchorStride) {
      anchors.push([readU64(tail, o), readU64(tail, o + 8), readU64(tail, o + 16)]);
    }
  }
  return { fields, kinds, anchors };
}

/** `[offset, length)` of the runtime window — the bytes `update_rule` restores. */
export function runtimeWindow(type: RuleType): readonly [number, number] {
  return layoutOf(type).runtime;
}

/**
 * A saved strategy shape: the scale-free settings and nothing else.
 *
 * `deadlines` holds DURATIONS in seconds, not timestamps. A template that stored
 * `boundsExpire` as an absolute time would be stale the moment it was saved, and
 * `_validate` would refuse any rule built from it — correctly, but confusingly,
 * since the failure would name the bounds and not the template.
 */
export interface StrategyTemplate {
  readonly type: RuleType;
  /** Scale-free config, by field name. */
  readonly portable: Readonly<Record<string, bigint>>;
  /** Deadline fields as durations in seconds, by field name. */
  readonly deadlines: Readonly<Record<string, bigint>>;
  /** Names of fields deliberately NOT carried, so a UI can say what it dropped. */
  readonly dropped: readonly string[];
}

/**
 * Derive a template from a live rule's tail.
 *
 * Works on ANY passport's rule, including someone else's: passport boxes are
 * publicly readable, so copying a stranger's settings needs no cooperation and no
 * contract change. What it does NOT copy is everything that made those settings
 * fit their position.
 *
 * `now` is the reference for turning a deadline into a duration. Pass CHAIN time,
 * not wall clock — `Global.latest_timestamp` is the previous block's stamp and has
 * been observed ~37s behind local time, and a duration derived against the wrong
 * clock is wrong by that much for ever.
 */
export function templateFrom(
  type: RuleType,
  tail: Uint8Array,
  now: Num,
): StrategyTemplate {
  const { fields, kinds } = readTail(type, tail);
  const portable: Record<string, bigint> = {};
  const deadlines: Record<string, bigint> = {};
  const dropped: string[] = [];
  const ref = BigInt(now);
  for (const [name, value] of Object.entries(fields)) {
    switch (kinds[name]) {
      case 'portable':
        portable[name] = value;
        break;
      case 'deadline':
        // A deadline already in the past yields 0, not a negative duration.
        deadlines[name] = value > ref ? value - ref : 0n;
        break;
      default:
        dropped.push(name);
    }
  }
  return { type, portable, deadlines, dropped };
}

const num = (t: Readonly<Record<string, bigint>>, k: string, fallback: bigint): bigint =>
  t[k] ?? fallback;

/**
 * Instantiate a template against a fresh position, producing a rule tail.
 *
 * THE DENOMINATED ARGUMENT IS REQUIRED, and that is the whole safety property.
 * Prices, amounts and value floors have to be supplied for THIS pair at THIS
 * size, so the type checker refuses a copy that inherits them — you cannot
 * forget, because omitting the argument does not compile. Derive the price bounds
 * with `buyCeiling()` and `sellFloorRatio()` from a live quote, exactly as a
 * first-time rule would.
 *
 * `now` becomes the base for deadline fields. Pass chain time.
 */
export function applyTemplate(
  t: StrategyTemplate,
  now: Num,
  fresh: {
    schedule?: { batch: Num; staticFloor: Num; maxReceived?: Num; anchors?: AnchorSpec[] };
    balancer?: {
      target: Num;
      buyNum: Num;
      buyDen: Num;
      sellNum: Num;
      sellDen: Num;
      sellFloor?: Num;
      virtAsset?: Num;
      virtLeg?: Num;
    };
    grid?: { side: 0 | 1; quoteIn: Num; baseAmt: Num; quoteOut: Num };
    limit?: { amountIn: Num; targetOut: Num; minFill?: Num };
  },
): Uint8Array {
  const ref = BigInt(now);
  // ZERO MEANS LAPSED, NOT PRESENT, and `??` disagrees — it only falls back on
  // null/undefined, so a template saved from a rule whose bounds had already
  // expired produced `ref + 0n`, i.e. EXACTLY now. `_validate` requires the
  // expiry to be strictly in the future, so that rule could never be created and
  // the error would name the bounds rather than the template it came from.
  //
  // The limit branch below deliberately does the OPPOSITE and keeps a 0, because
  // for `expiresTs` zero is a legitimate value meaning "no expiry". Same literal,
  // opposite meaning, because one field is mandatory and the other optional.
  const deadline = (k: string, fallbackSeconds: bigint): bigint => {
    const d = t.deadlines[k];
    return ref + (d !== undefined && d > 0n ? d : fallbackSeconds);
  };

  switch (t.type) {
    case RuleType.Schedule: {
      const f = fresh.schedule;
      if (!f) throw new Error('applyTemplate: `schedule` values are required');
      return schedTail({
        batch: f.batch,
        staticFloor: f.staticFloor,
        maxReceived: f.maxReceived ?? 0,
        interval: num(t.portable, 'interval', 60n),
        tolBps: num(t.portable, 'tolBps', 0n),
        ...(f.anchors ? { anchors: f.anchors } : {}),
      });
    }
    case RuleType.Balancer: {
      const f = fresh.balancer;
      if (!f) throw new Error('applyTemplate: `balancer` values are required');
      return balTail({
        target: f.target,
        bandBps: num(t.portable, 'bandBps', 0n),
        interval: num(t.portable, 'interval', 60n),
        sellFloor: f.sellFloor ?? 0,
        buyNum: f.buyNum,
        buyDen: f.buyDen,
        sellNum: f.sellNum,
        sellDen: f.sellDen,
        // A 7-day default matches `boundsExpiry()`; a template saved from a rule
        // whose bounds had already lapsed carries 0, and 0 would be REFUSED as
        // not-in-the-future, so fall back rather than build a rule that cannot
        // be created.
        boundsExpire: deadline('boundsExpire', 7n * 86_400n),
        virtAsset: f.virtAsset ?? 0,
        virtLeg: f.virtLeg ?? 0,
      });
    }
    case RuleType.Grid: {
      const f = fresh.grid;
      if (!f) throw new Error('applyTemplate: `grid` values are required');
      // Nothing portable to merge — see RULE_LAYOUT's note on the grid.
      return gridTail(f);
    }
    case RuleType.Limit: {
      const f = fresh.limit;
      if (!f) throw new Error('applyTemplate: `limit` values are required');
      const expires = t.deadlines['expiresTs'];
      return limitTail({
        amountIn: f.amountIn,
        targetOut: f.targetOut,
        minFill: f.minFill ?? 0,
        partial: num(t.portable, 'flags', 0n) !== 0n,
        // 0 means "no expiry" for a limit rule, so an absent or lapsed duration
        // must stay 0 rather than becoming `now`.
        expiresTs: expires !== undefined && expires > 0n ? ref + expires : 0,
      });
    }
    default:
      throw new Error(`applyTemplate: unknown rule type ${t.type}`);
  }
}

/**
 * Assert the layout table agrees with what the tail builders emit.
 *
 * A layout table is only worth having if it cannot drift from the code, and the
 * two are edited for different reasons — a tail grows because the contract gained
 * a field, the table changes because someone is reading it. `balTail`'s own
 * docstring said "104 bytes" while emitting 112 for exactly this reason. Call this
 * from a test; it takes no arguments and touches no network.
 */
export function checkLayouts(): void {
  const built: Array<[RuleType, Uint8Array]> = [
    [RuleType.Schedule, schedTail({ batch: 1, staticFloor: 1 })],
    [
      RuleType.Balancer,
      balTail({
        target: 1,
        bandBps: 1,
        buyNum: 1,
        buyDen: 1,
        sellNum: 1,
        sellDen: 1,
        boundsExpire: 1,
      }),
    ],
    [RuleType.Grid, gridTail({ side: 0, quoteIn: 1, baseAmt: 1, quoteOut: 1 })],
    [RuleType.Limit, limitTail({ amountIn: 1, targetOut: 1 })],
  ];
  for (const [type, tail] of built) {
    const l = layoutOf(type);
    if (tail.length !== l.length) {
      throw new Error(
        `layout for type ${type} says ${l.length} bytes, builder emits ${tail.length}`,
      );
    }
    const last = l.fields[l.fields.length - 1];
    if (!last || last.offset + 8 !== l.length) {
      throw new Error(`layout for type ${type} does not cover its final 8 bytes`);
    }
    l.fields.forEach((f, i) => {
      if (f.offset !== i * 8) {
        throw new Error(`layout for type ${type}: ${f.name} is not at ${i * 8}`);
      }
    });
    // The runtime window must be CONTIGUOUS and made only of runtime fields —
    // the one constraint the contract states a layout has to satisfy, and
    // the thing `update_rule`'s splice depends on.
    const [ro, rl] = l.runtime;
    for (const f of l.fields) {
      const inside = f.offset >= ro && f.offset < ro + rl;
      if (inside !== (f.kind === 'runtime')) {
        throw new Error(
          `layout for type ${type}: ${f.name} is ${inside ? 'inside' : 'outside'}` +
            ` the runtime window but classified '${f.kind}'`,
        );
      }
    }
  }
}
