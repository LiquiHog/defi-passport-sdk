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
import type { SwapArgs } from '../dist/swap.js';
import { PARAMS, PASSPORT, addr, ctx } from './helpers.ts';

const ROUTER = 999;

/**
 * A session leg calling `app`: reads `boxes` of its own app, touches `assets`,
 * names `accounts` and pool `apps`, and is quoted at `fee`.
 */
const leg = (
  app: number,
  o: { boxes?: number; assets?: number[]; accounts?: number[]; apps?: number[]; fee?: bigint } = {},
) =>
  algosdk.makeApplicationNoOpTxnFromObject({
    sender: addr(1),
    appIndex: BigInt(app),
    appArgs: [new Uint8Array([1])],
    suggestedParams: o.fee === undefined ? PARAMS : { ...PARAMS, fee: o.fee },
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
    ...(o.apps ? { foreignApps: o.apps } : {}),
  });

const build = (session: algosdk.Transaction[], over: Partial<SwapArgs> = {}) =>
  swap.swapGroup(ctx, {
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
      // An EMPTY reference names nothing and belongs to no app — it exists to
      // buy read budget once an oversized build is bundled. Only a named box
      // needs its app alongside it.
      if (b.name.length === 0) continue;
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

  const res = swap.sessionResources(ctx, {
    session,
    assetIn: 0,
    assetOut: 10,
    routerApp: ROUTER,
  });
  assert.ok(res.assets.includes(0n), 'resources lift asset 0 back out to the group');
});

test('the head pays 1,000 per outer transaction plus each leg\'s QUOTED fee', () => {
  // A router call quoted at 7,000 issues six more of its own; the passport
  // replays it at fee 0, so the head carries what the quote said. A leg quoted
  // at 0 still costs the minimum. Legs all at 1,000 could not tell this formula
  // from "1,000 per transaction", which is how 0.5.1 under-charged real routes.
  const session = [
    leg(1001, { boxes: 3 }),
    leg(1002, { boxes: 3, fee: 7000n }),
    leg(1003, { boxes: 3, fee: 0n }),
  ];
  const g = build(session);
  assert.equal(Number(g[0]!.fee), 1000 * g.length + 1000 + 7000 + 1000);
  for (const t of g.slice(1)) assert.equal(Number(t.fee), 0, 'pings ride on the head fee');
});

test('a leg stays whole, beside the router it calls, however the route spills', () => {
  // A holding needs its account and asset on the SAME outer transaction, and a
  // local read its account beside its app. The router reads its own local state
  // in every pool of a leg, yet nothing in the leg's arrays names the router —
  // it was the CALLED app. So each leg's accounts, pools and assets must share
  // a transaction with it.
  const legs = [
    { accounts: [2, 3], apps: [1001, 1002, 1003], assets: [20, 21] },
    { accounts: [4], apps: [1004, 1005], assets: [21, 22] },
  ];
  const g = build([leg(ROUTER, { boxes: 3 }), ...legs.map((l) => leg(ROUTER, l))]);
  assert.ok(g.length > 1, 'this route must spill');
  assertWellFormed(g);
  for (const l of legs) {
    const home = g.find((t) => {
      const c = t.applicationCall!;
      const apps = (c.foreignApps ?? []).map(Number);
      const assets = (c.foreignAssets ?? []).map(Number);
      const accounts = (c.accounts ?? []).map(String);
      return apps.includes(ROUTER) &&
        l.apps.every((p) => apps.includes(p)) &&
        l.assets.every((a) => assets.includes(a)) &&
        l.accounts.every((n) => accounts.includes(addr(n)));
    });
    assert.ok(home, `the leg with pools ${l.apps.join(',')} must sit whole beside the router`);
  }
});

test('the router sits beside every asset the session names', () => {
  // It reads its own balance of each hop, not only the input and output.
  const g = build([leg(ROUTER, { assets: [20, 21] }), leg(ROUTER, { assets: [22, 23] })]);
  const home = g.find((t) => {
    const c = t.applicationCall!;
    const assets = (c.foreignAssets ?? []).map(Number);
    return (c.foreignApps ?? []).map(Number).includes(ROUTER) &&
      [0, 10, 20, 21, 22, 23].every((a) => assets.includes(a));
  });
  assert.ok(home, 'one outer transaction must carry the router and every session asset');
});

test('a route that needs more than a group holds is refused, not built', () => {
  // Eight full legs sharing nothing: each needs two transactions once its
  // router is added, and a group holds sixteen.
  let n = 10;
  const session = Array.from({ length: 8 }, () =>
    leg(ROUTER, { accounts: [n++, n++, n++, n++], assets: [n++], apps: [n++, n++, n++] }),
  );
  assert.throws(() => build(session), /a group holds 16 — re-quote it with fewer legs/);
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
