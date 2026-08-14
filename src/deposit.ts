/**
 * Getting value IN. The SDK had `withdraw` and no deposit, because a deposit
 * needs no application call at all — it is a plain transfer to the passport's
 * address — so there was nothing to build. That is exactly why it is worth
 * building: the parts that are easy to get wrong are the opt-in ordering, the MBR,
 * and the fact that a bare transfer leaves no on-chain record of intent.
 *
 * LP TOKENS ARE JUST ASAs, so `depositAsset` already covers getting them in. What
 * `depositLpToken` adds is the two calls that make the passport UNDERSTAND them:
 * `lock` creates the position, and `setPosition(kind 2)` attaches the reserve legs
 * a balancer rule needs to value the LP without selling it.
 *
 * Liquidity MANAGEMENT — minting and redeeming LP from inside the passport — is
 * not here and needs contract work (two-sided mint is the one case the drain guard
 * does not already cover). This module is the half that does not: a user can hold
 * and account for LP now, and the management functions land on top later without
 * changing how it got in.
 */
import {
  assignGroupID,
  getApplicationAddress,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  makePaymentTxnWithSuggestedParamsFromObject,
  type Transaction,
} from 'algosdk';
import { arc2 } from './note.js';
import { lock, optIn, setPosition, legs as legsBytes } from './manage.js';
import { lpDepositNote, lpLegsFromSnapshot, type LpSnapshot } from './lp.js';
import type { Group, Num, PassportCtx } from './types.js';

/**
 * Group anything that is more than one transaction, and leave a single one alone.
 *
 * A MULTI-TRANSACTION RETURN FROM THIS MODULE IS ALWAYS ATOMIC. Every one of them
 * documents an order that has to hold — the opt-in before the transfer, the deposit
 * before the lock — and ungrouped transactions carry no such promise: the node may
 * accept one and reject another, so the transfer can land against a passport with
 * no slot for the asset, or the lock against funds that never arrived.
 *
 * `create.ts`, `teardown.ts` and `strategy.ts` already grouped what they returned,
 * so leaving these ungrouped was an inconsistency rather than a decision, and one
 * that only shows up on a first-time asset deposit.
 *
 * DO NOT `assignGroupID` THE RESULT AGAIN. The id is a hash over the group, so
 * re-assigning yields a different one and the node rejects the lot as an incomplete
 * group.
 */
const grouped = (txns: Transaction[]): Group =>
  txns.length > 1 ? assignGroupID(txns) : txns;

/**
 * Min-balance a deposit costs the PASSPORT, by the box it creates.
 *
 * Every one is `2500 + 400 * (name + value)`, and the value lengths come from the
 * contract, not from a guess:
 *
 *   position  `p`+asset   name 1+8=9,  value 104  ->  47,700
 *   committed `cm`+asset  name 2+8=10, value 8    ->   9,700
 *
 * POSITION_BOX_MBR read 26,100 until a front end measured a real LP deposit at
 * 157,400 and found the shortfall. That figure implies a name+value of 59 bytes,
 * which matches no box this contract has ever written.
 */
export const ASSET_OPTIN_MBR = 100_000;
export const POSITION_BOX_MBR = 47_700;
export const COMMITTED_BOX_MBR = 9_700;

/**
 * ALGO in. A bare payment — the passport needs no call and no opt-in.
 *
 * NOT counted as committed: it lands in FREE balance, which is what funds strategy
 * quote pools, keeper gas refunds and box min-balance. Size a first deposit off
 * `freeBalance()`, never off the raw balance: a freshly created passport sits
 * exactly at min-balance and its free balance is zero.
 */
export function depositAlgo(ctx: PassportCtx, amount: Num): Transaction {
  return makePaymentTxnWithSuggestedParamsFromObject({
    sender: ctx.owner,
    receiver: getApplicationAddress(BigInt(ctx.passport)).toString(),
    amount: BigInt(amount),
    suggestedParams: ctx.params,
    // The ONLY record that this payment was a deposit. An app call identifies
    // itself; a payment to an app address does not.
    note: arc2('deposit', { p: ctx.passport, a: 0 }),
  });
}

/**
 * An ASA in, including LP tokens.
 *
 * THE PASSPORT MUST BE OPTED IN FIRST or the transfer fails — an Algorand account
 * cannot receive an asset it does not hold a slot for. `optIn` costs the passport
 * 100_000 uALGO of min-balance, so it needs free ALGO before this will work;
 * `depositAlgo` first on a new passport.
 *
 * Pass `withOptIn: true` to group the opt-in ahead of the transfer. Group order
 * matters and cannot be otherwise: the opt-in must land before the asset arrives.
 */
