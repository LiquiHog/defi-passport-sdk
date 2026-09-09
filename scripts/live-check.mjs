/**
 * The acceptance run: ONE SDK build against EVERY registry shape.
 *
 *   npm run live-check
 *   node scripts/live-check.mjs [--url <algod>] [<app-id>[:line|major] ...]
 *
 * READS ONLY. Nothing here signs, submits, or needs an account or a key.
 *
 * Three questions, and the last two are the ones a unit test cannot reach.
 *
 * WHICH VERSION DOES EACH COHORT RESOLVE TO? A line is a major before the step-0
 * migration and `major * 1000 + minor` after it, and one build has to answer
 * correctly on either side. Every answer is cross-checked against the raw globals
 * rather than against the SDK's own derivation, so this cannot agree with a bug by
 * sharing it.
 *
 * DOES EVERY LIVE VERSION STILL RESOLVE TO A BUNDLED BUILD? An approved version
 * can never be un-approved, so old versions stay installable for as long as any
 * owner has not upgraded. If `buildForVersion` throws here, this SDK cannot create
 * or upgrade a passport on that registry at all — total inoperability rather than
 * a wrong message, and no unit test or map comparison surfaces it.
 *
 * DOES THE REGISTRY EXERCISE THE TIER SPLIT? The two cohorts should receive
 * DIFFERENT programs: restricted for the public, full for beta. A registry that
 * approved the same bytes under both versions still behaves correctly and still
 * passes — but it is not testing that the tiers get different bytes, so this is
 * reported as coverage rather than scored as a failure.
 *
 * DO BOTH BETA PATHS AGREE? An address reaches the beta tier two ways: a `w`
 * allowlist box, or being the manager, which `_entitled` short-circuits before it
 * ever looks for a box. They must resolve identically. Only a registry with a real
 * allowlist entry can show that, and the address is discovered rather than
 * configured, so nothing here goes stale when a fixture is rebuilt.
 *
 * The coverage that matters is a registry where the tier split AND the line-keyed
 * shape hold at once, because that is what production looks like after step 1.
 * Add its id as an argument once one exists.
 */
import algosdk from 'algosdk';
import { entitlement, programs, read, version as version_ } from '../dist/index.js';

const NAMED = {
  '3690557533': 'FIXTURE (dedicated, step-0)',
  '3683706562': 'FIXTURE (suite-managed)',
  '3672932347': 'PRODUCTION',
};

const DEFAULT_TARGETS = [
  // The one that matters: line-keyed AND the tiers carry different bytes, which
  // is what production becomes after step 1. Nothing else covers both at once.
  { id: '3690557533', expect: 'line' },
  { id: '3683706562', expect: 'line' },
  // Production completed step 0. Nothing live is major-keyed any more, which is
  // why the pre-migration path now has no exercise outside the unit suite.
  { id: '3672932347', expect: 'line' },
];

function parse(argv) {
  let url = 'https://mainnet-api.algonode.cloud';
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') {
      url = argv[++i];
      continue;
    }
    const [id, expect] = argv[i].split(':');
    targets.push({ id, ...(expect ? { expect } : {}) });
  }
  return { url, targets: targets.length ? targets : DEFAULT_TARGETS };
}

const { url, targets } = parse(process.argv.slice(2));
const algod = new algosdk.Algodv2('', url, '');

/** A well-formed address that will not have a `w` box: the stable cohort. */
const STABLE_PROBE = algosdk.encodeAddress(new Uint8Array(32));

const GLOBALS = [
  'latest_major',
  'latest_version',
  'beta_line',
  'stable_version',
  'min_major',
  'crank_txn_budget',
];

const u = (g, k) => (typeof g[k] === 'bigint' ? g[k] : undefined);

let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`    ${ok ? 'OK  ' : 'FAIL'} ${msg}`);
};
const note = (msg) => console.log(`    --   ${msg}`);

const coverage = [];

/**
 * An allowlisted address on this registry, or null.
 *
 * ONE BOUNDED REQUEST, NEVER A WALK. `max` is not a page size — algod refuses the
 * whole call with a 400 when the app holds more boxes than that — so this either
 * sees every box or declines. Which is the behaviour wanted: a registry gains two
 * boxes per passport ever created, and scanning one to find a test address is the
 * cost this SDK exists to avoid. A large registry skips the check instead.
 */
async function discoverAllowlisted(id) {
  try {
    const page = await algod.getApplicationBoxes(BigInt(id)).max(64).do();
    const w = page.boxes.find((b) => b.name.length === 33 && b.name[0] === 0x77 /* w */);
    return w ? algosdk.encodeAddress(w.name.subarray(1)) : null;
  } catch {
    return null; // too many boxes to enumerate safely, or the node refused
  }
}

