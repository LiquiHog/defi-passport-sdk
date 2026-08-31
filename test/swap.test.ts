/**
 * The swap builder's reference packing.
 *
 * A router quote becomes a blob the passport replays as inner transactions, and
 * every reference those legs touch has to be named on the OUTER group. A real
 * multi-hop route needs more references than one transaction can carry, so they
 * spill onto `ping` transactions — and that spill is where the constraints stop
 * being independent.
 *
 * THE ONE THAT IS EASY TO MISS: a box reference is only valid on a transaction
 * that also names the app it belongs to. Pack boxes and apps as separate items
 * and a box can land on one transaction with its app on the next, which algosdk
 * then refuses to encode at all — from inside `assignGroupID`, so it reads like a
 * caller mistake. It only appears once a route needs a second page.
 *
 * These build synthetic sessions rather than real router quotes: the packer does
 * not care where the legs came from, and a fixture cannot go stale.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { swap } from '../dist/index.js';
import { MAX_REFS_PER_TXN } from '../dist/constants.js';
import type { PassportCtx } from '../dist/types.js';
import type { SwapArgs } from '../dist/swap.js';

const PARAMS = {
  fee: 1000n,
  minFee: 1000n,
  firstValid: 1n,
  lastValid: 1001n,
  genesisID: 'testnet-v1.0',
  genesisHash: new Uint8Array(32),
  flatFee: true,
};

const addr = (n: number): string => algosdk.encodeAddress(new Uint8Array(32).fill(n));

const PASSPORT = 555;
const ROUTER = 999;

// These builders never call algod — they are pure, and that is the point of the
// SDK. Casting once here, rather than at each call site, keeps every other line
// in this file checked against the real signature.
const ctx = (): PassportCtx => ({
  algod: null as unknown as algosdk.Algodv2,
  registry: 1,
  params: PARAMS,
  owner: addr(9),
  passport: PASSPORT,
});

/** An app call leg that reads `boxes` of its own app and touches `assets`. */
const leg = (app: number, o: { boxes?: number; assets?: number[]; accounts?: number[] } = {}) =>
  algosdk.makeApplicationNoOpTxnFromObject({
    sender: addr(1),
    appIndex: BigInt(app),
    appArgs: [new Uint8Array([1])],
    suggestedParams: PARAMS,
    ...(o.boxes
      ? {
          boxes: Array.from({ length: o.boxes }, (_, i) => ({
            appIndex: BigInt(app),
            name: new Uint8Array([0x70, i]),
          })),
        }
      : {}),
    ...(o.assets ? { foreignAssets: o.assets } : {}),
    ...(o.accounts ? { accounts: o.accounts.map(addr) } : {}),
  });

const build = (session: algosdk.Transaction[], over: Partial<SwapArgs> = {}) =>
  swap.swapGroup(ctx(), {
    assetIn: 0,
    spend: 1_000_000n,
    assetOut: 10,
    minOut: 1n,
    session,
    routerApp: ROUTER,
    ...over,
  });

/** Every invariant a submittable group has to satisfy, checked together. */
function assertWellFormed(group: algosdk.Transaction[]) {
  for (const [i, t] of group.entries()) {
    const c = t.applicationCall;
    assert.ok(c, `txn ${i} is an application call`);
    const apps = (c.foreignApps ?? []).map((x) => BigInt(x));
    const boxes = c.boxes ?? [];
    const accounts = c.accounts ?? [];
    const refs = apps.length + boxes.length + (c.foreignAssets ?? []).length + accounts.length;

    assert.ok(refs <= MAX_REFS_PER_TXN, `txn ${i} has ${refs} references, limit ${MAX_REFS_PER_TXN}`);
    assert.ok(accounts.length <= 4, `txn ${i} has ${accounts.length} accounts, limit 4`);

    for (const b of boxes) {
      const app = BigInt(b.appIndex);
      assert.ok(
        app === BigInt(PASSPORT) || apps.includes(app),
        `txn ${i} names a box on app ${app} without naming that app`,
      );
    }
    // The encoder is the real judge: it refuses a box whose app is absent.
    assert.doesNotThrow(() => algosdk.encodeUnsignedTransaction(t), `txn ${i} must encode`);
  }
}

