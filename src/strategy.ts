/**
 * Strategies and rules.
 *
 * `cm`+0 is a REQUIRED box reference on every method that commits or releases
 * funds, because each re-checks the ALGO side of the committed ledger — a box
 * costs min-balance, so ALGO is touched even when the asset moving is not ALGO.
 * Reading an unnamed box is a hard error whose message ("invalid Box reference")
 * reads like a permission bug. That is why the reference lists below are built
 * for you and not left to the caller.
 */
import {
  assignGroupID,
  makeApplicationNoOpTxnFromObject,
  type BoxReference,
  type Transaction,
} from 'algosdk';
import { PASSPORT } from './abi.js';
import {
  BOX,
  MAX_REFS_PER_TXN,
  UNLIMITED_REFUND_BUDGET,
  type RuleType,
} from './constants.js';
import { abiBytes, boxName, u64, u64List } from './encode.js';
import { flat } from './create.js';
import type { Group, Num, PassportCtx } from './types.js';
import { arc2 } from './note.js';

const cm = (passport: bigint, asset: Num): BoxReference => ({
  appIndex: passport,
  name: boxName(BOX.committed, asset),
});

/** Distinct, non-zero assets only — `foreignAssets` shares the reference budget. */
const assetRefs = (...assets: Num[]): number[] => [
  ...new Set(assets.map((a) => Number(a)).filter((a) => a !== 0)),
];

function call(
  ctx: PassportCtx,
  // `name` is used for the ARC-2 note, so every app call is labelled with the
  // method that produced it WITHOUT a tag at each of the ~30 call sites — which
  // is the only version of this that stays correct as methods are added.
  method: { name: string; getSelector(): Uint8Array },
  args: Uint8Array[],
  o: {
    boxes?: BoxReference[] | undefined;
    apps?: Num[] | undefined;
    assets?: Num[] | undefined;
    fee?: number | undefined;
    /** Extra ARC-2 note fields, merged over the method label. */
    note?: Record<string, Num | string> | undefined;
  } = {},
): Transaction {
  return makeApplicationNoOpTxnFromObject({
    sender: ctx.owner,
    suggestedParams: flat(ctx.params, o.fee ?? 1000),
    appIndex: BigInt(ctx.passport),
    appArgs: [method.getSelector(), ...args],
    note: arc2(method.name, o.note ?? {}),
    ...(o.boxes ? { boxes: o.boxes } : {}),
    ...(o.apps ? { foreignApps: o.apps.map(Number) } : {}),
    ...(o.assets ? { foreignAssets: o.assets.map(Number) } : {}),
  });
}

/**
 * Open a strategy. Returns the txn; the sid it produces is `order_count + 1` —
 * read it with `read.nextSid` BEFORE building, never from a box scan.
 *
 * `quoteAmount` seeds the strategy's shared quote reserve, and may be 0 (a grid
 * or limit strategy funds its rules individually instead).
 *
 * It reads `fee_bps` off the registry and SNAPSHOTS it, so the registry must be a
 * foreign app here — and a later fee change never touches a live strategy.
 */
export function openStrategy(
  ctx: PassportCtx,
  a: {
    sid: Num;
    type: RuleType;
    quoteAsset: Num;
    quoteAmount: Num;
    /**
     * Lifetime cap on this strategy's gas refunds. Defaults to unlimited, and
     * most callers should leave it that way — see `UNLIMITED_REFUND_BUDGET`.
     *
     * It is NOT a deposit and holds no ALGO. The gas itself is the passport's
     * kind-0 reserve, shared by every strategy, and THAT is the bound that
     * matters. Setting a finite value here caps one strategy's lifetime spend;
     * it does not reserve anything for it, and it cannot protect it from another
     * strategy draining the shared reserve.
     */
    refundBudget?: Num | undefined;
    /** Optional display name. See `strategyName` for what this is and is not. */
    name?: string | undefined;
  },
): Transaction {
  const p = BigInt(ctx.passport);
  return call(
    ctx,
    PASSPORT.open_strategy,
    [u64(a.type), u64(a.quoteAsset), u64(a.quoteAmount),
     u64(a.refundBudget ?? UNLIMITED_REFUND_BUDGET)],
    {
      boxes: [
        { appIndex: p, name: boxName(BOX.strategy, a.sid) },
        cm(p, 0),
        cm(p, a.quoteAsset),
      ],
      apps: [ctx.registry],
      assets: assetRefs(a.quoteAsset),
      ...(a.name === undefined ? {} : { note: { n: strategyName(a.name) } }),
    },
  );
}

/** Longest display name accepted. Notes cap at 1024 bytes and live for ever. */
export const NAME_MAX = 64;

