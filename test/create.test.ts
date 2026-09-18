/**
 * The three groups that talk to the REGISTRY, and the box references they name.
 *
 * These are where the version-line split actually bites. A registry entry point
 * reads its boxes by name, box references are fixed at SIGNING time, and naming
 * the wrong one fails as "invalid Box reference" — which reads like a permissions
 * bug and is not one. That is the failure that took the contract team's own
 * regression suite from 9/9 to 2/9, and none of these builders had a test.
 *
 * THE SETS BELOW WERE READ FROM THE CONTRACT, NOT INFERRED FROM BEHAVIOUR —
 * `_ceiling`, `_entitled`, `create_entry`, `link_passport` and `verify_update`,
 * in the registry build deployed on every live registry at the time of writing.
 * `scripts/live-check.mjs` pins that program by sha256 and fails when it moves,
 * because the day it changes these assertions stop describing anything real.
 *
 *   create_entry    v+version, e+owner, w+owner, h+line
 *                   version and line both come from _entitled/_ceiling, which is
 *                   what read.entitled returns. No a+app_id: that box does not
 *                   exist until link_passport creates it.
 *   link_passport   a+app_id, e+owner, w+owner, h+line
 *   verify_update   v+version, w+owner, h+line
 *
 * THE LINE IS PASSED THROUGH, NEVER DERIVED. A line is a major before the step-0
 * migration and `major * 1000 + minor` after it, and a version number cannot say
 * which. Every test here uses a line that is deliberately NOT `majorOf(version)`
 * and not `version / 1000` either, so any builder that recomputes it fails.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { createGroup, linkGroup, upgradeGroup } from '../dist/index.js';
import {
  EXTRA_PAGES,
  GLOBAL_BYTES,
  GLOBAL_UINTS,
  INDEX_BOX_MBR,
  OVERSIZED_PROGRAM_FEE,
  REG_BOX,
  VERIFY_UPDATE_FEE,
} from '../dist/constants.js';
import { addrBox, boxName } from '../dist/encode.js';
import { PARAMS, PASSPORT, addr, hex } from './helpers.ts';

// Not the shared owner: this address's bytes are asserted inside box names below.
const OWNER = addr(7);
const REGISTRY = 3672932347;
const VERSION = 1_001_001n; // v1.1.1

/**
 * A line that matches NO derivation from VERSION.
 *
 * `majorOf(1001001)` is 1 and `1001001 / 1000` is 1001, so 4242 can only appear
 * in a group if the builder passed through what it was given.
 */
const LINE = 4242;

const APPROVAL = new Uint8Array([0x0b, 0x81, 0x01]);
const CLEAR = new Uint8Array([0x0b, 0x81, 0x01, 0x43]);


/** Box references as a comparable set — the AVM does not care about order. */
const boxSet = (t: algosdk.Transaction): string[] =>
  (t.applicationCall?.boxes ?? []).map((b) => `${b.appIndex}:${hex(b.name)}`).sort();

const expect = (appIndex: number, ...names: Uint8Array[]): string[] =>
  names.map((n) => `${appIndex}:${hex(n)}`).sort();

// ── createGroup ─────────────────────────────────────────────────────────────

const create = (over: Record<string, unknown> = {}) =>
  createGroup({
    owner: OWNER,
    registry: REGISTRY,
    params: PARAMS,
    approvalProgram: APPROVAL,
    clearProgram: CLEAR,
    entitledLine: LINE,
    entitledVersion: VERSION,
    ...over,
  } as Parameters<typeof createGroup>[0]);

test('createGroup is [pay, create, create_entry], grouped', () => {
  const g = create();
  assert.equal(g.length, 3);
  assert.deepEqual(
    g.map((t) => t.type),
    ['pay', 'appl', 'appl'],
  );
  for (const t of g) assert.ok(t.group, 'every member must carry the group id');
});

test('create_entry names exactly the four boxes the contract reads', () => {
  const entry = create()[2]!;
  assert.deepEqual(
    boxSet(entry),
    expect(
      REGISTRY,
      addrBox(REG_BOX.owner, OWNER),
      boxName(REG_BOX.version, VERSION),
      addrBox(REG_BOX.beta, OWNER),
      boxName(REG_BOX.head, LINE),
    ),
  );
});

