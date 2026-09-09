/**
 * The entitlement derivation, both registry shapes, no chain.
 *
 * These run against `dist/`, so `npm test` builds first. That is deliberate: it
 * means the tests exercise the emitted module graph — the one consumers import —
 * rather than a bundler's view of `src/`.
 *
 * WHY THIS EXISTS AS A UNIT TEST. The live-fixture check everyone reaches for
 * first — "resolve one address per cohort and confirm it matches the version that
 * passport is already running" — cannot discriminate the likeliest bug. With
 * `min_major` 25 and lines 27000 and 26000, both `line // 1000 >= min_major` and
 * `line >= min_major` return the same answer for every address on the registry.
 * The retirement rule only shows its granularity against a line BELOW the floor,
 * and a healthy registry does not have one to point at. So the boundary is tested
 * here, with synthetic globals, where a retired line can actually be constructed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  betaHeadLine,
  detectShape,
  reachableVersions,
  resolveLine,
  resolveVersion,
  type RegistryShape,
} from '../dist/entitlement.js';

type Globals = Record<string, bigint | Uint8Array>;

/** Globals as algod hands them back: uints are bigint, addresses are bytes. */
const g = (o: Record<string, number | bigint>): Globals =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BigInt(v)]));

/**
 * A migrated registry, mirroring the live test one. Lines are major*1000+minor,
 * and stable is pinned at a real patch rather than a round number — the pin is a
 * VERSION, and rounding it in a fixture hides the division that derives its line.
 */
const MIGRATED = g({
  latest_major: 27,
  latest_version: 27_000_000,
  beta_line: 27_000,
  stable_version: 26_000_001,
  min_major: 25,
});

/** The same registry before step 0: no `beta_line`, lines are bare majors. */
const LEGACY = g({
  latest_major: 27,
  latest_version: 27_000_000,
  stable_version: 26_000_000,
  min_major: 25,
});

const MANAGER = { isManager: true, hasBetaBox: false };
const ALLOWLISTED = { isManager: false, hasBetaBox: true };
const PUBLIC = { isManager: false, hasBetaBox: false };

test('detectShape keys off beta_line, which only a migrated registry has', () => {
  assert.equal(detectShape(MIGRATED), 'line');
  assert.equal(detectShape(LEGACY), 'major');
  // `latest_major` is live on BOTH shapes, so its presence proves nothing about
  // which one this is. Only its absence alongside `beta_line` means "not a
  // registry", and that is the case worth refusing.
  assert.equal(detectShape(g({ stable_version: 26_000_000 })), null);
});

test('an unrecognisable app throws rather than guessing a head-box shape', () => {
  assert.throws(
    () => resolveLine(g({ stable_version: 1 }), PUBLIC),
    /neither `beta_line` nor `latest_major`/,
  );
});

test('migrated: beta follows beta_line and reads its head box', () => {
  const r = resolveLine(MIGRATED, ALLOWLISTED);
  assert.deepEqual(r, { line: 27_000, beta: true, migrated: true, retired: false });
  // The head box holds the newest patch in the line, which is what beta gets.
  assert.deepEqual(resolveVersion(MIGRATED, r, 27_000_002n), {
    line: 27_000,
    version: 27_000_002n,
    beta: true,
    migrated: true,
  });
});

test('migrated: beta follows beta_line, NOT latest_major', () => {
  // The trap this replaces: `latest_major` is 27, and 27 is a perfectly plausible
  // line key. It is also the wrong box on a migrated registry.
  assert.equal(resolveLine(MIGRATED, ALLOWLISTED).line, 27_000);
  assert.notEqual(resolveLine(MIGRATED, ALLOWLISTED).line, 27);
});

test('the manager is beta with no w box at all', () => {
  const r = resolveLine(MIGRATED, MANAGER);
  assert.equal(r.beta, true);
  assert.equal(r.line, 27_000);
  // Anything that tests only for the box reports "no line open" to the one
  // address that is entitled during a closed beta.
  assert.notEqual(resolveLine(MIGRATED, MANAGER).line, 0);
});

test('migrated: stable is PINNED to stable_version and derives its own line', () => {
  const r = resolveLine(MIGRATED, PUBLIC);
  assert.deepEqual(r, { line: 26_000, beta: false, migrated: true, retired: false });
  // `head` is ignored for stable — it never reads one. Passing a head value here
  // proves the pin: a stable owner handed their line's head would be given a
  // version the registry refuses.
  assert.equal(resolveVersion(MIGRATED, r, 26_000_009n).version, 26_000_001n);
});

