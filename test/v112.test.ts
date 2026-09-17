/**
 * The two owner-facing builders v1.1.2 adds, and what its bundling switched on.
 *
 * Box sets here were read from the shipped defi_passport.py, not from the
 * brief — and they differ from it in two places. set_gas_asset writes a global
 * and names NO box; the brief said it read a position box. close_strategy
 * reads fl+sid (the Folks loan box) as well as sp+sid; the brief named only sp.
 * Both are asserted below so the builders follow the contract, not the memo.
 *
 * Bundling a 10,588-byte program also turned the read-budget padding on by
 * itself: MAX_PROGRAM_OVERFLOW is now 2,400 and every no-box call carries three
 * empty references. That is asserted here explicitly rather than only through
 * the derived-constant test, because it is the behaviour beta owners will hit.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { manage, strategy, abi } from '../dist/index.js';
import { BOX } from '../dist/constants.js';
import { boxName } from '../dist/encode.js';
import { MAX_PROGRAM_OVERFLOW } from '../dist/programs.js';
import { decodeGasAsset } from '../dist/read.js';
import type { PassportCtx } from '../dist/types.js';

const PARAMS = {
  fee: 1000n, minFee: 1000n, firstValid: 1n, lastValid: 1001n,
  genesisID: 'testnet-v1.0', genesisHash: new Uint8Array(32), flatFee: true,
};
const addr = (n: number): string => algosdk.encodeAddress(new Uint8Array(32).fill(n));
const PASSPORT = 555;
const ctx: PassportCtx = {
  algod: null as unknown as algosdk.Algodv2, registry: 1, params: PARAMS, owner: addr(9), passport: PASSPORT,
};
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u64hex = (n: bigint): string => n.toString(16).padStart(16, '0');
const boxesOf = (t: algosdk.Transaction) => t.applicationCall?.boxes ?? [];
const realNames = (t: algosdk.Transaction) => boxesOf(t).filter((b) => b.name.length).map((b) => hex(b.name)).sort();
const empties = (t: algosdk.Transaction) => boxesOf(t).filter((b) => b.name.length === 0).length;
const args = (t: algosdk.Transaction) => (t.applicationCall?.appArgs ?? []).map(hex);
const FUTURE = 4_102_444_800n; // 2100-01-01

test('bundling v1.1.2 switched the read-budget padding on', () => {
  assert.equal(MAX_PROGRAM_OVERFLOW, 2_400, '10,588 + 4 - 8,192');
});

// ── setGasAsset ─────────────────────────────────────────────────────────────

test('setGasAsset encodes the four arguments and names no box — three empties instead', () => {
  const t = manage.setGasAsset(ctx, { asset: 123n, maxNum: 3n, maxDen: 2n, expires: FUTURE });
  assert.deepEqual(args(t), [hex(abi.PASSPORT.set_gas_asset.getSelector()), u64hex(123n), u64hex(3n), u64hex(2n), u64hex(FUTURE)]);
  assert.deepEqual(realNames(t), [], 'the contract writes the ga global and reads no box');
  assert.equal(empties(t), 3);
  assert.doesNotThrow(() => algosdk.encodeUnsignedTransaction(t));
});

test('setGasAsset with asset 0 clears the election and ignores the rest', () => {
  const t = manage.setGasAsset(ctx, { asset: 0, maxNum: 0, maxDen: 0, expires: 0 });
  assert.deepEqual(args(t).slice(1), [u64hex(0n), u64hex(0n), u64hex(0n), u64hex(0n)]);
});

test('setGasAsset refuses what the contract would refuse, with a message', () => {
  assert.throws(() => manage.setGasAsset(ctx, { asset: 1, maxNum: 0, maxDen: 2, expires: FUTURE }), /positive/);
  assert.throws(() => manage.setGasAsset(ctx, { asset: 1, maxNum: 1, maxDen: 0, expires: FUTURE }), /positive/);
  assert.throws(() => manage.setGasAsset(ctx, { asset: 1, maxNum: 1, maxDen: 1, expires: 1 }), /future/);
});

test('decodeGasAsset reads the ga global back', () => {
  const raw = Uint8Array.from([...u64(123n), ...u64(3n), ...u64(2n), ...u64(FUTURE)]);
  assert.deepEqual(decodeGasAsset(raw), { asset: 123n, maxNum: 3n, maxDen: 2n, expires: FUTURE });
  assert.throws(() => decodeGasAsset(new Uint8Array(31)), /31 B, expected 32/);
});

// ── setProfit ───────────────────────────────────────────────────────────────

const S = (sid: number) => hex(boxName(BOX.strategy, sid));
const SP = (sid: number) => hex(boxName(BOX.profit, sid));
const CM = (asset: number) => hex(boxName(BOX.committed, asset));

test('setProfit none: deletes the routing, naming the header and the sp box', () => {
  const t = strategy.setProfit(ctx, { sid: 7, kind: 'none' });
  assert.deepEqual(args(t).slice(1), [u64hex(7n), u64hex(0n), u64hex(0n), u64hex(0n), u64hex(0n)]);
  assert.deepEqual(realNames(t), [S(7), SP(7)].sort());
  assert.equal(empties(t), 1, 'two real boxes need one empty to reach the budget');
});

test('setProfit to the owner: rate in bps, and cm+0 for the free-balance check', () => {
  const t = strategy.setProfit(ctx, { sid: 7, kind: 'owner', mode: 'rate', value: 250 });
  assert.deepEqual(args(t).slice(1), [u64hex(7n), u64hex(0n), u64hex(250n), u64hex(1n), u64hex(0n)]);
  assert.deepEqual(realNames(t), [S(7), SP(7), CM(0)].sort());
  assert.equal(empties(t), 0);
});

test('setProfit to gas: fixed amount, destination kind 3', () => {
  const t = strategy.setProfit(ctx, { sid: 7, kind: 'gas', mode: 'fixed', value: 5_000_000n });
  assert.deepEqual(args(t).slice(1), [u64hex(7n), u64hex(1n), u64hex(5_000_000n), u64hex(3n), u64hex(0n)]);
});

test('setProfit to a reserve also names the receiving header and its quote ledger', () => {
  // The contract pre-creates cm+<dest quote asset> on the owner's signature so
  // a crank never raises minimum balance. That asset is not derivable here.
  const t = strategy.setProfit(ctx, { sid: 7, kind: 'reserve', mode: 'rate', value: 1_000, destSid: 9, destQuoteAsset: 31566704 });
  assert.deepEqual(args(t).slice(1), [u64hex(7n), u64hex(0n), u64hex(1_000n), u64hex(2n), u64hex(9n)]);
  assert.deepEqual(realNames(t), [S(7), SP(7), CM(0), S(9), CM(31566704)].sort());
});

test('setProfit refuses what the contract would refuse, with a message', () => {
  assert.throws(() => strategy.setProfit(ctx, { sid: 7, kind: 'owner', mode: 'rate', value: 0 }), /positive/);
  assert.throws(() => strategy.setProfit(ctx, { sid: 7, kind: 'owner', mode: 'rate', value: 10_001 }), /at most 10000/);
  assert.doesNotThrow(() => strategy.setProfit(ctx, { sid: 7, kind: 'owner', mode: 'fixed', value: 10_001 }), 'fixed is an amount, not bps');
  assert.throws(() => strategy.setProfit(ctx, { sid: 7, kind: 'reserve', mode: 'rate', value: 1, destSid: 7, destQuoteAsset: 0 }), /into itself/);
});

// ── close ───────────────────────────────────────────────────────────────────

test('closeStrategyGroup names sp AND fl beside the header', () => {
  const g = strategy.closeStrategyGroup(ctx, { sid: 7, ruleIds: [], assets: [] });
  const all = g.flatMap(realNames);
  assert.ok(all.includes(SP(7)), 'sp+sid');
  assert.ok(all.includes(hex(boxName(BOX.loan, 7))), 'fl+sid — close checks no loan is bound, by box length');
  assert.ok(all.includes(S(7)));
  assert.ok(all.includes(CM(0)));
});

function u64(n: bigint): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return [...b];
}