test('create_entry names the LINE it was given, not one derived from the version', () => {
  // The regression the whole migration was about. 4242 is neither majorOf(v)
  // nor v/1000, so it can only be here if it was passed through.
  const entry = create()[2]!;
  const heads = (entry.applicationCall?.boxes ?? []).filter((b) => b.name[0] === 0x68 /* h */);
  assert.equal(heads.length, 1);
  assert.equal(hex(heads[0]!.name), hex(boxName(REG_BOX.head, LINE)));
  assert.notEqual(hex(heads[0]!.name), hex(boxName(REG_BOX.head, 1)), 'not the major');
  assert.notEqual(hex(heads[0]!.name), hex(boxName(REG_BOX.head, 1001)), 'not version/1000');
});

test('the testing flag is hard-wired to 0 and is not a caller choice', () => {
  // Every safety gate keys off it — buy ceilings, schedule floors, the registry
  // gate on update, the downgrade block — and it is frozen at creation. A UI
  // must not be able to turn them off, least of all by accident.
  const args = create()[1]!.applicationCall?.appArgs ?? [];
  assert.equal(args.length, 3, 'selector, registry, testing');
  assert.equal(hex(args[2]!), '0000000000000000');
});

test('the creation transaction freezes the schema the passport can never regrow', () => {
  const c = create()[1]!.applicationCall;
  assert.equal(c?.numGlobalInts, GLOBAL_UINTS);
  assert.equal(c?.numGlobalByteSlices, GLOBAL_BYTES);
  assert.equal(c?.extraPages, EXTRA_PAGES);
});

test('the payment funds the registry index boxes, to the registry itself', () => {
  const pay = create()[0]!;
  assert.equal(Number(pay.payment?.amount), INDEX_BOX_MBR);
  assert.equal(
    pay.payment?.receiver.toString(),
    algosdk.getApplicationAddress(BigInt(REGISTRY)).toString(),
  );
});

test('a previous passport is referenced only when there is one', () => {
  // create_entry refuses a SECOND LIVE passport and decides by resolving this
  // app's address, so it must be referenced whenever the index exists.
  assert.deepEqual(create()[2]!.applicationCall?.foreignApps ?? [], []);
  const withPrev = create({ previousPassport: 12345 })[2]!;
  assert.deepEqual((withPrev.applicationCall?.foreignApps ?? []).map(Number), [12345]);
});

// ── linkGroup ───────────────────────────────────────────────────────────────

const link = () =>
  linkGroup({
    owner: OWNER,
    registry: REGISTRY,
    passport: PASSPORT,
    version: VERSION,
    line: LINE,
    params: PARAMS,
  });

test('linkGroup is [confirm_version, link_passport], in that order', () => {
  // The passport reads Txn.group_index + 1 to find the link_passport attesting
  // it, so swapping them makes it refuse.
  const g = link();
  assert.equal(g.length, 2);
  assert.equal(g[0]!.applicationCall?.appIndex, BigInt(PASSPORT), 'confirm goes to the passport');
  assert.equal(g[1]!.applicationCall?.appIndex, BigInt(REGISTRY), 'link goes to the registry');
});

test('confirm_version references the registry the passport will check against', () => {
  const confirm = link()[0]!;
  assert.deepEqual((confirm.applicationCall?.foreignApps ?? []).map(Number), [REGISTRY]);
});

test('link_passport names the four boxes it reads, including the tier gate', () => {
  // It re-runs _entitled through _ceiling, so it needs the beta box and the head
  // as well as its own two indexes. Missing them reads as "invalid Box
  // reference", not as a permission error.
  assert.deepEqual(
    boxSet(link()[1]!),
    expect(
      REGISTRY,
      boxName(REG_BOX.passport, PASSPORT),
      addrBox(REG_BOX.owner, OWNER),
      addrBox(REG_BOX.beta, OWNER),
      boxName(REG_BOX.head, LINE),
    ),
  );
});

// ── upgradeGroup ────────────────────────────────────────────────────────────

const upgrade = () =>
  upgradeGroup({
    owner: OWNER,
    registry: REGISTRY,
    passport: PASSPORT,
    version: VERSION,
    line: LINE,
    approvalProgram: APPROVAL,
    clearProgram: CLEAR,
    params: PARAMS,
  });

