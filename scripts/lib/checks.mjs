/**
 * The live checks, shared by `live-check.mjs` (a registry's acceptance run) and
 * `check.mjs` (your own passport and routes).
 *
 * READS ONLY. Every check here reads chain state or SIMULATES an unsigned group;
 * nothing signs, submits, or needs an account or a key. Each takes a reporter
 * from `reporter()` so one run's failures are counted once, whichever script ran.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import algosdk from 'algosdk';
import {
  entitlement,
  programs,
  read,
  simulate,
  swap,
  upgradeGroup,
  version as version_,
} from '../../dist/index.js';

// ── reporting ───────────────────────────────────────────────────────────────

export function reporter() {
  let failures = 0;
  return {
    check(ok, msg) {
      if (!ok) failures++;
      console.log(`    ${ok ? 'OK  ' : 'FAIL'} ${msg}`);
    },
    note(msg) {
      console.log(`    --   ${msg}`);
    },
    fail(msg) {
      failures++;
      console.log(`    FAIL ${msg}`);
    },
    get failures() {
      return failures;
    },
  };
}

export const header = (title) => console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`);

export function finish(r) {
  console.log(r.failures === 0 ? '\nALL CHECKS PASSED' : `\n${r.failures} CHECK(S) FAILED`);
  process.exit(r.failures === 0 ? 0 : 1);
}

// ── a registry ──────────────────────────────────────────────────────────────

/**
 * The registry program the box-reference tests were derived FROM.
 *
 * test/create.test.ts asserts the exact boxes each registry entry point needs.
 * Those sets were read out of the contract — `_ceiling`, `_entitled`,
 * `create_entry`, `link_passport`, `verify_update` — rather than inferred from
 * behaviour, which is what makes them exact. It is also what makes them STALE the
 * instant the registry's program changes.
 *
 * PIN THE HASH, NOT THE DATE. A deployed program can be replaced, so "unchanged
 * since we last looked" is a fact about the past rather than a promise about next
 * week. When it moves, the reference sets have to be re-read from the new build
 * before any test asserting them can be believed again.
 */
export const REGISTRY_PROGRAM = {
  sha256: '919242f451c0877b533713844d00451d9e3213e7f63a54f20f2ba43f6d8bf8f6',
  bytes: 2856,
};

/** The production registry: the default target when nothing else is configured. */
export const PRODUCTION_REGISTRY = { id: '3672932347', expect: 'line', label: 'PRODUCTION' };

/** A well-formed address that will not have a `w` box: the stable cohort. */
const STABLE_PROBE = algosdk.encodeAddress(new Uint8Array(32));

const GLOBALS = ['latest_major', 'latest_version', 'beta_line', 'stable_version', 'min_major', 'crank_txn_budget'];

const u = (g, k) => (typeof g[k] === 'bigint' ? g[k] : undefined);

/**
 * An allowlisted address on this registry, or null.
 *
 * ONE BOUNDED REQUEST, NEVER A WALK. `max` is not a page size — algod refuses the
 * whole call with a 400 when the app holds more boxes than that — so this either
 * sees every box or declines. A registry gains two boxes per passport ever
 * created, and scanning one to find a test address is the cost this SDK exists to
 * avoid. A large registry skips the check instead.
 */
async function discoverAllowlisted(algod, id) {
  try {
    const page = await algod.getApplicationBoxes(BigInt(id)).max(64).do();
    const w = page.boxes.find((b) => b.name.length === 33 && b.name[0] === 0x77 /* w */);
    return w ? algosdk.encodeAddress(w.name.subarray(1)) : null;
  } catch {
    return null; // too many boxes to enumerate safely, or the node refused
  }
}

/**
 * One registry: its globals, whether its program is still the pinned build, what
 * each cohort resolves to (cross-checked against the raw globals rather than the
 * SDK's own derivation, so this cannot agree with a bug by sharing it), whether
 * every version it serves maps to a bundled build, and whether its two tiers get
 * different bytes. Returns a coverage row.
 */