test('migrated: stable may lag its line by a whole MAJOR', () => {
  // The live test registry's shape: beta on line 27000, stable pinned at
  // 26000001 and therefore on line 26000 — a major behind, not a minor. Both
  // gaps have to resolve, because production will show the other one.
  assert.equal(resolveLine(MIGRATED, ALLOWLISTED).line, 27_000);
  const r = resolveLine(MIGRATED, PUBLIC);
  assert.equal(r.line, 26_000);
  assert.equal(r.retired, false, 'major 26 clears min_major 25');
  assert.equal(resolveVersion(MIGRATED, r, null).version, 26_000_001n);
});

test('migrated: stable lagging its line is the launch shape, not a fault', () => {
  // v1.0.0 public while v1.1.0 is in beta, in the live numbering.
  const launch = g({
    latest_major: 1,
    beta_line: 1_001,
    stable_version: 1_000_000,
    min_major: 1,
  });
  assert.equal(resolveLine(launch, ALLOWLISTED).line, 1_001);
  assert.equal(resolveLine(launch, PUBLIC).line, 1_000);
  assert.equal(resolveVersion(launch, resolveLine(launch, PUBLIC), null).version, 1_000_000n);
});

test('min_major stays MAJOR-granular after the split', () => {
  // THE ASSERTION THE LIVE FIXTURE CANNOT MAKE. With min_major 25, a correct
  // `line // 1000 >= min_major` retires 24000; the common slip, `line >=
  // min_major`, admits it — and admits every line from 1000 up.
  const retired = { ...MIGRATED, beta_line: 24_000n };
  const r = resolveLine(retired, ALLOWLISTED);
  assert.equal(r.retired, true, 'line 24000 is below min_major 25 and must be retired');
  assert.deepEqual(resolveVersion(retired, r, 24_000_001n), {
    line: 0,
    version: 0n,
    beta: true,
    migrated: true,
  });

  // The boundary itself: 25000 is exactly at the floor and stays open.
  const atFloor = resolveLine({ ...MIGRATED, beta_line: 25_000n }, ALLOWLISTED);
  assert.equal(atFloor.retired, false);
  assert.equal(atFloor.line, 25_000);
});

test('min_major retires a whole major, all of its minor lines with it', () => {
  for (const minor of [0, 1, 999]) {
    const line = BigInt(24_000 + minor);
    const r = resolveLine({ ...MIGRATED, beta_line: line }, ALLOWLISTED);
    assert.equal(r.retired, true, `line ${line} should be retired with min_major 25`);
  }
});

test('min_major applies to stable too, before the tier split', () => {
  const old = { ...MIGRATED, stable_version: 24_000_000n };
  const r = resolveLine(old, PUBLIC);
  assert.equal(r.line, 24_000);
  assert.equal(r.retired, true);
  assert.equal(resolveVersion(old, r, null).version, 0n);
});

test('legacy: a line IS the major, for both tiers', () => {
  assert.deepEqual(resolveLine(LEGACY, ALLOWLISTED), {
    line: 27,
    beta: true,
    migrated: false,
    retired: false,
  });
  // Stable's line pre-split is version / 1_000_000, not / 1000.
  assert.deepEqual(resolveLine(LEGACY, PUBLIC), {
    line: 26,
    beta: false,
    migrated: false,
    retired: false,
  });
});

test('legacy: min_major compares against the bare major, with nothing to divide', () => {
  assert.equal(resolveLine({ ...LEGACY, latest_major: 24n }, ALLOWLISTED).retired, true);
  assert.equal(resolveLine({ ...LEGACY, latest_major: 25n }, ALLOWLISTED).retired, false);
});

test('stable_major is ignored on both shapes even when it answers', () => {
  // An older build wrote this key and a newer one stopped. It still reads live on
  // any registry that ever ran the old build, frozen at a stale value — here a
  // deliberately wrong one, which nothing may pick up.
  const stale = { stable_major: 99n };
  assert.equal(resolveLine({ ...MIGRATED, ...stale }, PUBLIC).line, 26_000);
  assert.equal(resolveLine({ ...LEGACY, ...stale }, PUBLIC).line, 26);
});