test('a single-page route builds one transaction and is not grouped', () => {
  const g = build([leg(ROUTER)]);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.group, undefined, 'a lone transaction must not carry a group id');
  assertWellFormed(g);
});

test('a multi-hop route with pool boxes keeps every box beside its app', () => {
  // THE REGRESSION. Three legs, three boxes each, none of them over its own
  // reference budget — but ten box references in total once `cm` is added, so
  // the packer must spill, and every spilled box still needs its app.
  const g = build([1001, 1002, 1003].map((app) => leg(app, { boxes: 3 })));
  assert.ok(g.length > 1, 'this route must need more than one transaction');
  assertWellFormed(g);
});

test('boxes on many distinct apps stay valid however they spill', () => {
  const g = build([1001, 1002, 1003, 1004].map((app) => leg(app, { boxes: 2, assets: [app] })));
  assertWellFormed(g);
});

test('every app the session touches is named somewhere in the group', () => {
  const session = [1001, 1002, 1003].map((app) => leg(app, { boxes: 2 }));
  const g = build(session);
  const named = new Set(g.flatMap((t) => (t.applicationCall?.foreignApps ?? []).map((x) => BigInt(x))));
  for (const app of [ROUTER, 1001, 1002, 1003]) {
    assert.ok(named.has(BigInt(app)), `app ${app} must be named on the group`);
  }
});

test('every box the session touches appears exactly once', () => {
  const g = build([1001, 1002].map((app) => leg(app, { boxes: 3 })));
  const seen = g.flatMap((t) => (t.applicationCall?.boxes ?? []).map((b) => `${b.appIndex}:${b.name.join(',')}`));
  assert.equal(new Set(seen).size, seen.length, 'no box may be named twice');
  assert.equal(seen.length, 7, 'six pool boxes plus the committed-ledger box');
});

test('the four-account limit is respected across the spill', () => {
  const g = build([leg(1001, { accounts: [2, 3, 4, 5] }), leg(1002, { accounts: [6, 7, 8] })]);
  assertWellFormed(g);
  const total = g.reduce((n, t) => n + (t.applicationCall?.accounts ?? []).length, 0);
  assert.equal(total, 7);
});

test('asset 0 is named at top level and stripped from the replayed blob', () => {
  // The two halves of the same fact: illegal on an inner transaction, required
  // on the outer group.
  const session = [leg(1001, { assets: [0, 10] })];
  const g = build(session);
  const named = g.flatMap((t) => (t.applicationCall?.foreignAssets ?? []).map((x) => BigInt(x)));
  assert.ok(named.includes(0n), 'asset 0 must be named at top level');

  // Stripping is proven by equivalence: a leg declaring [0, 10] must pack to
  // exactly the same bytes as one declaring [10], because asset 0 is illegal on
  // the inner transaction the blob becomes.
  const withAlgo = swap.packSession([leg(1001, { assets: [0, 10] })]);
  const without = swap.packSession([leg(1001, { assets: [10] })]);
  assert.deepEqual(withAlgo, without, 'asset 0 must not survive into the blob');

  const res = swap.sessionResources(ctx(), {
    session,
    assetIn: 0,
    assetOut: 10,
    routerApp: ROUTER,
  });
  assert.ok(res.assets.includes(0n), 'resources lift asset 0 back out to the group');
});

test('the fee covers every outer transaction and every inner one', () => {
  const session = [1001, 1002, 1003].map((app) => leg(app, { boxes: 3 }));
  const g = build(session);
  const total = g.reduce((n, t) => n + Number(t.fee), 0);
  assert.equal(total, 1000 * (g.length + session.length));
  for (const t of g.slice(1)) assert.equal(Number(t.fee), 0, 'pings ride on the head fee');
});

test('inputs the contract would refuse are refused here', () => {
  assert.throws(() => build([leg(ROUTER)], { assetOut: 0 }), /must differ/);
  assert.throws(() => build([leg(ROUTER)], { spend: 0n }), /spend must be positive/);
  assert.throws(() => build([leg(ROUTER)], { minOut: 0n }), /minOut must be positive/);
  assert.throws(() => build([]), /session is empty/);
  assert.throws(
    () => build(Array.from({ length: 9 }, () => leg(ROUTER))),
    /too long to replay/,
  );
});