export async function checkRegistry(algod, r, { id, expect, label, note: why }) {
  const name = label ?? `REGISTRY ${id}`;
  header(`${name}  app ${id}`);
  if (why) r.note(why);

  let g;
  try {
    g = await read.globals(algod, BigInt(id));
  } catch (e) {
    r.fail(`UNREACHABLE: ${e.message}`);
    return { label: name, shape: undefined, tierSplit: undefined };
  }

  console.log('  globals:');
  for (const k of GLOBALS) {
    const v = u(g, k);
    console.log(`    ${k.padEnd(17)} ${v === undefined ? '(absent)' : v}`);
  }

  try {
    const info = await algod.getApplicationByID(BigInt(id)).do();
    const program = info.params?.approvalProgram ?? new Uint8Array();
    const sha = createHash('sha256').update(program).digest('hex');
    if (sha === REGISTRY_PROGRAM.sha256) {
      r.check(true, `registry program matches the pinned build (${program.length} B)`);
    } else {
      r.check(false, 'registry program CHANGED — no longer the pinned build');
      r.note(`deployed ${program.length} B sha256 ${sha}`);
      r.note('the box-reference sets in test/create.test.ts were read from that source');
      r.note('and must be re-read before they can be trusted again');
    }
  } catch (err) {
    r.fail(`could not read the registry program: ${err.message}`);
  }

  const shape = entitlement.detectShape(g);
  const mgr = g['manager'];
  const manager = mgr instanceof Uint8Array ? algosdk.encodeAddress(mgr) : null;
  console.log(`  detected shape:    ${shape}`);
  console.log(`  manager:           ${manager ?? '(none)'}`);
  if (expect) {
    // A mismatch almost always means the registry moved, not that the SDK is
    // wrong — so say so, and still stop CI.
    r.check(
      shape === expect,
      shape === expect
        ? `shape is ${expect} as expected`
        : `shape is ${shape}, expected ${expect} — this registry CHANGED SHAPE since the ` +
            'expectation was written. Update it in your config if intended.',
    );
  }

  const resolved = {};
  for (const [key, who, addr] of [
    ['beta', 'manager (beta, no w box)', manager],
    ['stable', 'unallowlisted (stable)', STABLE_PROBE],
  ]) {
    if (!addr) continue;
    let e;
    try {
      e = await read.entitled(algod, BigInt(id), addr);
    } catch (err) {
      r.fail(`${who}: ${err.message}`);
      continue;
    }
    resolved[key] = e;
    console.log(
      `  ${who.padEnd(26)} line=${String(e.line).padEnd(7)} version=${String(e.version).padEnd(10)} beta=${String(e.beta).padEnd(5)} migrated=${e.migrated}`,
    );
    if (e.beta) {
      const k = shape === 'line' ? 'beta_line' : 'latest_major';
      r.check(e.line === Number(u(g, k)), `beta line follows ${k} (${u(g, k)})`);
    } else {
      const sv = u(g, 'stable_version') ?? 0n;
      r.check(e.version === sv, `stable pinned to stable_version exactly (${sv})`);
      const want = Number(sv / (shape === 'line' ? 1000n : 1_000_000n));
      r.check(e.line === want, `stable line derived from the version (${want})`);
    }
  }

  // THE TWO BETA PATHS MUST AGREE. The manager short-circuits before the box
  // lookup; an allowlisted address goes through it. Same tier, so same answer.
  const allowlisted = await discoverAllowlisted(algod, id);
  if (allowlisted && resolved.beta) {
    try {
      const e = await read.entitled(algod, BigInt(id), allowlisted);
      console.log(
        `  ${'allowlisted (w box)'.padEnd(26)} line=${String(e.line).padEnd(7)} version=${String(e.version).padEnd(10)} beta=${String(e.beta).padEnd(5)} ${allowlisted.slice(0, 8)}…`,
      );
      r.check(e.beta === true, 'a w box puts an address on the beta tier');
      r.check(
        e.line === resolved.beta.line && e.version === resolved.beta.version,
        'allowlisted and manager beta paths resolve identically',
      );
    } catch (err) {
      r.fail(`allowlisted (w box): ${err.message}`);
    }
  } else {
    r.note('no w box within reach: beta here is only the manager short-circuit');
  }

  // Every version this registry points at must map to bundled bytes.
  console.log('  bundled build for each live version:');
  const builds = {};
  for (const [key, e] of Object.entries(resolved)) {
    if (!e.version) continue;
    try {
      const b = await programs.buildForVersion(algod, BigInt(id), e.version);
      builds[key] = b;
      r.check(true, `${key.padEnd(6)} v${String(e.version).padEnd(9)} -> ${b.label} (${b.approval.length} B)`);
      // The label names the BYTES, which can serve several versions once a line
      // reaches parity — correct about the program, wrong to show an owner.
      if (b.label.split('@')[1] !== version_.format(e.version).slice(1)) {
        r.note(`  ^ label names the BUILD, not the version: this owner runs ${version_.format(e.version)}`);
      }
    } catch (err) {
      r.check(false, `${key.padEnd(6)} v${String(e.version).padEnd(9)} -> ${err.message.slice(0, 110)}`);
    }
  }

  // The SHIPPED coverage() must agree with what was just worked out by hand:
  // consumers call that function, so a parallel implementation proves nothing.
  try {
    const cov = await programs.coverage(algod, BigInt(id));
    r.check(cov.ok, 'programs.coverage: the bundle serves every reachable version');
    const byHand = Object.entries(resolved)
      .filter(([, e]) => e.version > 0n)
      .map(([tier, e]) => `${tier}:${e.version}`)
      .sort()
      .join(' ');
    const shipped = cov.entries.map((e) => `${e.tier}:${e.version}`).sort().join(' ');
    r.check(byHand === shipped, `programs.coverage agrees with this check (${shipped})`);
  } catch (err) {
    r.fail(`programs.coverage threw: ${err.message}`);
  }

  // Coverage, not correctness: does this registry give the tiers different bytes?
  const tierSplit = builds.beta && builds.stable ? builds.beta.pageHash !== builds.stable.pageHash : undefined;
  if (tierSplit === true) r.note(`tier split EXERCISED: stable=${builds.stable.tier}, beta=${builds.beta.tier}`);
  else if (tierSplit === false) r.note(`tier split NOT exercised: both cohorts get ${builds.beta.label}`);
  return { label: name, shape, tierSplit };
}

