/**
 * Two things v1.1.2 adds that are decodable and costable offline.
 *
 * The `sp` box layout came from the contract team verbatim — raw box, not an
 * arc56 box map, so it is not machine-readable anywhere and this is where it is
 * written down. `upgradeCost` is the pre-signing check that stops an upgrade
 * failing on the owner's balance with an error that reads like nothing to do
 * with pages.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type algosdk from 'algosdk';
import { decodeProfit, upgradeCost } from '../dist/read.js';
import { MBR_PER_EXTRA_PAGE, OVERSIZED_PROGRAM_FEE } from '../dist/constants.js';

const u64 = (n: bigint): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
};
const spBox = (mode: bigint, value: bigint, kind: bigint, dest: bigint): Uint8Array =>
  Uint8Array.from([...u64(mode), ...u64(value), ...u64(kind), ...u64(dest), ...u64(0n)]);

test('decodeProfit reads the five-slot layout as specified', () => {
  assert.deepEqual(decodeProfit(spBox(0n, 250n, 1n, 0n)), {
    mode: 'rate',
    value: 250n,
    kind: 'owner',
    destSid: 0n,
  });
  assert.deepEqual(decodeProfit(spBox(1n, 5_000_000n, 2n, 9n)), {
    mode: 'fixed',
    value: 5_000_000n,
    kind: 'reserve',
    destSid: 9n,
  });
  assert.equal(decodeProfit(spBox(0n, 100n, 3n, 0n)).kind, 'gas');
});

test('decodeProfit refuses what the contract would never write', () => {
  assert.throws(() => decodeProfit(new Uint8Array(39)), /39 B, expected 40/);
  assert.throws(() => decodeProfit(spBox(2n, 0n, 1n, 0n)), /unknown profit skim mode/);
  // Kind 0 is the DELETE instruction to set_profit, never a stored value: a box
  // carrying it is corrupt, not "no routing" — absence is how "none" is spelled.
  assert.throws(() => decodeProfit(spBox(0n, 0n, 0n, 0n)), /unknown profit destination kind/);
});

/** An algod that answers one question: how many extra pages the app declares. */
const algodWith = (extraProgramPages: number): algosdk.Algodv2 =>
  ({
    getApplicationByID: () => ({ do: async () => ({ params: { extraProgramPages } }) }),
  }) as unknown as algosdk.Algodv2;

const BIG = { approval: new Uint8Array(10_588), clear: new Uint8Array(4) };
const SMALL = { approval: new Uint8Array(6_911), clear: new Uint8Array(4) };

test('upgradeCost: growing 3 -> 5 charges the wallet two pages plus the surcharge', async () => {
  const c = await upgradeCost(algodWith(3), 555, BIG);
  assert.deepEqual(c, {
    currentExtraPages: 3,
    extraPages: 5,
    mbrIncrease: 2 * MBR_PER_EXTRA_PAGE,
    fee: OVERSIZED_PROGRAM_FEE,
    spendable: 2 * MBR_PER_EXTRA_PAGE + OVERSIZED_PROGRAM_FEE,
  });
});

test('upgradeCost: an already-grown passport pays only the surcharge', async () => {
  const c = await upgradeCost(algodWith(5), 555, BIG);
  assert.equal(c.extraPages, 5);
  assert.equal(c.mbrIncrease, 0);
  assert.equal(c.spendable, OVERSIZED_PROGRAM_FEE);
});

test('upgradeCost: a passport never shrinks, even for a build that would fit fewer pages', async () => {
  const c = await upgradeCost(algodWith(5), 555, SMALL);
  assert.equal(c.extraPages, 5, 'stays at five');
  assert.equal(c.mbrIncrease, 0);
  assert.equal(c.fee, 1000);
});

test('upgradeCost: a small build on a floor-sized passport is just the base fee', async () => {
  const c = await upgradeCost(algodWith(3), 555, SMALL);
  assert.deepEqual(c, { currentExtraPages: 3, extraPages: 3, mbrIncrease: 0, fee: 1000, spendable: 1000 });
});
