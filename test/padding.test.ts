/**
 * Every builder that touches a passport pays the read budget.
 *
 * A program over the legacy cap makes the AVM charge every call to the app a
 * read budget that only box references buy back — including calls that touch
 * no box at all. Builders cannot see which version a passport runs, so they pad
 * for the largest bundled build (`MAX_PROGRAM_OVERFLOW`).
 *
 * The first tests are written against whatever the bundle implies, so they held
 * while no bundled build was over the cap (padding a no-op, nothing added) and
 * hold now that v1.1.2 is: real references untouched, empties up to the need.
 * The last block asserts the padded shape and is SKIPPED while no bundled build
 * is oversized — it switched on when v1.1.2 was bundled, without any edit, which
 * is the property being protected.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { manage, strategy, teardown, swap } from '../dist/index.js';
import { BOX, MAX_REFS_PER_TXN, RuleType } from '../dist/constants.js';
import { boxName } from '../dist/encode.js';
import { boxRefsNeeded } from '../dist/pages.js';
import { MAX_PROGRAM_OVERFLOW } from '../dist/programs.js';
import { PARAMS, PASSPORT, addr, ctx } from './helpers.ts';

const boxesOf = (t: algosdk.Transaction) => t.applicationCall?.boxes ?? [];
const isEmpty = (b: { name: Uint8Array }) => b.name.length === 0;
const real = (t: algosdk.Transaction) => boxesOf(t).filter((b) => !isEmpty(b));
const empties = (t: algosdk.Transaction) => boxesOf(t).filter(isEmpty);
const refs = (t: algosdk.Transaction) => {
  const c = t.applicationCall!;
  return boxesOf(t).length + (c.foreignApps ?? []).length + (c.foreignAssets ?? []).length + (c.accounts ?? []).length;
};

/** Every single-transaction passport builder, with the boxes it names for real. */
const SINGLES: Array<[string, () => algosdk.Transaction, number]> = [
  ['setGasCap', () => manage.setGasCap(ctx, 64), 0],
  ['setOracle', () => manage.setOracle(ctx, 42), 0],
  ['setDirectory', () => manage.setDirectory(ctx, 42), 0],
  ['syncContracts', () => manage.syncContracts(ctx, { directory: 1, router: 2, budget: 3 }), 0],
  ['optIn', () => manage.optIn(ctx, 10), 1],
  ['optOut', () => manage.optOut(ctx, 10), 1],
  ['withdraw', () => manage.withdraw(ctx, { asset: 10, amount: 1n }), 1],
  ['clearPosition', () => manage.clearPosition(ctx, 10), 1],
  ['lock', () => manage.lock(ctx, { asset: 10, amount: 1n }), 3],
  ['unlock', () => manage.unlock(ctx, { asset: 10, amount: 1n }), 3],
  ['setRefundBudget', () => strategy.setRefundBudget(ctx, { sid: 1, amount: 1n }), 1],
  ['addReserve', () => strategy.addReserve(ctx, { sid: 1, amount: 1n, quoteAsset: 10 }), 3],
  [
    'openStrategy',
    () => strategy.openStrategy(ctx, { sid: 1, type: RuleType.Limit, quoteAsset: 10, quoteAmount: 1n }),
    -1, // has its own boxes; count asserted generically below
  ],
  [
    'destroy',
    () => teardown.destroy({ owner: addr(9), passport: PASSPORT, params: PARAMS, assets: [], boxNames: [] }),
    0,
  ],
];

test('every single builder names its real boxes unchanged and pads to the budget', () => {
  for (const [name, build, expectReal] of SINGLES) {
    const t = build();
    const r = real(t).length;
    if (expectReal >= 0) assert.equal(r, expectReal, `${name}: real boxes`);
    const need = boxRefsNeeded(MAX_PROGRAM_OVERFLOW, r);
    assert.equal(boxesOf(t).length, Math.max(r, need), `${name}: padded to the budget`);
    assert.equal(empties(t).length, Math.max(0, need - r), `${name}: only as many empties as needed`);
    assert.ok(refs(t) <= MAX_REFS_PER_TXN, `${name}: ${refs(t)} references exceeds the slot limit`);
    assert.doesNotThrow(() => algosdk.encodeUnsignedTransaction(t), `${name} must encode`);
  }
});

