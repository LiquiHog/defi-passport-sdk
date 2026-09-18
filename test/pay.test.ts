/**
 * Recurring payments — the `Pay` rule type.
 *
 * The prelude is the point: the contract insists a payment names ONE asset in
 * both slots with nothing committed on the second, and the harness proved both
 * shapes — `(0, budget, 0, 0)` for ALGO and `(asa, budget, asa, 0)` for an ASA.
 * The tail carries a 32-byte recipient in the middle, which is why Pay has no
 * template layout and its own decoder.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { strategy } from '../dist/index.js';
import { RuleType } from '../dist/constants.js';
import { decodePayTail, payTail } from '../dist/encode.js';
import { readTail } from '../dist/template.js';
import { PASSPORT, addr, ctx, hex } from './helpers.ts';

const RCPT = addr(4);
const HOG = 3178895177;
const u64hex = (n: bigint | number): string => BigInt(n).toString(16).padStart(16, '0');
const args = (t: algosdk.Transaction) => (t.applicationCall?.appArgs ?? []).map(hex);
const prelude = (t: algosdk.Transaction) => args(t).slice(2, 6).map((h) => BigInt('0x' + h));

test('payTail is 72 bytes: batch, interval, two runtime zeros, the recipient, maxPayments', () => {
  const t = payTail({ batch: 100_000, interval: 60, recipient: RCPT, maxPayments: 1 });
  assert.equal(t.length, 72);
  assert.equal(hex(t), [100_000, 60, 0, 0].map(u64hex).join('') + hex(algosdk.decodeAddress(RCPT).publicKey) + u64hex(1));
  assert.deepEqual(decodePayTail(t), { batch: 100_000n, interval: 60n, lastTs: 0n, nPaid: 0n, recipient: RCPT, maxPayments: 1n });
});

test('payTail refuses what the contract refuses', () => {
  assert.throws(() => payTail({ batch: 0, recipient: RCPT }), /batch/);
  assert.throws(() => payTail({ batch: 1, interval: 30, recipient: RCPT }), /at least 60/);
  assert.throws(() => payTail({ batch: 1, recipient: algosdk.encodeAddress(new Uint8Array(32)) }), /zero address/);
  const self = algosdk.getApplicationAddress(BigInt(PASSPORT)).toString();
  assert.throws(() => payTail({ batch: 1, recipient: self, passport: PASSPORT }), /passport itself/);
  assert.doesNotThrow(() => payTail({ batch: 1, recipient: self }), 'without the passport it cannot know');
});

test('an ALGO payment rule is (0, budget, 0, 0) — as proven', () => {
  // harness: add_rule_txn(..., 0, PAY_BUDGET, 0, 0, pay_tail(PAY_BATCH, INTERVAL, RCPT))
  const t = strategy.payRule(ctx, { sid: 7, ruleId: 1, asset: 0, budget: 250_000, batch: 100_000, recipient: RCPT });
  assert.deepEqual(prelude(t), [0n, 250_000n, 0n, 0n]);
  assert.deepEqual(t.applicationCall?.foreignAssets ?? [], [], 'ALGO is not a foreign asset');
});

test('an ASA payment rule is (asa, budget, asa, 0) — as proven', () => {
  // harness: add_rule_txn(..., HOG, PAY_HOG, HOG, 0, pay_tail(PAY_HOG, INTERVAL, RCPT))
  const t = strategy.payRule(ctx, { sid: 7, ruleId: 2, asset: HOG, budget: 10_000, batch: 10_000, recipient: RCPT });
  assert.deepEqual(prelude(t), [BigInt(HOG), 10_000n, BigInt(HOG), 0n]);
  assert.deepEqual((t.applicationCall?.foreignAssets ?? []).map(Number), [HOG]);
});

test('payRule refuses the passport as recipient and a zero budget', () => {
  const self = algosdk.getApplicationAddress(BigInt(PASSPORT)).toString();
  assert.throws(() => strategy.payRule(ctx, { sid: 7, ruleId: 1, asset: 0, budget: 1, batch: 1, recipient: self }), /passport itself/);
  assert.throws(() => strategy.payRule(ctx, { sid: 7, ruleId: 1, asset: 0, budget: 0, batch: 1, recipient: RCPT }), /budget/);
});

test('Pay has no template layout, and the lookup says why', () => {
  assert.throws(() => readTail(RuleType.Pay, payTail({ batch: 1, recipient: RCPT })), /nothing portable to template/);
});