test('nothing approved yet closes both tiers, not just beta', () => {
  // The contract asserts `latest_major > 0` before it ever splits by tier, so a
  // registry with a pinned stable and no approved major entitles no one.
  const empty = { ...MIGRATED, latest_major: 0n };
  for (const who of [MANAGER, ALLOWLISTED, PUBLIC]) {
    assert.equal(resolveLine(empty, who).line, 0);
  }
});

test('an unset stable pin closes the permissionless path only', () => {
  const closed = { ...MIGRATED, stable_version: 0n };
  assert.equal(resolveLine(closed, PUBLIC).line, 0);
  assert.equal(resolveLine(closed, ALLOWLISTED).line, 27_000);
});

test('an explicit shape overrides detection, for a half-migrated harness', () => {
  // The one state detection cannot see: updated, but `set_beta_line` not yet
  // called, so the globals read exactly like a legacy registry. Production sends
  // both in one atomic group; a harness that does not needs to say so.
  const half = g({ latest_major: 27, latest_version: 27_000_000, min_major: 25 });
  assert.equal(detectShape(half), 'major');
  assert.equal(resolveLine(half, ALLOWLISTED).line, 27);

  const forced: RegistryShape = 'line';
  const r = resolveLine({ ...half, beta_line: 27_000n }, ALLOWLISTED, forced);
  assert.equal(r.line, 27_000);
  assert.equal(r.migrated, true);
});

test('a beta line whose head box is absent reports no version, not a wrong one', () => {
  const r = resolveLine(MIGRATED, ALLOWLISTED);
  assert.equal(resolveVersion(MIGRATED, r, null).version, 0n);
});

// ── what a registry can actually hand out ───────────────────────────────────
//
// The complete answer is TWO versions, and "complete" is the load-bearing word:
// a coverage check that samples is worthless, because the one version it skipped
// is the one a user gets handed at create time.

test('exactly two versions are reachable, one per tier', () => {
  const r = reachableVersions(MIGRATED, 27_000_002n);
  assert.equal(r.length, 2);
  assert.deepEqual(
    r,
    [
      { tier: 'stable', line: 26_000, version: 26_000_001n },
      { tier: 'beta', line: 27_000, version: 27_000_002n },
    ],
    'stable comes from the pin, beta from the head box',
  );
});

test('beta is omitted when its head box is absent', () => {
  // A line with a pointer but no head entitles nobody to anything, which is not
  // a hole in coverage — there is nothing to serve.
  const r = reachableVersions(MIGRATED, null);
  assert.deepEqual(r.map((x) => x.tier), ['stable']);
});

test('a closed permissionless path leaves only beta', () => {
  const r = reachableVersions({ ...MIGRATED, stable_version: 0n }, 27_000_002n);
  assert.deepEqual(r.map((x) => x.tier), ['beta']);
});

test('a retired line is not reachable', () => {
  // min_major 25 retires line 24000, so nothing on it can be handed out and it
  // does not belong in a coverage check.
  const retired = { ...MIGRATED, beta_line: 24_000n, stable_version: 24_000_000n };
  assert.deepEqual(reachableVersions(retired, 24_000_009n), []);
  assert.equal(betaHeadLine(retired), 0, 'a retired beta line has no head to read');
});

test('betaHeadLine names the box a caller must read, on either shape', () => {
  assert.equal(betaHeadLine(MIGRATED), 27_000);
  assert.equal(betaHeadLine(LEGACY), 27, 'pre-split the line IS the major');
});

test('the legacy shape resolves both tiers too', () => {
  const r = reachableVersions(LEGACY, 27_000_009n);
  assert.deepEqual(r, [
    { tier: 'stable', line: 26, version: 26_000_000n },
    { tier: 'beta', line: 27, version: 27_000_009n },
  ]);
});

test('parity is representable: both tiers on one version', () => {
  // What production looks like once the public line catches up — the two tiers
  // resolve to different VERSIONS on different lines, even though the bytes
  // behind them are identical. Coverage is about versions, so both still count.
  const parity = g({
    latest_major: 1,
    latest_version: 1_001_001,
    beta_line: 1_001,
    stable_version: 1_000_002,
    min_major: 0,
  });
  assert.deepEqual(reachableVersions(parity, 1_001_001n), [
    { tier: 'stable', line: 1_000, version: 1_000_002n },
    { tier: 'beta', line: 1_001, version: 1_001_001n },
  ]);
});