test('closeStrategyGroup names the profit box beside the strategy header', () => {
  // v1.1.2 reads sp+sid on close. Naming it where it does not exist is legal;
  // failing to name it where it does is "invalid Box reference".
  const g = strategy.closeStrategyGroup(ctx, { sid: 7, ruleIds: [1], assets: [] });
  const all = g.flatMap((t) => boxesOf(t)).map((b) => Buffer.from(b.name).toString('hex'));
  assert.ok(all.includes(Buffer.from(boxName(BOX.profit, 7)).toString('hex')), 'sp+7 must be named');
  assert.ok(all.includes(Buffer.from(boxName(BOX.strategy, 7)).toString('hex')));
});

test('a close group already meets the budget with real boxes, so its members are not padded', () => {
  // strategy, profit, cm+0 at minimum — three real, which is the need up to five.
  const g = strategy.closeStrategyGroup(ctx, { sid: 7, ruleIds: [], assets: [] });
  const totalReal = g.reduce((n, t) => n + real(t).length, 0);
  assert.ok(totalReal >= 3);
  assert.ok(totalReal >= boxRefsNeeded(MAX_PROGRAM_OVERFLOW, totalReal), 'the group buys its own budget');
  for (const t of g) assert.equal(empties(t).length, 0, 'group members do not pad themselves');
  for (const t of g) assert.ok(refs(t) <= MAX_REFS_PER_TXN);
});

test('a busy close group with a head sized to the slot limit still stays within it', () => {
  // Seven foreign assets leave one box slot on the head. If the head padded
  // itself it would exceed eight references; it must not.
  const g = strategy.closeStrategyGroup(ctx, {
    sid: 7,
    ruleIds: [1, 2, 3],
    assets: [11, 12, 13, 14, 15, 16, 17],
  });
  for (const [i, t] of g.entries()) assert.ok(refs(t) <= MAX_REFS_PER_TXN, `member ${i}: ${refs(t)}`);
  assert.ok(g.length > 1, 'this route must spill onto pings');
});

test('removeEntry pads too — the group touches the passport it de-registers', () => {
  const t = teardown.removeEntry({ owner: addr(9), registry: 1, passport: PASSPORT, params: PARAMS });
  const r = real(t).length;
  assert.equal(r, 2);
  assert.equal(boxesOf(t).length, Math.max(r, boxRefsNeeded(MAX_PROGRAM_OVERFLOW, r)));
});

test('a swap never names app 0 as a foreign app, whatever the padding', () => {
  const leg = algosdk.makeApplicationNoOpTxnFromObject({
    sender: addr(1),
    appIndex: 999n,
    appArgs: [new Uint8Array([1])],
    suggestedParams: PARAMS,
  });
  const g = swap.swapGroup(ctx, {
    assetIn: 0,
    spend: 1n,
    assetOut: 10,
    minOut: 1n,
    session: [leg],
    routerApp: 999,
  });
  for (const t of g) {
    assert.ok(!(t.applicationCall?.foreignApps ?? []).some((a) => BigInt(a) === 0n), 'app 0 is not a foreign app');
    assert.doesNotThrow(() => algosdk.encodeUnsignedTransaction(t));
  }
});

// ── the padded shape, live once an oversized build is bundled ────────────────

const untilOversized = { skip: MAX_PROGRAM_OVERFLOW === 0 && 'no bundled build is over the legacy cap yet' };

test('with an oversized build bundled: no-box calls carry two empty references', untilOversized, () => {
  for (const [name, build, expectReal] of SINGLES) {
    if (expectReal !== 0) continue;
    const t = build();
    assert.equal(empties(t).length, 2, name);
    assert.equal(boxesOf(t).length, 2, name);
  }
});

test('with an oversized build bundled: one-box calls carry one empty, two-box calls none', untilOversized, () => {
  // At 2,048 a reference a 2,400-byte draw takes two references, however they
  // are made up — so a call already naming two real boxes pads nothing.
  assert.equal(empties(manage.optIn(ctx, 10)).length, 1);
  assert.equal(empties(manage.withdraw(ctx, { asset: 10, amount: 1n })).length, 1);
  assert.equal(empties(manage.lock(ctx, { asset: 10, amount: 1n })).length, 0);
});

test('with an oversized build bundled: a swap with one real box pads and still encodes', untilOversized, () => {
  const leg = algosdk.makeApplicationNoOpTxnFromObject({
    sender: addr(1),
    appIndex: 999n,
    appArgs: [new Uint8Array([1])],
    suggestedParams: PARAMS,
  });
  const g = swap.swapGroup(ctx, { assetIn: 0, spend: 1n, assetOut: 10, minOut: 1n, session: [leg], routerApp: 999 });
  const total = g.reduce((n, t) => n + boxesOf(t).length, 0);
  assert.ok(total >= 2, `group names ${total} box references`);
  for (const t of g) assert.doesNotThrow(() => algosdk.encodeUnsignedTransaction(t));
});