export function depositAsset(
  ctx: PassportCtx,
  a: { asset: Num; amount: Num; withOptIn?: boolean },
): Group {
  const xfer = makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: ctx.owner,
    receiver: getApplicationAddress(BigInt(ctx.passport)).toString(),
    assetIndex: Number(a.asset),
    amount: BigInt(a.amount),
    suggestedParams: ctx.params,
    note: arc2('deposit', { p: ctx.passport, a: a.asset }),
  });
  return grouped(a.withOptIn ? [optIn(ctx, a.asset), xfer] : [xfer]);
}

/**
 * Deposit an LP token AND register it as a valued position, recording the entry
 * basis so PnL can be shown later.
 *
 * TAKES A SNAPSHOT, does not read the chain. Every builder in this SDK is pure —
 * a wallet or backend owns I/O — and separating the read has a second benefit: a
 * UI can show the user "these units are a claim on A of X and B of Y" from the
 * same snapshot it is about to commit to, rather than describing one state and
 * signing another. Call `readStammTier()` first.
 *
 * Four transactions, in this order and for these reasons:
 *
 *   1. `optIn`      — the passport cannot receive the ASA without a slot.
 *   2. transfer     — the LP units move, carrying the BASIS in its note. This is
 *                     the only record of what they were worth going in; the
 *                     contract cannot attest it (kind 2 has no live valuation).
 *   3. `lock`       — reserves them from withdrawal and from being spent by a
 *                     strategy, and CREATES the position box. `setPosition`
 *                     fails with "no such position" without it, and `lock` is
 *                     the only method that creates one.
 *   4. `setPosition` — kind 2 = LP, legs DERIVED FROM THE SNAPSHOT's real
 *                     reserves, which is what lets a balancer rule count this
 *                     holding through a virtual leg without selling it.
 *
 * The leg rates are a CAP the contract takes `min()` against, never an authority
 * — but understating one makes a balancer read the position as worth less than it
 * is and over-buy the other side, so they come from the pool and not from a
 * caller's guess.
 */
export function depositLpToken(
  ctx: PassportCtx,
  a: {
    snapshot: LpSnapshot;
    units: Num;
    /** Defaults to the whole deposit. Lock less to leave some spendable. */
    lockAmount?: Num;
    /** Live valuation for kind 2 is not implemented; 0 is the honest value. */
    oracleApp?: Num;
    skipOptIn?: boolean;
  },
): Group {
  const s = a.snapshot;
  const { legA, legB } = lpLegsFromSnapshot(s);
  const g: Group = [];
  if (!a.skipOptIn) g.push(optIn(ctx, s.lpAsset));
  g.push(
    makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: ctx.owner,
      receiver: getApplicationAddress(BigInt(ctx.passport)).toString(),
      assetIndex: Number(s.lpAsset),
      amount: BigInt(a.units),
      suggestedParams: ctx.params,
      note: lpDepositNote(s, { passport: ctx.passport, units: a.units }),
    }),
  );
  g.push(lock(ctx, { asset: s.lpAsset, amount: a.lockAmount ?? a.units }));
  g.push(
    setPosition(ctx, {
      asset: s.lpAsset,
      kind: 2, // LP token
      subKind: 0,
      oracleApp: a.oracleApp ?? 0,
      refApp: s.poolApp,
      refId: 0,
      legs: legsBytes(legA, legB),
    }),
  );
  return grouped(g);
}

/**
 * What a first LP deposit costs the passport in ALGO min-balance, so a UI can
 * tell the user before they sign instead of after a revert.
 *
 * `lock` and `setPosition` both re-check that committed ALGO does not exceed free
 * ALGO, and box min-balance comes out of the same ALGO the quote pools are
 * committed from — so an under-funded passport fails on "insufficient free
 * balance", which reads like a permission problem and is really arithmetic.
 *
 * EVERY FLAG DEFAULTS TO "NOT YET PAID", so the answer is the worst case unless
 * the caller can prove otherwise. Under-reporting causes exactly the revert this
 * exists to prevent, and the two directions are not symmetrical: being told to
 * fund 157,400 when 47,700 was needed costs a user nothing, while the reverse
 * costs them a failed transaction they were told would succeed.
 *
 * A first LP deposit of an asset the passport has never held is all three charges,
 * 100,000 + 47,700 + 9,700 = 157,400. Pass the flags for a repeat deposit, where
 * the holding slot and both boxes already exist and the marginal cost is zero.
 */
export function lpDepositAlgoCost(
  opts: {
    alreadyOptedIn?: boolean;
    positionExists?: boolean;
    committedExists?: boolean;
  } = {},
): number {
  return (
    (opts.alreadyOptedIn ? 0 : ASSET_OPTIN_MBR) +
    (opts.positionExists ? 0 : POSITION_BOX_MBR) +
    (opts.committedExists ? 0 : COMMITTED_BOX_MBR)
  );
}
