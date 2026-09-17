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
  makeApplicationCallTxnFromObject,
  makeApplicationCreateTxnFromObject,
  makeApplicationNoOpTxnFromObject,
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
import { extraPagesFor, padBoxes, programBytes, programFee } from './pages.js';
import { MAX_PROGRAM_OVERFLOW } from './programs.js';
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
   * From `read.entitled` — the LINE it resolved, NOT a major.
   *
   * `create_entry` derives the version itself, but box references are named at
   * SIGNING time, so both of these are needed here to name `h`+line and
   * `v`+version.
   *
   * DO NOT COMPUTE THIS FROM A VERSION. Before the step-0 migration a line is
   * the major; after it a line is `major * 1000 + minor`. A version number
   * cannot tell you which shape the registry is in, and the wrong one fails the
   * group on a BOX REFERENCE — which reads like a permissions bug and is not.
   */
  entitledLine: Num;
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

  // Pages and fee follow the PROGRAM, floored at what every passport has always
  // declared. A build over the legacy cap needs more pages and pays the v42
  // surcharge on this one transaction; a build under it gets today's numbers.
  const bytes = programBytes({ approval: a.approvalProgram, clear: a.clearProgram });
  const create = makeApplicationCreateTxnFromObject({
    note: arc2('create'),
    sender: a.owner,
    suggestedParams: flat(a.params, programFee(bytes)),
    onComplete: OnApplicationComplete.NoOpOC,
    approvalProgram: a.approvalProgram,
    clearProgram: a.clearProgram,
    numGlobalInts: GLOBAL_UINTS,
    numGlobalByteSlices: GLOBAL_BYTES,
    numLocalInts: 0,
    numLocalByteSlices: 0,
    extraPages: extraPagesFor(bytes),
    appArgs: [PASSPORT.create.getSelector(), u64(registry), u64(testing)],
  });

  const entry = makeApplicationNoOpTxnFromObject({
    note: arc2('create_entry'),
    sender: a.owner,
    suggestedParams: flat(a.params, 1000),
    appIndex: registry,
    appArgs: [REGISTRY.create_entry.getSelector()],
    boxes: padBoxes(
      [
        { appIndex: registry, name: addrBox(REG_BOX.owner, a.owner) },
        { appIndex: registry, name: boxName(REG_BOX.version, a.entitledVersion) },
        { appIndex: registry, name: addrBox(REG_BOX.beta, a.owner) },
        { appIndex: registry, name: boxName(REG_BOX.head, a.entitledLine) },
      ],
      MAX_PROGRAM_OVERFLOW,
    ),
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
  /**
   * The line from `read.entitled`, NOT `majorOf(version)`. `link_passport`
   * re-runs the tier gate, so it must name the SAME head box the creation named,
   * and the two shapes of that name cannot be told apart from a version number.
   */
  line: Num;
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
    boxes: padBoxes(
      [
        { appIndex: registry, name: boxName(REG_BOX.passport, passport) },
        { appIndex: registry, name: addrBox(REG_BOX.owner, a.owner) },
        // `link_passport` re-runs the tier gate, so it needs the entitlement
        // boxes too. Missing them reads as "invalid Box reference", not as a
        // permission error.
        { appIndex: registry, name: addrBox(REG_BOX.beta, a.owner) },
        { appIndex: registry, name: boxName(REG_BOX.head, a.line) },
      ],
      MAX_PROGRAM_OVERFLOW,
    ),
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
  /**
   * The line from `read.entitled` for the owner being upgraded, not a major.
   * `verify_update` re-runs the tier gate and reads the head box for beta.
   */
  line: Num;
  approvalProgram: Uint8Array;
  clearProgram: Uint8Array;
  params: SuggestedParams;
  /**
   * The extra pages the passport declares TODAY, from `read.extraPages`.
   *
   * Never send fewer than it has. An update carrying a smaller count is accepted
   * and SHRINKS the app, which nobody upgrading intends. The default is the floor
   * every passport was created with, so omitting this is safe for any passport
   * that has never been grown; pass the real value once one has.
   */
  currentExtraPages?: number | undefined;
}): Group {
  const registry = BigInt(a.registry);
  const bytes = programBytes({ approval: a.approvalProgram, clear: a.clearProgram });
  const extraPages = Math.max(a.currentExtraPages ?? EXTRA_PAGES, extraPagesFor(bytes));
  // NOT `makeApplicationUpdateTxnFromObject`. That convenience builder omits
  // `extraPages` from its parameter type and DROPS it if passed anyway — no
  // error, no field on the wire — so an update that must grow the app would be
  // built, signed and refused on chain. Verified at the byte level; the generic
  // builder with an UpdateApplication completion carries it. An update sent
  // without the field keeps the app's current pages, which is why the old
  // builder never failed while every program fit.
  const update: Transaction = makeApplicationCallTxnFromObject({
    note: arc2('update'),
    sender: a.owner,
    suggestedParams: flat(a.params, programFee(bytes)),
    appIndex: BigInt(a.passport),
    onComplete: OnApplicationComplete.UpdateApplicationOC,
    approvalProgram: a.approvalProgram,
    clearProgram: a.clearProgram,
    extraPages,
  });
  const verify = makeApplicationNoOpTxnFromObject({
    note: arc2('verify_update'),
    sender: a.owner,
    suggestedParams: flat(a.params, 1000),
    appIndex: registry,
    appArgs: [REGISTRY.verify_update.getSelector(), u64(a.version)],
    boxes: padBoxes(
      [
        { appIndex: registry, name: boxName(REG_BOX.version, a.version) },
        { appIndex: registry, name: addrBox(REG_BOX.beta, a.owner) },
        { appIndex: registry, name: boxName(REG_BOX.head, a.line) },
      ],
      MAX_PROGRAM_OVERFLOW,
    ),
  });
  return assignGroupID([update, verify]);
}

