/**
 * LP tokens: getting them into a passport, valuing them, and recording enough at
 * deposit time to show PnL later.
 *
 * WHAT THE CONTRACT DOES AND DOES NOT KNOW. An LP position is valued from the
 * owner's declared leg rates and nothing else — for this position kind there is no
 * on-chain check on that valuation whatsoever. The passport cannot read a pool,
 * cannot attest what an LP unit was worth, and cannot compute PnL. Every number
 * here is derived OFF CHAIN, and a UI should present it as such.
 *
 * WHICH IS WHY THE SNAPSHOT GOES IN THE NOTE. `lpDepositNote` records the pool,
 * both reserves, the LP circulating supply AND the round the read was taken at.
 * That makes the basis SELF-REPORTED BUT RETROSPECTIVELY VERIFIABLE: anyone can
 * replay that round and check the reserves were what the note claims. It is not
 * an on-chain attestation, but it is not bare trust either.
 *
 * CONSTANT-PRODUCT ONLY. The pro-rata arithmetic below — an LP unit is a claim on
 * `reserve * units / circulating` of each side — is correct for a genuine CP AMM
 * and WRONG for stableswap (different curve) and for concentrated liquidity
 * (per-tick, so there is no single pro-rata share). The oracle refuses those pool
 * types for the same reason. Do not point this at one.
 *
 * A contract-attested basis is the planned upgrade and lands with liquidity
 * management, which needs pool reads anyway. The note fields are chosen to match
 * what that log would carry, so an indexer written now keeps working.
 */
import { type Algodv2, getApplicationAddress } from 'algosdk';
import { arc2 } from './note.js';
import type { Num } from './types.js';

/**
 * A pool as it stood at one round. `round` is what makes the basis checkable.
 */
export interface LpSnapshot {
  poolApp: bigint;
  poolAddress: string;
  /** Which of the pool's six tiers. Each has its own reserves and LP asset. */
  tier: number;
  assetA: bigint;
  reserveA: bigint;
  assetB: bigint;
  reserveB: bigint;
  lpAsset: bigint;
  /** Total LP minted for THIS TIER, treasury included — the pro-rata denominator. */
  lpTotal: bigint;
  treasuryLp: bigint;
  round: bigint;
}

/** STAMM tier index -> the character its global-state keys use. */
export const TIER_CHARS: Record<number, string> = {
  0: '0', 1: '1', 2: '2', 3: '3', 4: '4', 5: 'p',
};

/**
 * A uint from global state, by key NAME.
 *
 * algosdk v3 hands back `key` as a Uint8Array, not the base64 string the REST API
 * returns. Comparing against a base64 string therefore matches nothing and every
 * lookup silently reads 0 — which for a reserve or an LP supply is not an obvious
 * failure, it is a plausible-looking wrong answer. Decode and compare as text.
 */
const gsU64 = (
  gs: { key: Uint8Array | string; value: { uint?: bigint | number } }[],
  key: string,
): bigint => {
  const kv = gs.find(
    (x) => (x.key instanceof Uint8Array ? new TextDecoder().decode(x.key) : x.key) === key,
  );
  return kv ? BigInt(kv.value.uint ?? 0) : 0n;
};

/**
 * Read ONE TIER of a STAMM pool.
 *
 * PER-TIER, AND THAT IS THE WHOLE POINT. A STAMM pool holds six independent
 * tiers, each with its own reserves, its own LP asset and its own LP supply. The
 * pool ACCOUNT's holdings are the sum across all six, so valuing an LP token from
 * account holdings divided by one tier's supply overstates every holder's claim
 * several-fold — on the ALGO/HOG pool the account holds ~36,791 ALGO while tier 2
 * holds ~5,373. The oracle's `_stamm_read` sums the tiers deliberately, because
 * summing is right for a PRICE and wrong for an LP claim.
 *
 * So this reads the tier's own accounting from global state: `t{c}_ra`, `t{c}_rb`,
 * `t{c}_lp` (total LP minted) and `t{c}_la` (the tier's LP asset). Using the
 * pool's own LP total is also better than inferring circulating supply from the
 * ASA's total minus what the pool holds — the pool already knows, exactly.
 *
 * `total_lp` INCLUDES treasury LP (`t{c}_tl`) and is the correct denominator: the
 * treasury's claim on the reserves is as real as anyone's, so netting it out would
 * inflate everyone else's share.
 *
 * STAMM ONLY. A generic constant-product pool keeps reserves as account holdings
 * instead, which is a different read; the oracle distinguishes them as dex_type 0
 * and 1. There is no generic path here because none has been tested against a
 * real pool, and an untested valuation path is worse than an absent one.
 */