/**
 * Validate a strategy display name for the ARC-2 note.
 *
 * THERE IS NOWHERE ON CHAIN FOR A NAME TO LIVE, and that is not an oversight to
 * be worked around. `open_strategy` takes no name, and the 64-byte strategy
 * header writes all eight of its uint slots, so widening it is a LAYOUT change —
 * a major version, a fresh passport and a hand migration for every user, to carry
 * a label. The note is the right home: the contract never reads a name, so state
 * would be paying min-balance for something only clients consume, and clients
 * already need an indexer for the P&L view.
 *
 * WHAT THIS IS NOT. The note is written by whoever signs, and `ping` and other
 * ungated methods let anyone send a transaction to anyone's passport. So a reader
 * MUST check `sender == owner` before believing a name; nothing on chain does that
 * for you. Sender-checking is unavoidable whatever the carrier — a note on a bare
 * payment has exactly the same property.
 *
 * AND IT IS OPTIONAL FOR EVER. Every strategy created before names existed has
 * none, and so does anything built by a client that does not pass one. A
 * caller-side fallback ("Rebalancer #3") is the permanent floor, not scaffolding
 * to remove once names ship.
 *
 * THROWS rather than truncating. A silently shortened name differs from what the
 * user typed, immutably and without telling them; a build-time error costs
 * nothing because it happens before signing. Control characters are rejected
 * outright — they have no legitimate use in a label and this string is rendered
 * by every client that reads it, possibly having come from a stranger.
 */
export function strategyName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new Error('strategy name is empty after trimming');
  // Count CODE POINTS, not UTF-16 units: `length` counts a non-BMP character
  // (an emoji) as 2, so a byte- or unit-based cap rejects names a user reads as
  // short. The byte check below is what actually protects the note.
  if ([...name].length > NAME_MAX) {
    throw new Error(`strategy name exceeds ${NAME_MAX} characters`);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(name)) {
    throw new Error('strategy name contains control or formatting characters');
  }
  const bytes = new TextEncoder().encode(name).length;
  if (bytes > NAME_MAX * 4) throw new Error('strategy name is too large');
  return name;
}

/**
 * Add a rule. `ruleId` comes from `read.nextRuleId` — the header's own counter.
 *
 * ASSET ORDER: `assetA` is the BASE and `assetB` the QUOTE. For a GRID cell this
 * is easy to invert: a buy-first cell must hold `quoteIn` on the QUOTE side
 * (`committedA = 0`), a sell-first cell holds `baseAmt` on the BASE side
 * (`committedB = 0`). The wrong way round fails on "buy cell must hold quote_in",
 * which reads like underfunding when the amounts are correct and merely swapped.
 */
export function addRule(
  ctx: PassportCtx,
  a: {
    sid: Num;
    ruleId: Num;
    assetA: Num;
    committedA: Num;
    assetB: Num;
    committedB: Num;
    tail: Uint8Array;
  },
): Transaction {
  const p = BigInt(ctx.passport);
  return call(
    ctx,
    PASSPORT.add_rule,
    [
      u64(a.sid),
      u64(a.assetA),
      u64(a.committedA),
      u64(a.assetB),
      u64(a.committedB),
      abiBytes(a.tail),
    ],
    {
      boxes: [
        { appIndex: p, name: boxName(BOX.strategy, a.sid) },
        { appIndex: p, name: boxName(BOX.rule, a.sid, a.ruleId) },
        cm(p, a.assetA),
        cm(p, a.assetB),
        cm(p, 0),
      ],
      assets: assetRefs(a.assetA, a.assetB),
    },
  );
}

/** Rewrite a rule's CONFIG. The runtime window is spliced back in for you. */
export function updateRule(
  ctx: PassportCtx,
  a: { sid: Num; ruleId: Num; assetA: Num; assetB: Num; tail: Uint8Array },
): Transaction {
  const p = BigInt(ctx.passport);
  return call(ctx, PASSPORT.update_rule, [u64(a.sid), u64(a.ruleId), abiBytes(a.tail)], {
    boxes: [
      { appIndex: p, name: boxName(BOX.strategy, a.sid) },
      { appIndex: p, name: boxName(BOX.rule, a.sid, a.ruleId) },
      cm(p, a.assetA),
      cm(p, a.assetB),
      cm(p, 0),
    ],
    assets: assetRefs(a.assetA, a.assetB),
  });
}

/**
 * Move funds into or out of a live rule's committed prelude.
 *
 * DELTA, not absolute, deliberately: a crank can change the prelude between the
 * owner reading it and this landing (a balancer sell lowers `committedA`), so
 * "add 5 more" stays correct under that race where "set it to X" would silently
 * re-commit what the crank just released.
 *
 * `side` 0 = A, 1 = B. `release` 0 = commit free balance, 1 = return to free.
 */
