/**
 * Creating a passport — TWO groups, and the split is not optional.
 *
 * Group 2's box name is `"a" + app_id`, and the app id does not exist until
 * group 1 executes — but box references must be named at SIGNING time. There is
 * no way to name it in advance, and predicting it races every other app creation
 * on chain. That same constraint is why registration is the earliest point the
 * passport's version can be attested.
 */
import {
  assignGroupID,
  getApplicationAddress,
  makeApplicationCreateTxnFromObject,
  makeApplicationNoOpTxnFromObject,
  makeApplicationUpdateTxnFromObject,
  makePaymentTxnWithSuggestedParamsFromObject,
  OnApplicationComplete,
  type SuggestedParams,
  type Transaction,
} from 'algosdk';
import { PASSPORT, REGISTRY } from './abi.js';
import {
  EXTRA_PAGES,
  GLOBAL_BYTES,
  GLOBAL_UINTS,
  INDEX_BOX_MBR,
  REG_BOX,
} from './constants.js';
import { addrBox, boxName, u64 } from './encode.js';
import { majorOf } from './version.js';
import type { Group, Num } from './types.js';
import { arc2 } from './note.js';

/** algosdk computes a per-byte fee unless told otherwise. */
export function flat(params: SuggestedParams, fee: number): SuggestedParams {
  return { ...params, flatFee: true, fee: BigInt(fee) };
}

export interface CreateArgs {
  owner: string;
  registry: Num;
  params: SuggestedParams;
  /** Program bytes for THE VERSION THIS OWNER IS ENTITLED TO — see below. */
  approvalProgram: Uint8Array;
  clearProgram: Uint8Array;
  /**
   * From `read.entitled`. `create_entry` derives the version itself, but box
   * references are named at signing time, so both are needed here to name
   * `h`+major and `v`+version.
   */
  entitledMajor: Num;
  entitledVersion: Num;
  /**
   * The app id this owner's index currently names, from `read.findPassport`, or
   * 0. `create_entry` refuses a SECOND LIVE passport and decides by resolving
   * this app's address — so it must be referenced whenever the index exists. A
   * DANGLING index (destroyed without `remove_entry`) is fine: the registry sees
   * the app is gone and re-points, which is what stops a missed de-registration
   * locking the owner out for ever.
   */
  previousPassport?: Num | undefined;
}

/**
 * Group 1: `[payment, create, create_entry]`.
 *
 * The payment funds the registry's two index boxes — registration is
 * creator-funded, so the owner pays it and reclaims it at `remove_entry`.
 */
export function createGroup(a: CreateArgs): Group {
  // ALWAYS 0, and not a caller's choice.
  //
  // The passport's own `testing` flag is a creation argument, frozen at creation,
  // and every safety gate keys off it: mandatory buy ceilings, mandatory schedule
  // floors, the registry gate on `update`, and the downgrade block. A passport
  // created with 1 has all of them off and its owner can install arbitrary code
  // into it.
  //
  // Those gates protect the OWNER, so an interface must not be able to turn them
  // off — least of all by accident, since nothing afterwards reports that a
  // passport is unprotected and the flag can never be changed.
  const testing = 0;
  const registry = BigInt(a.registry);

  const pay = makePaymentTxnWithSuggestedParamsFromObject({
    note: arc2('index_mbr'),
    sender: a.owner,
    receiver: getApplicationAddress(registry).toString(),
    amount: INDEX_BOX_MBR,
    suggestedParams: flat(a.params, 1000),
  });

  const create = makeApplicationCreateTxnFromObject({
    note: arc2('create'),
    sender: a.owner,
    suggestedParams: flat(a.params, 1000),
    onComplete: OnApplicationComplete.NoOpOC,
    approvalProgram: a.approvalProgram,
    clearProgram: a.clearProgram,
    numGlobalInts: GLOBAL_UINTS,
    numGlobalByteSlices: GLOBAL_BYTES,
    numLocalInts: 0,
    numLocalByteSlices: 0,
    extraPages: EXTRA_PAGES,
    appArgs: [PASSPORT.create.getSelector(), u64(registry), u64(testing)],
  });

  const entry = makeApplicationNoOpTxnFromObject({
    note: arc2('create_entry'),
    sender: a.owner,
    suggestedParams: flat(a.params, 1000),
    appIndex: registry,
    appArgs: [REGISTRY.create_entry.getSelector()],
    boxes: [
      { appIndex: registry, name: addrBox(REG_BOX.owner, a.owner) },
      { appIndex: registry, name: boxName(REG_BOX.version, a.entitledVersion) },
      { appIndex: registry, name: addrBox(REG_BOX.beta, a.owner) },
      { appIndex: registry, name: boxName(REG_BOX.head, a.entitledMajor) },
    ],
    ...(a.previousPassport ? { foreignApps: [Number(a.previousPassport)] } : {}),
  });

  return assignGroupID([pay, create, entry]);
}