test('upgradeGroup is [update, verify_update], in that order', () => {
  // verify_update reads Txn.group_index - 1 and asserts it is an
  // UpdateApplication call, so the pair is mutually pinned.
  const g = upgrade();
  assert.equal(g.length, 2);
  assert.equal(g[0]!.applicationCall?.onComplete, algosdk.OnApplicationComplete.UpdateApplicationOC);
  assert.equal(g[0]!.applicationCall?.appIndex, BigInt(PASSPORT));
  assert.equal(g[1]!.applicationCall?.appIndex, BigInt(REGISTRY));
});

test('verify_update names v+version, the beta box and the head', () => {
  assert.deepEqual(
    boxSet(upgrade()[1]!),
    expect(
      REGISTRY,
      boxName(REG_BOX.version, VERSION),
      addrBox(REG_BOX.beta, OWNER),
      boxName(REG_BOX.head, LINE),
    ),
  );
});

test('the UPDATE transaction is sent by the owner, which is what authenticates it', () => {
  // verify_update authenticates off the sender of the UPDATE, not off whoever
  // submitted the verify call — "whoever merely submitted this call is not
  // evidence of anything". The two are the same address here, which is exactly
  // why it is worth asserting: using one address for both hides the distinction,
  // and the `w` box named must be the UPDATE sender's.
  const [update, verify] = upgrade();
  assert.equal(update!.sender.toString(), OWNER);
  assert.equal(verify!.sender.toString(), OWNER);
  const betaBox = (verify!.applicationCall?.boxes ?? []).find((b) => b.name[0] === 0x77 /* w */);
  assert.equal(hex(betaBox!.name), hex(addrBox(REG_BOX.beta, update!.sender.toString())));
});

test('the update carries the programs, which the registry re-hashes in-group', () => {
  const update = upgrade()[0]!.applicationCall;
  assert.deepEqual(update?.approvalProgram, APPROVAL);
  assert.deepEqual(update?.clearProgram, CLEAR);
});

test('all three groups pass the line through unchanged', () => {
  // One assertion covering every entry point: the head box is h + u64(LINE) in
  // each, and LINE matches no derivation from VERSION.
  const want = hex(boxName(REG_BOX.head, LINE));
  for (const [name, g, i] of [
    ['createGroup', create(), 2],
    ['linkGroup', link(), 1],
    ['upgradeGroup', upgrade(), 1],
  ] as const) {
    const head = (g[i]!.applicationCall?.boxes ?? []).find((b) => b.name[0] === 0x68);
    assert.equal(hex(head!.name), want, `${name} must name h + u64(${LINE})`);
  }
});

// ── pages and fees follow the program ───────────────────────────────────────
//
// Consensus v42 lifted the 8,192-byte cap. A build over it has to declare more
// extra pages and pay a surcharge on the ONE transaction carrying it — and the
// convenience builder algosdk offers for updates silently DROPS extraPages, so
// the assertion that matters here is on the encoded bytes, not on the object.

const BIG_APPROVAL = new Uint8Array(10_588); // v1.1.2's size, six pages
const BIG_CLEAR = new Uint8Array(4);

/** The field as it will reach the node — after encoding, not before. */
const onWire = (t: algosdk.Transaction) =>
  algosdk.decodeUnsignedTransaction(algosdk.encodeUnsignedTransaction(t)).applicationCall!;

const upgradeBig = (over: Record<string, unknown> = {}) =>
  upgradeGroup({
    owner: OWNER,
    registry: REGISTRY,
    passport: PASSPORT,
    version: 1_001_002n,
    line: LINE,
    approvalProgram: BIG_APPROVAL,
    clearProgram: BIG_CLEAR,
    params: PARAMS,
    ...over,
  });

test('an update carrying an oversized program declares five extra pages ON THE WIRE', () => {
  const update = onWire(upgradeBig()[0]!);
  assert.equal(update.onComplete, algosdk.OnApplicationComplete.UpdateApplicationOC);
  assert.equal(update.extraPages, 5, 'apep must survive encoding');
  // Belt and braces: the field name itself is in the bytes.
  const bytes = Buffer.from(algosdk.encodeUnsignedTransaction(upgradeBig()[0]!));
  assert.ok(bytes.includes(Buffer.from('apep')), 'the apep field is present in the encoded transaction');
});

test('an update carrying an oversized program pays the surcharge; a small one does not', () => {
  assert.equal(Number(upgradeBig()[0]!.fee), OVERSIZED_PROGRAM_FEE);
  assert.equal(Number(upgrade()[0]!.fee), 1000);
});

