/**
 * Switching a passport to a new router, and the read that decides whether to
 * offer it.
 *
 * The passport contract does not change for a router migration: the owner
 * adopts a directory and takes the ids it publishes, and every later crank and
 * owner swap uses them. Two things can go wrong from here, and both are quiet.
 *
 * ORDER. `sync_contracts` reads the directory the passport has, so setting it
 * second would sync from the OLD one and leave the router unchanged, with both
 * transactions succeeding.
 *
 * WHICH IDS. The foreign apps on the sync must be the NEW directory's router and
 * budget — the passport resolves each app's address to prove it exists. Passing
 * the currently cached ids names the app being replaced, and fails as
 * `unavailable App`, which reads like a contract fault and is not.
 *
 * The node here is a stub: these are pure builders and a comparison, and neither
 * needs a chain.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { directory, manage, abi } from '../dist/index.js';
import { PASSPORT, addr, ctx, hex } from './helpers.ts';

const DIRECTORY = 4242;
const NEW_ROUTER = 3687031461;
const NEW_BUDGET = 7777;
const OLD_ROUTER = 3586571385;
const OLD_BUDGET = 6666;

const args = (t: algosdk.Transaction) => (t.applicationCall?.appArgs ?? []).map(hex);
const apps = (t: algosdk.Transaction) => (t.applicationCall?.foreignApps ?? []).map(Number);
const u64hex = (n: number | bigint): string => BigInt(n).toString(16).padStart(16, '0');

/** A node that serves exactly two apps: a passport's globals and a directory's. */
const stubNode = (o: { router: number; budget: number; pubRouter: number; pubBudget: number }) => {
  const enc = new TextEncoder();
  const uint = (key: string, v: number) => ({ key: enc.encode(key), value: { type: 2, uint: BigInt(v), bytes: new Uint8Array() } });
  const bytes = (key: string, v: Uint8Array) => ({ key: enc.encode(key), value: { type: 1, uint: 0n, bytes: v } });
  const state: Record<string, unknown[]> = {
    [String(PASSPORT)]: [
      bytes('owner', algosdk.decodeAddress(addr(9)).publicKey),
      uint('registry', 1),
      uint('version', 1_001_002),
      uint('directory', DIRECTORY),
      uint('router_app_id', o.router),
      uint('budget_app_id', o.budget),
    ],
    [String(DIRECTORY)]: [uint('router', o.pubRouter), uint('budget', o.pubBudget)],
  };
  return {
    getApplicationByID: (id: bigint) => ({
      do: async () => ({ params: { globalState: state[String(id)] ?? [] } }),
    }),
  } as unknown as algosdk.Algodv2;
};

test('switchDirectory is one group: set the directory, then sync from it', () => {
  const g = manage.switchDirectory(ctx, { directory: DIRECTORY, router: NEW_ROUTER, budget: NEW_BUDGET });
  assert.equal(g.length, 2);
  assert.equal(args(g[0]!)[0], hex(abi.PASSPORT.set_directory.getSelector()));
  assert.equal(args(g[0]!)[1], u64hex(DIRECTORY), 'the directory being adopted');
  assert.equal(args(g[1]!)[0], hex(abi.PASSPORT.sync_contracts.getSelector()));
  // Grouped, so neither half can land alone: a set without a sync leaves the
  // passport pointing at a directory whose ids it has not taken.
  assert.ok(g[0]!.group && g[1]!.group, 'both carry a group id');
  assert.deepEqual(g[0]!.group, g[1]!.group);
});

test('the sync names the NEW directory\'s router and budget as foreign apps', () => {
  const g = manage.switchDirectory(ctx, { directory: DIRECTORY, router: NEW_ROUTER, budget: NEW_BUDGET });
  assert.deepEqual(apps(g[1]!), [DIRECTORY, NEW_ROUTER, NEW_BUDGET]);
  assert.ok(!apps(g[1]!).includes(OLD_ROUTER), 'never the id being replaced');
  for (const t of g) assert.doesNotThrow(() => algosdk.encodeUnsignedTransaction(t));
});

test('pendingContracts: offer the switch only when the directory publishes something new', async () => {
  const moved = await directory.pendingContracts(
    stubNode({ router: OLD_ROUTER, budget: OLD_BUDGET, pubRouter: NEW_ROUTER, pubBudget: NEW_BUDGET }),
    PASSPORT,
    DIRECTORY,
  );
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.cached, { router: BigInt(OLD_ROUTER), budget: BigInt(OLD_BUDGET) });
  assert.deepEqual(moved.published, { router: BigInt(NEW_ROUTER), budget: BigInt(NEW_BUDGET) });

  const settled = await directory.pendingContracts(
    stubNode({ router: NEW_ROUTER, budget: NEW_BUDGET, pubRouter: NEW_ROUTER, pubBudget: NEW_BUDGET }),
    PASSPORT,
    DIRECTORY,
  );
  assert.equal(settled.changed, false, 'a passport already on the published ids has nothing to accept');

  // The budget app moves on its own sometimes; that is still a switch to offer.
  const budgetOnly = await directory.pendingContracts(
    stubNode({ router: NEW_ROUTER, budget: OLD_BUDGET, pubRouter: NEW_ROUTER, pubBudget: NEW_BUDGET }),
    PASSPORT,
    DIRECTORY,
  );
  assert.equal(budgetOnly.changed, true);
});