export function printCoverage(coverage) {
  header('COVERAGE');
  console.log(`  ${'registry'.padEnd(26)} ${'shape'.padEnd(8)} tier split`);
  for (const c of coverage) {
    console.log(
      `  ${c.label.padEnd(26)} ${String(c.shape).padEnd(8)} ${c.tierSplit === undefined ? '?' : c.tierSplit ? 'yes' : 'no'}`,
    );
  }
  if (!coverage.some((c) => c.shape === 'major')) {
    console.log('  no target is major-keyed: the pre-migration path is unit-tested only');
  }
  console.log(
    coverage.some((c) => c.shape === 'line' && c.tierSplit)
      ? '  a line-keyed registry with distinct tier bytes is covered'
      : '  NOT COVERED: no line-keyed registry here gives its tiers different bytes',
  );
}

// ── an owner's entitlement ──────────────────────────────────────────────────

/** What `owner` is entitled to on `registry`, and whether this SDK carries those bytes. */
export async function checkEntitlement(algod, r, { registry, owner }) {
  header(`ENTITLEMENT  ${owner.slice(0, 8)}… on registry ${registry}`);
  const e = await read.entitled(algod, BigInt(registry), owner);
  console.log(`  line ${e.line}  version ${version_.format(e.version)}  beta=${e.beta}  migrated=${e.migrated}`);
  try {
    const b = await programs.buildForVersion(algod, BigInt(registry), e.version);
    r.check(true, `this SDK carries the bytes for ${version_.format(e.version)} (${b.label}); ` +
      `open_strategy accepts rule types ${b.ruleTypes.join(', ')}`);
  } catch (err) {
    r.check(false, `no bundled build for ${version_.format(e.version)} — this SDK is older than it: ${err.message.slice(0, 90)}`);
  }
}

// ── a passport's upgrade ────────────────────────────────────────────────────

/**
 * WOULD AN UPGRADE GET PAST THE LEDGER? The upgrade group for this passport is
 * built exactly as a front end would build it and SIMULATED — unsigned, nothing
 * submitted. What this catches is the class of defect a unit test cannot see: a
 * transaction whose shape is wrong only on the wire and only on the ledger's
 * size-change path (0.3.0 omitted the state schema, which that path reads as
 * "change to 0/0").
 *
 * It targets what the owner is ENTITLED to, with the bytes the registry expects
 * for it. A passport already on its entitlement gets a synthetic probe one past
 * its version instead: that stops at the registry by design and exercises only
 * the ledger path. A stop at the passport — schema, pages, fee, budget, balance —
 * is a failure either way; a stop at the registry is policy, reported not failed.
 */
