/**
 * The gas cap, resolved from a passport's state and the registry's brake.
 *
 * Two numbers meet here and BOTH have a zero that means the opposite of what it
 * reads as: a stored `gas_cap` of 0 means unset, which resolves to the protocol
 * maximum, and a `crank_txn_budget` of 0 means the registry is not braking at
 * all. Read either literally and you report a passport that cannot crank when it
 * is in fact running wide open. That inversion is most of what is tested here.
 *
 * The rest is `supported`, which cannot be a `>=` against a single version —
 * v1.1.0 is numerically larger than v1.0.1 and predates the method.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveGasCap } from '../dist/read.js';
import { GAS_CAP_DEFAULT, GAS_CAP_MAX } from '../dist/constants.js';
import type { PassportState } from '../dist/types.js';

/** A passport running `version` with `gasCap` stored. Nothing else is read. */
const st = (version: bigint, gasCap: bigint): PassportState => ({
  owner: '',
  registry: 1n,
  testing: 0n,
  version,
  orderCount: 0n,
  oracleAppId: 0n,
  directory: 0n,
  routerAppId: 0n,
  budgetAppId: 0n,
  gasCap,
  gasAsset: null,
});

const V100 = 1_000_000n; // v1.0.0 — the public build, no set_gas_cap
const V101 = 1_000_001n; // v1.0.1 — adds it
const V110 = 1_001_000n; // v1.1.0 — the beta build, no set_gas_cap
const V111 = 1_001_001n; // v1.1.1 — adds it

test('the default and the maximum are the same number, so a cap only tightens', () => {
  assert.equal(GAS_CAP_DEFAULT, GAS_CAP_MAX);
  assert.equal(GAS_CAP_MAX, 272, '256 inner + 16 top-level');
});

test('a stored 0 means UNSET and resolves to the default, not to no gas', () => {
  const r = resolveGasCap(st(V101, 0n), 0);
  assert.equal(r.cap, 272);
  assert.equal(r.isDefault, true);
  assert.equal(r.effective, 272, 'an unset cap is wide open, not clamped shut');
});

test('a brake of 0 means the registry is NOT braking', () => {
  const r = resolveGasCap(st(V101, 64n), 0);
  assert.equal(r.brake, 0);
  assert.equal(r.effective, 64, 'no brake must not clamp the effective cap to zero');
});

test('an owner cap below the default binds', () => {
  const r = resolveGasCap(st(V101, 64n), 0);
  assert.deepEqual(
    { cap: r.cap, isDefault: r.isDefault, effective: r.effective },
    { cap: 64, isDefault: false, effective: 64 },
  );
});

test('the registry brake may LOWER an owner cap', () => {
  const r = resolveGasCap(st(V101, 128n), 64);
  assert.equal(r.cap, 128);
  assert.equal(r.brake, 64);
  assert.equal(r.effective, 64);
});

test('the registry brake may NOT raise one', () => {
  const r = resolveGasCap(st(V101, 64n), 200);
  assert.equal(r.effective, 64, 'the emergency brake is one-directional');
});

test('the brake lowers an unset cap too', () => {
  const r = resolveGasCap(st(V101, 0n), 32);
  assert.equal(r.isDefault, true);
  assert.equal(r.cap, 272);
  assert.equal(r.effective, 32);
});

test('v1.0.0 does not have the method', () => {
  assert.equal(resolveGasCap(st(V100, 0n), 0).supported, false);
});

test('v1.1.0 does not have it either, though it is the LARGER number', () => {
  // THE TRAP. 1_001_000 > 1_000_001, so any `version >= V101` test reports the
  // current beta build as supporting a method it does not have — and the call is
  // then rejected as unknown at signing time.
  assert.ok(V110 > V101, 'v1.1.0 really is numerically larger than v1.0.1');
  assert.equal(resolveGasCap(st(V110, 0n), 0).supported, false);
});

test('both step-1 builds have it', () => {
  assert.equal(resolveGasCap(st(V101, 0n), 0).supported, true);
  assert.equal(resolveGasCap(st(V111, 0n), 0).supported, true);
});

test('a later patch on a known line still has it', () => {
  assert.equal(resolveGasCap(st(1_000_007n, 0n), 0).supported, true);
  assert.equal(resolveGasCap(st(1_001_042n, 0n), 0).supported, true);
});

test('an unattested passport reports unsupported rather than guessing', () => {
  // version 0 means `confirm_version` has not run. There is nothing to compare.
  assert.equal(resolveGasCap(st(0n, 0n), 0).supported, false);
});

test('an unknown line is unsupported, not assumed', () => {
  // v2.0.5 is newer than everything listed and belongs to a line this build has
  // never heard of. Hiding a control is the cheap failure; offering one that gets
  // rejected at signing time is not.
  assert.equal(resolveGasCap(st(2_000_005n, 0n), 0).supported, false);
});

test('supported is independent of whether a cap was ever set', () => {
  for (const cap of [0n, 64n, 272n]) {
    assert.equal(resolveGasCap(st(V101, cap), 0).supported, true);
    assert.equal(resolveGasCap(st(V100, cap), 0).supported, false);
  }
});