async function report({ id, expect }) {
  const label = NAMED[id] ?? `REGISTRY ${id}`;
  console.log(`\n${'='.repeat(74)}\n${label}  app ${id}\n${'='.repeat(74)}`);

  let g;
  try {
    g = await read.globals(algod, BigInt(id));
  } catch (e) {
    failures++;
    console.log(`  UNREACHABLE: ${e.message}`);
    return;
  }

  console.log('  globals:');
  for (const k of GLOBALS) {
    const v = u(g, k);
    console.log(`    ${k.padEnd(17)} ${v === undefined ? '(absent)' : v}`);
  }

  const shape = entitlement.detectShape(g);
  const mgr = g['manager'];
  const manager = mgr instanceof Uint8Array ? algosdk.encodeAddress(mgr) : null;
  console.log(`  detected shape:    ${shape}`);
  console.log(`  manager:           ${manager ?? '(none)'}`);
  if (expect) {
    if (shape === expect) {
      check(true, `shape is ${expect} as expected`);
    } else {
      // Still a failure, because CI should stop — but the cause is almost always
      // that the registry moved, not that the SDK is wrong. Say so.
      check(
        false,
        `shape is ${shape}, expected ${expect} — this registry CHANGED SHAPE since ` +
          `the expectation was written. Update it in DEFAULT_TARGETS if intended.`,
      );
    }
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
      failures++;
      console.log(`  ${who.padEnd(26)} THREW: ${err.message}`);
      continue;
    }
    resolved[key] = e;
    console.log(
      `  ${who.padEnd(26)} line=${String(e.line).padEnd(7)} version=${String(e.version).padEnd(10)} beta=${String(e.beta).padEnd(5)} migrated=${e.migrated}`,
    );
    if (e.beta) {
      const k = shape === 'line' ? 'beta_line' : 'latest_major';
      check(e.line === Number(u(g, k)), `beta line follows ${k} (${u(g, k)})`);
    } else {
      const sv = u(g, 'stable_version') ?? 0n;
      check(e.version === sv, `stable pinned to stable_version exactly (${sv})`);
      const want = Number(sv / (shape === 'line' ? 1000n : 1_000_000n));
      check(e.line === want, `stable line derived from the version (${want})`);
    }
  }

  // THE TWO BETA PATHS MUST AGREE. The manager short-circuits before the box
  // lookup; an allowlisted address goes through it. Same tier, so same answer.
  const allowlisted = await discoverAllowlisted(id);
  if (allowlisted && resolved.beta) {
    try {
      const e = await read.entitled(algod, BigInt(id), allowlisted);
      console.log(
        `  ${"allowlisted (w box)".padEnd(26)} line=${String(e.line).padEnd(7)} version=${String(e.version).padEnd(10)} beta=${String(e.beta).padEnd(5)} ${allowlisted.slice(0, 8)}…`,
      );
      check(e.beta === true, 'a w box puts an address on the beta tier');
      check(
        e.line === resolved.beta.line && e.version === resolved.beta.version,
        'allowlisted and manager beta paths resolve identically',
      );
    } catch (err) {
      failures++;
      console.log(`  allowlisted (w box)        THREW: ${err.message}`);
    }
  } else {
    note('no w box within reach: beta here is only the manager short-circuit');
  }

  // Every version this registry points at must map to bundled bytes.
  console.log('  bundled build for each live version:');
  const builds = {};
  for (const [key, version] of Object.entries(resolved).map(([k, e]) => [k, e.version])) {
    if (!version) continue;
    try {
      const b = await programs.buildForVersion(algod, BigInt(id), version);
      builds[key] = b;
      check(true, `${key.padEnd(6)} v${String(version).padEnd(9)} -> ${b.label} (${b.approval.length} B)`);
      // The label names the BYTES. Once a line reaches parity the same program
      // serves several versions, and the label keeps the name it was cut under —
      // correct about the program, wrong as a thing to show an owner.
      const named = b.label.split('@')[1];
      if (named !== version_.format(version).slice(1)) {
        note(`  ^ label names the BUILD, not the version: this owner runs ${version_.format(version)}`);
      }
    } catch (err) {
      check(false, `${key.padEnd(6)} v${String(version).padEnd(9)} -> ${err.message.slice(0, 110)}`);
    }
  }

  // The SHIPPED coverage() must agree with what this script just worked out by
  // hand. Checking them against each other is the point: consumers call that
  // function, so verifying a parallel implementation here would prove nothing
  // about what they get.
  try {
    const cov = await programs.coverage(algod, BigInt(id));
    check(cov.ok, 'programs.coverage: the bundle serves every reachable version');
    const byHand = Object.entries(resolved)
      .filter(([, e]) => e.version > 0n)
      .map(([tier, e]) => `${tier}:${e.version}`)
      .sort()
      .join(' ');
    const shipped = cov.entries.map((e) => `${e.tier}:${e.version}`).sort().join(' ');
    check(byHand === shipped, `programs.coverage agrees with this script (${shipped})`);
  } catch (err) {
    failures++;
    console.log(`    FAIL programs.coverage threw: ${err.message}`);
  }

  // Coverage, not correctness: does this registry give the tiers different bytes?
  const tierSplit =
    builds.beta && builds.stable ? builds.beta.pageHash !== builds.stable.pageHash : undefined;
  if (tierSplit === true) {
    note(`tier split EXERCISED: stable=${builds.stable.tier}, beta=${builds.beta.tier}`);
  } else if (tierSplit === false) {
    note(`tier split NOT exercised: both cohorts get ${builds.beta.label}`);
  }
  coverage.push({ label, shape, tierSplit });
}

console.log(`algod: ${url}`);
for (const t of targets) await report(t);

console.log(`\n${'='.repeat(74)}\nCOVERAGE\n${'='.repeat(74)}`);
console.log(`  ${'registry'.padEnd(26)} ${'shape'.padEnd(8)} tier split`);
for (const c of coverage) {
  console.log(
    `  ${c.label.padEnd(26)} ${String(c.shape).padEnd(8)} ${c.tierSplit === undefined ? '?' : c.tierSplit ? 'yes' : 'no'}`,
  );
}
if (!coverage.some((c) => c.shape === 'major')) {
  console.log('  no target is major-keyed: the pre-migration path is unit-tested only');
}
const both = coverage.some((c) => c.shape === 'line' && c.tierSplit);
console.log(
  both
    ? '  a line-keyed registry with distinct tier bytes is covered'
    : '  NOT COVERED: no line-keyed registry gives the tiers different bytes —\n' +
      '  which is exactly what production becomes after step 1',
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