test('an update sends its page count explicitly even when it does not grow', () => {
  // A bare update keeps the app's current pages, so omitting the field would
  // work today — and would hide the drop the moment a build needs more.
  const update = onWire(upgrade()[0]!);
  assert.equal(update.extraPages, EXTRA_PAGES);
  const bytes = Buffer.from(algosdk.encodeUnsignedTransaction(upgrade()[0]!));
  assert.ok(bytes.includes(Buffer.from('apep')));
});

test('an update RESTATES the schema on the wire — a missing one asks for 0/0', () => {
  // Found by the front end on mainnet, not by a test: sending extraPages moves
  // every update onto the ledger's size-change path, where the schema is
  // whatever the transaction states. The generic builder carries one whether or
  // not it is given, zero is omitted from the wire, and absent means "change to
  // 0/0" — refused as "store integer count 8 exceeds schema integer count 0".
  // The convenience builder never sent a schema either; it never sent pages, so
  // it never took that path. Asserted on the encoded bytes, where alone it shows.
  for (const g of [upgrade(), upgradeBig()]) {
    const bytes = Buffer.from(algosdk.encodeUnsignedTransaction(g[0]!));
    assert.ok(bytes.includes(Buffer.from('apgs')), 'the global schema is present in the encoded update');
    const c = onWire(g[0]!);
    assert.equal(c.numGlobalInts, GLOBAL_UINTS);
    assert.equal(c.numGlobalByteSlices, GLOBAL_BYTES);
    assert.equal(c.numLocalInts, 0);
    assert.equal(c.numLocalByteSlices, 0);
  }
});

test('an update restates the schema it was GIVEN, not the default', () => {
  const g = upgradeBig({ schema: { globalInts: 14, globalBytes: 3, localInts: 1, localBytes: 1 } });
  const c = onWire(g[0]!);
  assert.equal(c.numGlobalInts, 14);
  assert.equal(c.numGlobalByteSlices, 3);
  assert.equal(c.numLocalInts, 1);
  assert.equal(c.numLocalByteSlices, 1);
});

test('the verify_update fee is the constant the cost helper also counts', () => {
  assert.equal(Number(upgradeBig()[1]!.fee), VERIFY_UPDATE_FEE);
});

test('an update never declares fewer pages than the passport already has', () => {
  // A smaller count is accepted by the ledger and SHRINKS the app. The builder
  // takes the current count and floors at it.
  const grownThenSmallBuild = upgradeGroup({
    owner: OWNER,
    registry: REGISTRY,
    passport: PASSPORT,
    version: VERSION,
    line: LINE,
    approvalProgram: APPROVAL,
    clearProgram: CLEAR,
    params: PARAMS,
    currentExtraPages: 5,
  });
  assert.equal(onWire(grownThenSmallBuild[0]!).extraPages, 5);
  // and the floor still applies below it
  assert.equal(onWire(upgradeBig({ currentExtraPages: 2 })[0]!).extraPages, 5);
  assert.equal(onWire(upgradeBig({ currentExtraPages: 6 })[0]!).extraPages, 6);
});

test('creating on an oversized program declares five pages and pays the surcharge', () => {
  const g = create({ approvalProgram: BIG_APPROVAL, clearProgram: BIG_CLEAR });
  const c = onWire(g[1]!);
  assert.equal(c.extraPages, 5);
  assert.equal(Number(g[1]!.fee), OVERSIZED_PROGRAM_FEE);
  // the other two members are unaffected
  assert.equal(Number(g[0]!.fee), 1000);
  assert.equal(Number(g[2]!.fee), 1000);
});

test('creating on a small program is exactly what every existing passport got', () => {
  const g = create();
  assert.equal(onWire(g[1]!).extraPages, EXTRA_PAGES);
  assert.equal(Number(g[1]!.fee), 1000);
});

test('the registry calls in every group already buy the read budget with real boxes', () => {
  // Four, four and three real references: at or above the need for any bundled
  // build, so no empties appear and nothing changes for stable owners.
  for (const [name, t, expectReal] of [
    ['create_entry', create()[2]!, 4],
    ['link_passport', link()[1]!, 4],
    ['verify_update', upgrade()[1]!, 3],
  ] as const) {
    const boxes = t.applicationCall?.boxes ?? [];
    assert.equal(boxes.filter((b) => b.name.length > 0).length, expectReal, name);
    assert.ok(boxes.length >= boxes.filter((b) => b.name.length > 0).length, name);
  }
});