export async function rehearseUpgrade(algod, r, id) {
  header(`UPGRADE REHEARSAL  passport ${id}`);
  const st = await read.passportState(algod, BigInt(id));
  const params = await read.appParams(algod, BigInt(id));
  const e = await read.entitled(algod, st.registry, st.owner);
  const real = e.version > st.version;
  const target = real ? e.version : st.version + 1n;
  const build = real
    ? await programs.buildForVersion(algod, st.registry, e.version)
    : programs.ALL_BUILDS.reduce((a, b) => (b.approval.length > a.approval.length ? b : a));
  const cost = await read.upgradeCost(algod, BigInt(id), build);
  console.log(`  runs ${version_.format(st.version)}  owner ${st.owner.slice(0, 8)}…  line ${e.line}  entitled to ${version_.format(e.version)}  pages ${params.extraPages}  schema ${params.schema.globalInts}/${params.schema.globalBytes}`);
  console.log(`  ${real ? 'REAL upgrade' : 'synthetic probe'}: ${build.label} as ${version_.format(target)}, pages -> ${cost.extraPages}, wallet needs ${cost.spendable} spendable`);

  const group = upgradeGroup({
    owner: st.owner,
    registry: st.registry,
    passport: BigInt(id),
    version: target,
    line: e.line,
    approvalProgram: build.approval,
    clearProgram: build.clear,
    params: await algod.getTransactionParams().do(),
    currentExtraPages: params.extraPages,
    schema: params.schema,
  });
  const res = await simulate.simulate(algod, group, { passportAppId: Number(id), build });
  const where = (res.failure.match(/pc=\d+/) ?? ['(no pc)'])[0];
  if (res.ok) {
    r.check(true, real
      ? `the real upgrade to ${version_.format(target)} succeeds end to end — ledger and registry`
      : 'the probe passes the ledger and the registry');
    return;
  }
  if (res.app !== undefined && BigInt(res.app) === st.registry) {
    r.check(true, real
      ? `passes the ledger; the registry declined the entitled version at ${where}`
      : `passes the ledger; stops at the registry as a probe should (${where})`);
    if (real) r.note('a registry policy on an approved version (timelock?), not a defect in the update');
    return;
  }
  r.check(false, `refused before the registry — a defect in the update itself: ${res.failure.split('\n')[0].slice(0, 110)}`);
  if (res.reason) r.note(`passport assert: ${res.reason}`);
}

// ── a swap route ────────────────────────────────────────────────────────────

/**
 * A saved router session: a JSON array of base64 msgpack transactions, an array
 * of `{ msgpack_b64 }`, or a capture (`{ session: [...] }`) — whichever a front
 * end or `--save` produced.
 */
export function loadSession(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw.session;
  if (!Array.isArray(list) || !list.length) throw new Error(`${file}: no session transactions`);
  return list.map((x) =>
    algosdk.decodeUnsignedTransaction(Buffer.from(typeof x === 'string' ? x : x.msgpack_b64, 'base64')),
  );
}

const b64 = (t) => Buffer.from(algosdk.encodeUnsignedTransaction(t)).toString('base64');

/** Group-level and per-transaction unnamed resources, merged, as plain JSON. */
async function unnamedResources(algod, group) {
  const req = new algosdk.modelsv2.SimulateRequest({
    txnGroups: [new algosdk.modelsv2.SimulateRequestTransactionGroup({
      txns: group.map((txn) => new algosdk.SignedTransaction({ txn })),
    })],
    allowEmptySignatures: true,
    fixSigners: true,
    allowUnnamedResources: true,
  });
  const res = await algod.simulateTransactions(req).do();
  const g = res.txnGroups[0];
  const all = [g?.unnamedResourcesAccessed, ...(g?.txnResults ?? []).map((t) => t.unnamedResourcesAccessed)].filter(Boolean);
  const key = (o) => JSON.stringify(o);
  const uniq = (xs) => [...new Map(xs.map((x) => [key(x), x])).values()];
  const s = (v) => String(v);
  return {
    failure: g?.failureMessage ?? '',
    merged: {
      accounts: uniq(all.flatMap((u) => (u.accounts ?? []).map(s))),
      assets: uniq(all.flatMap((u) => (u.assets ?? []).map(s))),
      apps: uniq(all.flatMap((u) => (u.apps ?? []).map(s))),
      assetHoldings: uniq(all.flatMap((u) => (u.assetHoldings ?? []).map((h) => ({ account: s(h.account), asset: s(h.asset) })))),
      appLocals: uniq(all.flatMap((u) => (u.appLocals ?? []).map((l) => ({ account: s(l.account), app: s(l.app) })))),
      boxes: uniq(all.flatMap((u) => (u.boxes ?? []).map((b) => ({ app: s(b.app), name: Buffer.from(b.name).toString('base64') })))),
      extraBoxRefs: all.reduce((n, u) => n + Number(u.extraBoxRefs ?? 0), 0),
    },
  };
}

