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
import { abiBytes, boxName, payTail, u64, u64List } from './encode.js';
import { flat } from './create.js';
import { padBoxes } from './pages.js';
import { MAX_PROGRAM_OVERFLOW } from './programs.js';
import type { Group, Num, PassportCtx, PayRuleSpec, ProfitSpec } from './types.js';
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
    /**
     * False for a member of a group that budgets its references as a whole —
     * padding each member separately could push one past the slot limit, and
     * a group with three or more real boxes needs nothing added anyway.
     */
    pad?: boolean | undefined;
  } = {},
): Transaction {
  const boxes = o.pad === false ? (o.boxes ?? []) : padBoxes(o.boxes ?? [], MAX_PROGRAM_OVERFLOW);
  return makeApplicationNoOpTxnFromObject({
    sender: ctx.owner,
    suggestedParams: flat(ctx.params, o.fee ?? 1000),
    appIndex: BigInt(ctx.passport),
    appArgs: [method.getSelector(), ...args],
    note: arc2(method.name, o.note ?? {}),
    ...(boxes.length ? { boxes } : {}),
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

const PROFIT_KIND = { none: 0, owner: 1, reserve: 2, gas: 3 } as const;
const PROFIT_MODE = { rate: 0, fixed: 1 } as const;

/**
 * Route a slice of every fill's proceeds somewhere other than free balance.
 * Owner-set, keeper-read: the keeper can change neither the rate nor the
 * destination, and a skim never exceeds a fill's net proceeds.
 *
 * Destinations: the OWNER (skipped, never reverted, if the owner is not opted
 * in to the asset); another strategy's quote pool (RESERVE — "profits repay
 * the loan"); or the ALGO gas lock (GAS — "the passport pays for itself"; a
 * non-ALGO skim stays free instead). `none` deletes the routing.
 *
 * THE BOXES ARE THE POINT OF THIS BUILDER. The contract reads the strategy
 * header and the `sp` box on every call; on a set it also re-checks free ALGO
 * through `cm`+0; and for RESERVE it reads the receiving header and pre-creates
 * that strategy's quote-asset ledger box on the owner's signature, so that a
 * crank is never the thing that raises minimum balance. Every one of those has
 * to be named at signing time, and the last one cannot be derived here — hence
 * `destQuoteAsset`, from `read.strategy(destSid).quoteAsset`.
 *
 * Validation mirrors the contract's own asserts so a bad value fails here with
 * a message instead of on chain as a bare pc. NEW IN v1.1.2.
 */
export function setProfit(ctx: PassportCtx, a: { sid: Num } & ProfitSpec): Transaction {
  const p = BigInt(ctx.passport);
  const own: BoxReference[] = [
    { appIndex: p, name: boxName(BOX.strategy, a.sid) },
    { appIndex: p, name: boxName(BOX.profit, a.sid) },
  ];
  if (a.kind === 'none') {
    return call(ctx, PASSPORT.set_profit, [u64(a.sid), u64(0), u64(0), u64(0), u64(0)], {
      boxes: own,
      note: { sid: a.sid, dest: 0 },
    });
  }
  const value = BigInt(a.value);
  if (value <= 0n) throw new RangeError('skim value must be positive');
  if (a.mode === 'rate' && value > 10_000n) {
    throw new RangeError(`a rate is basis points of net proceeds, so at most 10000 (got ${value})`);
  }
  const boxes: BoxReference[] = [...own, cm(p, 0)];
  let destSid = 0n;
  if (a.kind === 'reserve') {
    destSid = BigInt(a.destSid);
    if (destSid === BigInt(a.sid)) throw new RangeError('a strategy cannot reserve into itself');
    boxes.push({ appIndex: p, name: boxName(BOX.strategy, destSid) }, cm(p, a.destQuoteAsset));
  }
  return call(
    ctx,
    PASSPORT.set_profit,
    [u64(a.sid), u64(PROFIT_MODE[a.mode]), u64(value), u64(PROFIT_KIND[a.kind]), u64(destSid)],
    { boxes, note: { sid: a.sid, dest: PROFIT_KIND[a.kind] } },
  );
}

/**
 * Add a recurring payment to a `Pay` strategy. NEW IN v1.1.2.
 *
 * ONE ASSET. The payment leaves in `asset`, and the contract insists both
 * prelude assets name it (`assetB == assetA`, `committedB == 0`) so the prelude
 * commits exactly the budget and nothing else — the proven shape for ALGO is
 * `(0, budget, 0, 0)` and for an ASA `(asa, budget, asa, 0)`. The strategy
 * itself is opened with quote asset 0 and no quote amount.
 *
 * Each payment is `batch` or the remainder of the budget, whichever is smaller;
 * the rule deletes itself at zero budget or at `maxPayments`. A recipient who
 * has not opted in to an ASA fails LOUDLY at crank time rather than being
 * skipped — refuse to offer such a rule if you can check.
 */
export function payRule(ctx: PassportCtx, s: PayRuleSpec): Transaction {
  if (BigInt(s.budget) <= 0n) throw new RangeError('budget must be positive');
  return addRule(ctx, {
    sid: s.sid,
    ruleId: s.ruleId,
    assetA: s.asset,
    committedA: s.budget,
    assetB: s.asset,
    committedB: 0,
    tail: payTail({
      batch: s.batch,
      ...(s.interval !== undefined ? { interval: s.interval } : {}),
      recipient: s.recipient,
      ...(s.maxPayments !== undefined ? { maxPayments: s.maxPayments } : {}),
      passport: ctx.passport,
    }),
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
    // The profit-routing box. Read on close from v1.1.2, so it must be named
    // even where it does not exist — a reference to an absent box is legal, a
    // missing reference to a present one is "invalid Box reference".
    { appIndex: p, name: boxName(BOX.profit, a.sid) },
    // Also from v1.1.2: close checks that no Folks loan is still bound to the
    // strategy, by box length. That is a box read whether or not the loan
    // exists, so the reference is required even for a strategy that never had
    // one. Read from the contract source, not the brief — the brief named only sp.
    { appIndex: p, name: boxName(BOX.loan, a.sid) },
    ...a.ruleIds.map((r) => ({ appIndex: p, name: boxName(BOX.rule, a.sid, r) })),
    ...[...new Set([0, ...a.assets.map(Number)])].map((x) => cm(p, x)),
  ];
  // Four real boxes at minimum (strategy, profit, loan, cm+0), which meets the
  // read budget of any build this SDK bundles on its own. Members therefore do not
  // pad themselves: the head is sized to the slot limit and cannot take more.
  const fassets = assetRefs(...a.assets);
  const head = Math.max(1, MAX_REFS_PER_TXN - fassets.length);

  const txns: Transaction[] = [
    call(ctx, PASSPORT.close_strategy, [u64(a.sid), abiBytes(u64List(a.ruleIds))], {
      boxes: refs.slice(0, head),
      assets: fassets,
      fee: 2000,
      pad: false,
    }),
  ];
  for (let i = head; i < refs.length; i += MAX_REFS_PER_TXN) {
    txns.push(
      call(ctx, PASSPORT.ping, [], {
        boxes: refs.slice(i, i + MAX_REFS_PER_TXN),
        fee: 0,
        pad: false,
      }),
    );
  }
  return txns.length > 1 ? assignGroupID(txns) : txns;
}