/**
 * Group 2: `[confirm_version, link_passport]` — **in that order**.
 *
 * The passport reads `Txn.group_index + 1` to find the `link_passport`
 * attesting it, so swapping them makes it refuse.
 *
 * Why the passport does not record its own version at creation: nothing has
 * verified the program bytes at that instant. The registry DOES verify them, in
 * `create_entry`, in that very group — but it cannot tell the passport, and the
 * passport cannot ask, because entitlement depends on registry BOXES. So
 * `version` stays 0 (meaning "unattested") until registration proves it, and
 * until then the downgrade block is inert.
 *
 * SUBMIT THIS IMMEDIATELY AFTER GROUP 1. `create_entry` re-points `e`+owner, so
 * a second passport created first makes this one permanently unlinkable — and
 * an unlinked passport can never relay events, which means the keeper can never
 * crank it. Treat create-then-link as one atomic user action.
 */
export function linkGroup(a: {
  owner: string;
  registry: Num;
  passport: Num;
  version: Num;
  params: SuggestedParams;
}): Group {
  const registry = BigInt(a.registry);
  const passport = BigInt(a.passport);

  const confirm = makeApplicationNoOpTxnFromObject({
    note: arc2('confirm_version'),
    sender: a.owner,
    suggestedParams: flat(a.params, 1000),
    appIndex: passport,
    appArgs: [PASSPORT.confirm_version.getSelector(), u64(a.version)],
    foreignApps: [registry],
  });

  const link = makeApplicationNoOpTxnFromObject({
    note: arc2('link_passport'),
    sender: a.owner,
    suggestedParams: flat(a.params, 1000),
    appIndex: registry,
    appArgs: [REGISTRY.link_passport.getSelector(), u64(passport), u64(a.version)],
    boxes: [
      { appIndex: registry, name: boxName(REG_BOX.passport, passport) },
      { appIndex: registry, name: addrBox(REG_BOX.owner, a.owner) },
      // `link_passport` re-runs the tier gate, so it needs the entitlement
      // boxes too. Missing them reads as "invalid Box reference", not as a
      // permission error.
      { appIndex: registry, name: addrBox(REG_BOX.beta, a.owner) },
      { appIndex: registry, name: boxName(REG_BOX.head, majorOf(a.version)) },
    ],
  });

  return assignGroupID([confirm, link]);
}

/**
 * The upgrade path: `[update, verify_update]`, mutually pinned. The passport
 * asserts the next txn is a `verify_update` on its own registry; the registry
 * asserts the previous txn is the update, re-hashes the new pages against the
 * named version, and enforces the tier. The passport independently refuses any
 * version at or below the one it is running.
 */
export function upgradeGroup(a: {
  owner: string;
  registry: Num;
  passport: Num;
  version: Num;
  approvalProgram: Uint8Array;
  clearProgram: Uint8Array;
  params: SuggestedParams;
}): Group {
  const registry = BigInt(a.registry);
  const update: Transaction = makeApplicationUpdateTxnFromObject({
    note: arc2('update'),
    sender: a.owner,
    suggestedParams: flat(a.params, 1000),
    appIndex: BigInt(a.passport),
    approvalProgram: a.approvalProgram,
    clearProgram: a.clearProgram,
  });
  const verify = makeApplicationNoOpTxnFromObject({
    note: arc2('verify_update'),
    sender: a.owner,
    suggestedParams: flat(a.params, 1000),
    appIndex: registry,
    appArgs: [REGISTRY.verify_update.getSelector(), u64(a.version)],
    boxes: [
      { appIndex: registry, name: boxName(REG_BOX.version, a.version) },
      { appIndex: registry, name: addrBox(REG_BOX.beta, a.owner) },
      { appIndex: registry, name: boxName(REG_BOX.head, majorOf(a.version)) },
    ],
  });
  return assignGroupID([update, verify]);
}