/**
 * Build a swap from a saved router session and strict-simulate it — the check
 * that no reference the route needs is missing or split from its pair.
 *
 * FAIL is reserved for what the SDK is responsible for: a reference the node
 * reports unavailable, or a fee too small for the call tree. A stale quote
 * ("below min_out"), or a passport with too little FREE balance, stops the
 * simulate too — that is reported, not failed, because it says nothing about
 * the group this SDK built.
 *
 * With `saveDir`, writes a CAPTURE — session, group as built, both simulates —
 * which `scripts/route-fixture.mjs` turns into an anonymized test fixture.
 */
export async function checkSwap(algod, r, { passport, route, dir, saveDir, sdkVersion }) {
  const name = route.name ?? `${route.assetIn}-${route.assetOut}`;
  header(`SWAP ${name}  passport ${passport}`);
  const st = await read.passportState(algod, BigInt(passport));
  const session = loadSession(path.resolve(dir, route.session));
  const ctx = {
    algod,
    registry: st.registry,
    params: await algod.getTransactionParams().do(),
    owner: st.owner,
    passport: BigInt(passport),
  };
  let group;
  try {
    group = swap.swapGroup(ctx, {
      assetIn: BigInt(route.assetIn),
      spend: BigInt(route.spend),
      assetOut: BigInt(route.assetOut),
      minOut: BigInt(route.minOut ?? 1),
      session,
      routerApp: st.routerAppId,
    });
  } catch (err) {
    r.fail(`swapGroup refused the route: ${err.message}`);
    return;
  }
  console.log(`  ${session.length} session txns -> ${group.length} outer, head fee ${group[0].fee} µAlgo, router ${st.routerAppId}`);

  const strict = await simulate.simulate(algod, group, { passportAppId: Number(passport) });
  const loose = await unnamedResources(algod, group);
  const m = loose.merged;
  const missing = [
    ...m.assetHoldings.map((h) => `holding ${h.account.slice(0, 8)}…+${h.asset}`),
    ...m.appLocals.map((l) => `local ${l.account.slice(0, 8)}… in ${l.app}`),
    ...m.accounts.map((a) => `account ${a.slice(0, 8)}…`),
    ...m.assets.map((a) => `asset ${a}`),
    ...m.apps.map((a) => `app ${a}`),
    ...m.boxes.map((b) => `box on ${b.app}`),
  ];
  const first = strict.failure.replace(/transaction \w+: /, '').split('\n')[0].slice(0, 140);

  if (strict.ok) {
    r.check(true, 'strict simulate: CLEAN — every resource the route touches is named where it is needed');
  } else if (/unavailable|group fee too small|fee too small/i.test(strict.failure)) {
    r.check(false, `strict simulate: ${first}`);
  } else {
    r.note(`strict simulate stopped on something other than this group's shape: ${first}`);
    r.note('a stale quote or too little FREE balance does this; references were not the cause');
  }
  if (missing.length) r.check(false, `resources used but not named together: ${missing.join(', ')}`);
  else r.check(true, 'no unnamed resources used');

  if (saveDir) {
    fs.mkdirSync(saveDir, { recursive: true });
    const file = path.join(saveDir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({
      captured: new Date().toISOString(),
      sdk: sdkVersion,
      note: 'READ-ONLY capture: nothing signed or sent. Keep out of the repo; convert with scripts/route-fixture.mjs.',
      passport: String(passport),
      owner: st.owner,
      routerAppId: String(st.routerAppId),
      session: session.map((t) => ({ msgpack_b64: b64(t) })),
      group_as_built: group.map((t) => ({ msgpack_b64: b64(t) })),
      simulate_strict: { failure: strict.failure },
      simulate_unnamed_allowed: { failure: loose.failure, merged: m },
    }, null, 2) + '\n');
    r.note(`capture saved: ${file}`);
  }
}