export function fundRule(
  ctx: PassportCtx,
  a: { sid: Num; ruleId: Num; side: 0 | 1; amount: Num; release: 0 | 1; asset: Num },
): Transaction {
  const p = BigInt(ctx.passport);
  return call(
    ctx,
    PASSPORT.fund_rule,
    [u64(a.sid), u64(a.ruleId), u64(a.side), u64(a.amount), u64(a.release)],
    {
      boxes: [
        { appIndex: p, name: boxName(BOX.strategy, a.sid) },
        { appIndex: p, name: boxName(BOX.rule, a.sid, a.ruleId) },
        cm(p, a.asset),
        cm(p, 0),
      ],
      assets: assetRefs(a.asset),
    },
  );
}

export function removeRule(
  ctx: PassportCtx,
  a: { sid: Num; ruleId: Num; assetA: Num; assetB: Num },
): Transaction {
  const p = BigInt(ctx.passport);
  return call(ctx, PASSPORT.remove_rule, [u64(a.sid), u64(a.ruleId)], {
    boxes: [
      { appIndex: p, name: boxName(BOX.strategy, a.sid) },
      { appIndex: p, name: boxName(BOX.rule, a.sid, a.ruleId) },
      cm(p, a.assetA),
      cm(p, a.assetB),
      cm(p, 0),
    ],
    assets: assetRefs(a.assetA, a.assetB),
  });
}

/** The strategy's shared quote reserve. Amount must be > 0. */
export function addReserve(ctx: PassportCtx, a: { sid: Num; amount: Num; quoteAsset: Num }) {
  const p = BigInt(ctx.passport);
  return call(ctx, PASSPORT.add_reserve, [u64(a.sid), u64(a.amount)], {
    boxes: [{ appIndex: p, name: boxName(BOX.strategy, a.sid) }, cm(p, a.quoteAsset), cm(p, 0)],
    assets: assetRefs(a.quoteAsset),
  });
}

export function removeReserve(ctx: PassportCtx, a: { sid: Num; amount: Num; quoteAsset: Num }) {
  const p = BigInt(ctx.passport);
  return call(ctx, PASSPORT.remove_reserve, [u64(a.sid), u64(a.amount)], {
    boxes: [{ appIndex: p, name: boxName(BOX.strategy, a.sid) }, cm(p, a.quoteAsset), cm(p, 0)],
    assets: assetRefs(a.quoteAsset),
  });
}

/** Absolute, because it is a ceiling the owner states, not a balance moving. */
export function setRefundBudget(ctx: PassportCtx, a: { sid: Num; amount: Num }): Transaction {
  return call(ctx, PASSPORT.set_refund_budget, [u64(a.sid), u64(a.amount)], {
    boxes: [{ appIndex: BigInt(ctx.passport), name: boxName(BOX.strategy, a.sid) }],
  });
}

/**
 * Close a strategy and release everything it holds. `ruleIds` must list EVERY
 * live rule exactly once.
 *
 * A busy strategy exceeds `MAX_REFS_PER_TXN` on its own — boxes and foreign
 * assets share the budget of 8 — so the overflow rides on `ping` transactions.
 * References are shared group-wide, which is what makes that legal.
 */
export function closeStrategyGroup(
  ctx: PassportCtx,
  a: { sid: Num; ruleIds: Num[]; assets: Num[] },
): Group {
  const p = BigInt(ctx.passport);
  const refs: BoxReference[] = [
    { appIndex: p, name: boxName(BOX.strategy, a.sid) },
    ...a.ruleIds.map((r) => ({ appIndex: p, name: boxName(BOX.rule, a.sid, r) })),
    ...[...new Set([0, ...a.assets.map(Number)])].map((x) => cm(p, x)),
  ];
  const fassets = assetRefs(...a.assets);
  const head = Math.max(1, MAX_REFS_PER_TXN - fassets.length);

  const txns: Transaction[] = [
    call(ctx, PASSPORT.close_strategy, [u64(a.sid), abiBytes(u64List(a.ruleIds))], {
      boxes: refs.slice(0, head),
      assets: fassets,
      fee: 2000,
    }),
  ];
  for (let i = head; i < refs.length; i += MAX_REFS_PER_TXN) {
    txns.push(
      call(ctx, PASSPORT.ping, [], { boxes: refs.slice(i, i + MAX_REFS_PER_TXN), fee: 0 }),
    );
  }
  return txns.length > 1 ? assignGroupID(txns) : txns;
}
