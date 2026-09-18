/**
 * Real router sessions, replayed through `swapGroup`.
 *
 * `swap.test.ts` builds synthetic legs, which is right for the reference LIMITS
 * but cannot show which references a real router reads TOGETHER. These can.
 * Every file in `fixtures/routes/` is a real route — its legs' references and
 * quoted fees, and what the node reported when an earlier SDK laid it out —
 * made anonymous by `scripts/route-fixture.mjs`. Add a file there and it is
 * tested here, no code change.
 *
 * What a real route needs, and a naive layout breaks: a holding (an account's
 * balance of an asset) is only available when the account and the asset are on
 * the SAME outer transaction; a local-state read needs its account beside its
 * app; and an app lends its address only to the transaction it is named on.
 * Every pairing a route needs was already side by side on one leg of the quote,
 * with the router as that leg's called app. So the invariant is: no pairing a
 * leg had is taken apart — which covers the router's own local state in each
 * pool, and its balance of every hop asset, as well as the pools'.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { swap } from '../dist/index.js';
import { PARAMS, addr, ctx } from './helpers.ts';

interface Leg {
  type: 'pay' | 'axfer' | 'appl';
  fee: number;
  receiver?: string;
  asset?: string;
  app?: string;
  accounts?: string[];
  apps?: string[];
  assets?: string[];
  boxes?: { app: string; name: string }[];
}
interface Route {
  name: string;
  routerApp: string;
  assetIn: string;
  assetOut: string;
  asBuilt: {
    sdk: string;
    strict: 'fail' | 'clean';
    missing: {
      holdings: { account: string; asset: string }[];
      locals: { account: string; app: string }[];
    };
  };
  session: Leg[];
}

const DIR = new URL('./fixtures/routes/', import.meta.url);
const routes: Route[] = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8')) as Route);

const quoted = (fee: number) => ({ ...PARAMS, fee: BigInt(fee) });

/** The route's legs as transactions. Amounts and args are placeholders: layout ignores them. */
function sessionOf(r: Route): algosdk.Transaction[] {
  return r.session.map((l) => {
    if (l.type === 'pay') {
      return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: addr(1), receiver: l.receiver!, amount: 1n, suggestedParams: quoted(l.fee),
      });
    }
    if (l.type === 'axfer') {
      return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: addr(1), receiver: l.receiver!, assetIndex: BigInt(l.asset!), amount: 1n,
        suggestedParams: quoted(l.fee),
      });
    }
    return algosdk.makeApplicationNoOpTxnFromObject({
      sender: addr(1),
      appIndex: BigInt(l.app!),
      appArgs: [new Uint8Array([1])],
      accounts: l.accounts ?? [],
      foreignApps: (l.apps ?? []).map(Number),
      foreignAssets: (l.assets ?? []).map(Number),
      boxes: (l.boxes ?? []).map((b) => ({
        appIndex: BigInt(b.app),
        name: new Uint8Array(Buffer.from(b.name, 'base64')),
      })),
      suggestedParams: quoted(l.fee),
    });
  });
}

const build = (r: Route) =>
  swap.swapGroup(ctx, {
    assetIn: BigInt(r.assetIn),
    spend: 1n,
    assetOut: BigInt(r.assetOut),
    minOut: 1n,
    session: sessionOf(r),
    routerApp: BigInt(r.routerApp),
  });

const appAddr = (id: bigint | string) => algosdk.getApplicationAddress(BigInt(id)).toString();

/** What each outer transaction makes available, the way the node counts it. */
function together(g: algosdk.Transaction[]) {
  const av = g.map((t) => {
    const c = t.applicationCall!;
    const apps = [BigInt(c.appIndex), ...(c.foreignApps ?? []).map((x) => BigInt(x))];
    return {
      apps: new Set(apps),
      assets: new Set((c.foreignAssets ?? []).map((x) => BigInt(x))),
      accounts: new Set([t.sender.toString(), ...(c.accounts ?? []).map(String), ...apps.map(appAddr)]),
    };
  });
  return {
    // ALGO is an account's balance, not a holding: always available.
    holding: (account: string, asset: bigint) =>
      asset === 0n || av.some((a) => a.accounts.has(account) && a.assets.has(asset)),
    local: (account: string, app: bigint) => av.some((a) => a.accounts.has(account) && a.apps.has(app)),
  };
}

test('route fixtures are present', () => {
  assert.ok(routes.length > 0, 'test/fixtures/routes/ holds no routes — see its README');
});

for (const r of routes) {
  test(`${r.name}: no pairing a leg of the quote had is split across outer transactions`, () => {
    const ok = together(build(r));
    const routerAddr = appAddr(r.routerApp);
    const assets = new Set<bigint>([BigInt(r.assetIn), BigInt(r.assetOut)]);
    for (const l of r.session) {
      if (l.type === 'axfer') assets.add(BigInt(l.asset!));
      if (l.type !== 'appl') continue;
      const legApps = [BigInt(l.app!), ...(l.apps ?? []).map(BigInt)];
      const holders = [...(l.accounts ?? []), ...legApps.map(appAddr)];
      for (const h of holders) {
        for (const a of l.assets ?? []) {
          assets.add(BigInt(a));
          assert.ok(ok.holding(h, BigInt(a)), `holding ${h.slice(0, 8)}… + ${a} split apart`);
        }
        for (const p of legApps) {
          assert.ok(ok.local(h, p), `local ${h.slice(0, 8)}… in ${p} split apart`);
        }
      }
    }
    // The router reads its own balance of every hop, not only its own leg's.
    for (const a of assets) {
      assert.ok(ok.holding(routerAddr, a), `the router's holding of ${a} split apart`);
    }
  });

  if (r.asBuilt.strict === 'fail') {
    test(`${r.name}: what the node reported unavailable under SDK ${r.asBuilt.sdk} is now named together`, () => {
      const ok = together(build(r));
      for (const h of r.asBuilt.missing.holdings) {
        assert.ok(ok.holding(h.account, BigInt(h.asset)), `holding ${h.account.slice(0, 8)}… + ${h.asset}`);
      }
      for (const l of r.asBuilt.missing.locals) {
        assert.ok(ok.local(l.account, BigInt(l.app)), `local ${l.account.slice(0, 8)}… in ${l.app}`);
      }
    });
  }

  test(`${r.name}: the head pays 1,000 per outer transaction plus every leg's quoted fee`, () => {
    const g = build(r);
    const legs = r.session.reduce((n, l) => n + Math.max(l.fee, 1000), 0);
    assert.equal(Number(g[0]!.fee), 1000 * g.length + legs);
    for (const t of g.slice(1)) assert.equal(Number(t.fee), 0, 'pings ride on the head fee');
    for (const t of g) assert.doesNotThrow(() => algosdk.encodeUnsignedTransaction(t));
  });
}
