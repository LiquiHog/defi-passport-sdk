/**
 * Teardown. The order matters, and skipping the last step costs the user money.
 *
 *   close every strategy      ->  unlock every position
 *   ->  ASSERT the committed ledger is EMPTY and no boxes remain
 *   ->  withdraw every asset, then all free ALGO
 *   ->  destroy(assets, keys)  ->  remove_entry on the registry
 */
import {
  assignGroupID,
  makeApplicationCallTxnFromObject,
  makeApplicationNoOpTxnFromObject,
  OnApplicationComplete,
  type SuggestedParams,
  type Transaction,
} from 'algosdk';
import { PASSPORT, REGISTRY } from './abi.js';
import { REG_BOX, REMOVE_ENTRY_FEE } from './constants.js';
import { abiBytes, addrBox, boxName, keyList, u64, u64List } from './encode.js';
import { flat } from './create.js';
import type { Group, Num } from './types.js';
import { arc2 } from './note.js';

/**
 * `destroy` closes every named asset TO THE OWNER, so the owner must already
 * hold each opt-in or the whole call reverts.
 *
 * `keys` is a length-prefixed list of every remaining box name. An incomplete
 * list makes the call REVERT rather than strand min-balance, because the AVM
 * refuses to close an account that still owns boxes — so it is fail-safe, but you
 * must enumerate them (use `read.boxes`).
 *
 * Available FOREVER, deliberately not gated on `testing`: gating deletion would
 * tax quitting, and an app that cannot be deleted is min-balance nobody ever gets
 * back.
 */
export function destroy(a: {
  owner: string;
  passport: Num;
  params: SuggestedParams;
  /** Non-zero assets only — ALGO is closed by the same call, separately. */
  assets: Num[];
  boxNames: Uint8Array[];
  fee?: number;
}): Transaction {
  if (a.assets.some((x) => Number(x) === 0)) {
    throw new RangeError('asset 0 must not be listed — ALGO is closed separately');
  }
  const p = BigInt(a.passport);
  return makeApplicationCallTxnFromObject({
    note: arc2('destroy'),
    sender: a.owner,
    suggestedParams: flat(a.params, a.fee ?? 3000),
    appIndex: p,
    onComplete: OnApplicationComplete.DeleteApplicationOC,
    appArgs: [
      PASSPORT.destroy.getSelector(),
      abiBytes(u64List(a.assets)),
      abiBytes(keyList(a.boxNames)),
    ],
    ...(a.assets.length ? { foreignAssets: a.assets.map(Number) } : {}),
    ...(a.boxNames.length
      ? { boxes: a.boxNames.map((name) => ({ appIndex: p, name })) }
      : {}),
  });
}

/**
 * De-register. A SEPARATE step, and it is easy to skip: `destroy` deletes the app
 * but does not touch the registry, so omitting this leaves an `e`+owner /
 * `a`+app_id pair behind — 37,800 uALGO of the user's own min-balance stranded,
 * and an `e` box pointing at a dead app.
 *
 * Fee 3000: it refunds that min-balance with an INNER payment, and at 1000 it
 * fails as "group fee too small", which does not look like a fee problem.
 */
export function removeEntry(a: {
  owner: string;
  registry: Num;
  passport: Num;
  params: SuggestedParams;
}): Transaction {
  const registry = BigInt(a.registry);
  return makeApplicationNoOpTxnFromObject({
    note: arc2('remove_entry'),
    sender: a.owner,
    suggestedParams: flat(a.params, REMOVE_ENTRY_FEE),
    appIndex: registry,
    appArgs: [REGISTRY.remove_entry.getSelector(), u64(a.passport)],
    // THE PASSPORT MUST BE REFERENCED. `remove_entry` resolves its address to
    // refuse de-registering one that is still LIVE — de-registering a live
    // passport permanently kills its cranking (the keeper discovers by this index)
    // and bypasses the one-live-passport guard. Reading a foreign app's params
    // requires it named, and the miss is "unavailable App <id>", which reads as a
    // registry fault and is really this caller requirement.
    foreignApps: [Number(a.passport)],
    boxes: [
      { appIndex: registry, name: addrBox(REG_BOX.owner, a.owner) },
      { appIndex: registry, name: boxName(REG_BOX.passport, a.passport) },
    ],
  });
}

/** Both, as one group — the pairing a UI should treat as a single user action. */
export function teardownGroup(a: Parameters<typeof destroy>[0] & { registry: Num }): Group {
  return assignGroupID([
    destroy(a),
    removeEntry({
      owner: a.owner,
      registry: a.registry,
      passport: a.passport,
      params: a.params,
    }),
  ]);
}
