/** Custody, wiring and positions — everything the owner does outside strategies. */
import {
  makeApplicationNoOpTxnFromObject,
  type BoxReference,
  type Transaction,
} from 'algosdk';
import { PASSPORT } from './abi.js';
import { BOX, OPTIN_FEE } from './constants.js';
import { abiBytes, boxName, concat, u64 } from './encode.js';
import { flat } from './create.js';
import type { Num, PassportCtx } from './types.js';
import { arc2 } from './note.js';

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
  } = {},
): Transaction {
  return makeApplicationNoOpTxnFromObject({
    sender: ctx.owner,
    suggestedParams: flat(ctx.params, o.fee ?? 1000),
    appIndex: BigInt(ctx.passport),
    appArgs: [method.getSelector(), ...args],
    note: arc2(method.name),
    ...(o.boxes ? { boxes: o.boxes } : {}),
    ...(o.apps ? { foreignApps: o.apps.map(Number) } : {}),
    ...(o.assets ? { foreignAssets: o.assets.map(Number) } : {}),
  });
}

const cmBox = (p: bigint, asset: Num): BoxReference => ({
  appIndex: p,
  name: boxName(BOX.committed, asset),
});

/**
 * Opt the passport into an asset. Fee 2000 — it issues one inner transfer.
 *
 * `cm`+0 is required because an opt-in raises the app's min-balance by 100,000
 * uALGO, which comes out of the same ALGO a quote reserve is committed from.
 */
export function optIn(ctx: PassportCtx, asset: Num): Transaction {
  return call(ctx, PASSPORT.optin, [u64(asset)], {
    assets: [asset],
    boxes: [cmBox(BigInt(ctx.passport), 0)],
    fee: OPTIN_FEE,
  });
}

/** Refused while any of the asset is committed, and refused for ALGO. */
export function optOut(ctx: PassportCtx, asset: Num): Transaction {
  return call(ctx, PASSPORT.optout, [u64(asset)], {
    assets: [asset],
    boxes: [cmBox(BigInt(ctx.passport), asset)],
    fee: OPTIN_FEE,
  });
}

/**
 * Withdraw free (uncommitted) balance to the owner. Size it off
 * `read.freeBalance`, never off the raw balance.
 */
export function withdraw(ctx: PassportCtx, a: { asset: Num; amount: Num }): Transaction {
  return call(ctx, PASSPORT.withdraw, [u64(a.asset), u64(a.amount)], {
    assets: Number(a.asset) === 0 ? undefined : [a.asset],
    boxes: [cmBox(BigInt(ctx.passport), a.asset)],
    fee: OPTIN_FEE,
  });
}

/**
 * Reserve free balance from both withdrawal and strategy commitment, creating a
 * kind-0 position if none exists. Asset 0 is how the keeper's gas reserve is
 * funded — refunds are paid only out of it.
 */
export function lock(ctx: PassportCtx, a: { asset: Num; amount: Num }): Transaction {
  const p = BigInt(ctx.passport);
  return call(ctx, PASSPORT.lock, [u64(a.asset), u64(a.amount)], {
    boxes: [
      { appIndex: p, name: boxName(BOX.position, a.asset) },
      cmBox(p, a.asset),
      cmBox(p, 0),
    ],
    assets: Number(a.asset) === 0 ? undefined : [a.asset],
  });
}

/**
 * Release a reservation. NOTE a kind-0 position box is DELETED when it unlocks
 * to zero (kinds 1 and 2 keep their metadata so an LST can be re-locked without
 * re-describing its legs), so `clearPosition` afterwards would correctly fail
 * with "no such position" — check the box still exists first.
 */
export function unlock(ctx: PassportCtx, a: { asset: Num; amount: Num }): Transaction {
  const p = BigInt(ctx.passport);
  return call(ctx, PASSPORT.unlock, [u64(a.asset), u64(a.amount)], {
    boxes: [
      { appIndex: p, name: boxName(BOX.position, a.asset) },
      cmBox(p, a.asset),
      cmBox(p, 0),
    ],
    assets: Number(a.asset) === 0 ? undefined : [a.asset],
  });
}

/**
 * Attach valuation metadata to an existing position.
 *
 * `legs` is exactly 48 bytes: 2 x [valAsset, rateNum, rateDen]. The rates are the
 * owner's CAP, never the authority — a live read can only LOWER the value, which
 * mirrors the anchored floor being able only to RAISE a swap floor. Be aware the
 * bound is one-directional: it limits over-SELLING, and an understated leg makes
 * a rule buy more real base than intended.
 */
export function setPosition(
  ctx: PassportCtx,
  a: {
    asset: Num;
    kind: 0 | 1 | 2;
    subKind: Num;
    oracleApp: Num;
    refApp: Num;
    refId: Num;
    legs: Uint8Array;
  },
): Transaction {
  if (a.legs.length !== 48) throw new RangeError('legs must be exactly 48 bytes');
  return call(
    ctx,
    PASSPORT.set_position,
    [
      u64(a.asset),
      u64(a.kind),
      u64(a.subKind),
      u64(a.oracleApp),
      u64(a.refApp),
      u64(a.refId),
      abiBytes(a.legs),
    ],
    { boxes: [{ appIndex: BigInt(ctx.passport), name: boxName(BOX.position, a.asset) }] },
  );
}

/** Build the 48-byte legs blob. Leg 0 is the principal, leg 1 the accrued yield. */
export function legs(
  leg0: { valAsset: Num; rateNum: Num; rateDen: Num },
  leg1: { valAsset: Num; rateNum: Num; rateDen: Num } = { valAsset: 0, rateNum: 0, rateDen: 0 },
): Uint8Array {
  return concat(
    u64(leg0.valAsset),
    u64(leg0.rateNum),
    u64(leg0.rateDen),
    u64(leg1.valAsset),
    u64(leg1.rateNum),
    u64(leg1.rateDen),
  );
}

/** Only a fully-unlocked position may be cleared, and it reclaims the box MBR. */
export function clearPosition(ctx: PassportCtx, asset: Num): Transaction {
  return call(ctx, PASSPORT.clear_position, [u64(asset)], {
    boxes: [{ appIndex: BigInt(ctx.passport), name: boxName(BOX.position, asset) }],
  });
}

export function setOracle(ctx: PassportCtx, appId: Num): Transaction {
  return call(ctx, PASSPORT.set_oracle, [u64(appId)]);
}

export function setDirectory(ctx: PassportCtx, appId: Num): Transaction {
  return call(ctx, PASSPORT.set_directory, [u64(appId)]);
}

/**
 * Refresh the cached router and budget ids from the directory.
 *
 * THREE foreign apps, and this is the call a hand-written client gets wrong. The
 * passport resolves each incoming app's ADDRESS to prove it exists, and reading
 * a foreign app's params requires THAT app referenced — not just the directory.
 * Miss them and you get `unavailable App <id>`, which reads like a contract fault
 * and is not.
 *
 * Owner-gated, and it must stay that way: the platform publishes, the owner
 * accepts. It deliberately never follows the directory's `registry`, because a
 * passport's registry is its trust anchor and holds its registration.
 */
export function syncContracts(
  ctx: PassportCtx,
  a: { directory: Num; router: Num; budget: Num },
): Transaction {
  return call(ctx, PASSPORT.sync_contracts, [], {
    apps: [a.directory, a.router, a.budget],
  });
}