export async function readStammTier(
  algod: Algodv2,
  a: { poolApp: Num; tier: number; expectLpAsset?: Num },
): Promise<LpSnapshot> {
  const c = TIER_CHARS[a.tier];
  if (c === undefined) throw new RangeError(`tier must be 0..5, got ${a.tier}`);
  const app = BigInt(a.poolApp);
  const info = await algod.getApplicationByID(app).do();
  const gs = (info.params?.globalState ?? []) as unknown as {
    key: Uint8Array | string;
    value: { uint?: bigint | number };
  }[];
  const lpAsset = gsU64(gs, `t${c}_la`);
  if (lpAsset === 0n) throw new Error(`tier ${a.tier} has no LP asset (unseeded?)`);
  if (a.expectLpAsset !== undefined && lpAsset !== BigInt(a.expectLpAsset)) {
    throw new Error(
      `tier ${a.tier} LP asset is ${lpAsset}, not ${BigInt(a.expectLpAsset)}`,
    );
  }
  const total = gsU64(gs, `t${c}_lp`);
  if (total === 0n) throw new Error(`tier ${a.tier} has no LP supply (unseeded)`);
  const status = await algod.status().do();
  return {
    poolApp: app,
    poolAddress: getApplicationAddress(app).toString(),
    tier: a.tier,
    assetA: gsU64(gs, 'aa'),
    reserveA: gsU64(gs, `t${c}_ra`),
    assetB: gsU64(gs, 'ab'),
    reserveB: gsU64(gs, `t${c}_rb`),
    lpAsset,
    lpTotal: total,
    treasuryLp: gsU64(gs, `t${c}_tl`),
    round: status.lastRound,
  };
}

/** What `units` LP tokens are a claim on, at this snapshot. */
export function lpShares(s: LpSnapshot, units: Num): { shareA: bigint; shareB: bigint } {
  const u = BigInt(units);
  if (s.lpTotal === 0n) return { shareA: 0n, shareB: 0n };
  return {
    shareA: (s.reserveA * u) / s.lpTotal,
    shareB: (s.reserveB * u) / s.lpTotal,
  };
}

/**
 * The `legs` rates for `setPosition`, DERIVED FROM REAL RESERVES.
 *
 * The contract computes a leg as `muldiv(amount, rateNum, rateDen)`, so
 * `reserve / circulating` is exactly the pro-rata share — no scaling needed and
 * no rounding done here, which matters: the rates are a CAP the contract takes
 * `min()` against, and UNDERSTATING one makes a balancer read the position as
 * worth less than it is and over-buy the other side. Deriving them from the pool
 * rather than letting a caller invent them is the point of this function.
 */
export function lpLegsFromSnapshot(s: LpSnapshot): {
  legA: { valAsset: bigint; rateNum: bigint; rateDen: bigint };
  legB: { valAsset: bigint; rateNum: bigint; rateDen: bigint };
} {
  const den = s.lpTotal === 0n ? 1n : s.lpTotal;
  return {
    legA: { valAsset: s.assetA, rateNum: s.reserveA, rateDen: den },
    legB: { valAsset: s.assetB, rateNum: s.reserveB, rateDen: den },
  };
}

/**
 * The deposit note: the entry basis, in the form a PnL display needs.
 *
 * Every id and amount is a string — see `arc2`. `r` is the round, and it is the
 * field that makes this auditable rather than merely claimed.
 */
export function lpDepositNote(
  s: LpSnapshot,
  a: { passport: Num; units: Num },
): Uint8Array {
  const { shareA, shareB } = lpShares(s, a.units);
  return arc2('deposit_lp', {
    p: a.passport,
    a: s.lpAsset,
    u: a.units,
    pool: s.poolApp,
    xa: s.assetA,
    ra: s.reserveA,
    xb: s.assetB,
    rb: s.reserveB,
    sup: s.lpTotal,
    ba: shareA,
    bb: shareB,
    r: s.round,
  });
}

/**
 * PnL against a recorded basis, per side, in the underlying assets.
 *
 * DELIBERATELY NOT PRICED. Converting both sides to one number needs a price for
 * each, which is a different source with its own staleness and its own trust
 * story — and quoting a single figure would bury that. Per-side deltas are what
 * this data actually supports: an LP position that is up on one reserve and down
 * on the other is the normal case, not an edge one.
 */
export function lpPnl(
  basis: { shareA: Num; shareB: Num },
  now: LpSnapshot,
  units: Num,
): { deltaA: bigint; deltaB: bigint; shareA: bigint; shareB: bigint } {
  const cur = lpShares(now, units);
  return {
    ...cur,
    deltaA: cur.shareA - BigInt(basis.shareA),
    deltaB: cur.shareB - BigInt(basis.shareB),
  };
}
