/**
 * Read budget: what a group must buy, and what to do when the node says it
 * bought too little.
 *
 * A group pays the program size over the legacy cap of every oversized app it
 * NAMES — calling is not required — and one box reference buys
 * `READ_BUDGET_PER_BOX_REF` of it. All three facts were measured on mainnet
 * rather than inferred:
 *
 *   naming a passport (draw 2,400)          1 ref -> "read budget exceeded (2400 > 2048)", 2 refs pass
 *   naming a router   (draw 3,307)          1 ref -> "(3307 > 2048)", 2 refs pass
 *   naming both from one transaction        2 refs -> "(5707 > 4096)", 3 refs pass
 *
 * The passport's own draw is a constant here because this SDK bundles its bytes.
 * A router's is not: it is upgraded in place by someone else, so it is an input
 * (`extraDraw`, from `read.programDraw`) and, failing that, a number the node
 * hands back through `simulate.readBudget`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { swap } from '../dist/index.js';
import { READ_BUDGET_PER_BOX_REF } from '../dist/constants.js';
import { readBudget } from '../dist/simulate.js';
import { MAX_PROGRAM_OVERFLOW } from '../dist/programs.js';
import { PARAMS, addr, ctx } from './helpers.ts';

const ROUTER = 999;
const V3_DRAW = 3_307;

const leg = (o: { assets?: number[] } = {}) =>
  algosdk.makeApplicationNoOpTxnFromObject({
    sender: addr(1),
    appIndex: BigInt(ROUTER),
    appArgs: [new Uint8Array([1])],
    suggestedParams: PARAMS,
    ...(o.assets ? { foreignAssets: o.assets } : {}),
  });

const build = (extraDraw?: number) =>
  swap.swapGroup(ctx, {
    assetIn: 0, spend: 1n, assetOut: 10, minOut: 1n,
    session: [leg({ assets: [10] })], routerApp: ROUTER,
    ...(extraDraw === undefined ? {} : { extraDraw }),
  });

const refs = (g: algosdk.Transaction[]) =>
  g.reduce((n, t) => n + (t.applicationCall?.boxes ?? []).length, 0);

test('the budget a reference buys is the one the node charges', () => {
  assert.equal(READ_BUDGET_PER_BOX_REF, 2_048);
});

test('a swap for a router under the cap buys budget for the passport alone', () => {
  const g = build();
  assert.ok(refs(g) >= Math.ceil(MAX_PROGRAM_OVERFLOW / READ_BUDGET_PER_BOX_REF), 'covers the passport');
});

test('extraDraw makes the group buy the router\'s budget too', () => {
  // 2,400 + 3,307 = 5,707, which is three references; without it, two.
  const plain = refs(build());
  const withRouter = refs(build(V3_DRAW));
  assert.ok(
    withRouter >= Math.ceil((MAX_PROGRAM_OVERFLOW + V3_DRAW) / READ_BUDGET_PER_BOX_REF),
    `named ${withRouter} references for a draw of ${MAX_PROGRAM_OVERFLOW + V3_DRAW}`,
  );
  assert.ok(withRouter > plain, 'an oversized router costs the group at least one more reference');
});

test('extraDraw defaults to nothing, so a V2 route is built exactly as before', () => {
  const a = build();
  const b = build(0);
  assert.deepEqual(
    a.map((t) => (t.applicationCall?.boxes ?? []).length),
    b.map((t) => (t.applicationCall?.boxes ?? []).length),
  );
});

test('readBudget turns the node\'s refusal into the references it is short', () => {
  // The exact strings mainnet returned.
  assert.deepEqual(readBudget('read budget exceeded (2400 > 0)'), { draw: 2_400, have: 0, refsShort: 2 });
  assert.deepEqual(readBudget('read budget exceeded (2400 > 2048)'), { draw: 2_400, have: 2_048, refsShort: 1 });
  assert.deepEqual(readBudget('read budget exceeded (5707 > 4096)'), { draw: 5_707, have: 4_096, refsShort: 1 });
  assert.deepEqual(readBudget('logic eval error: err opcode executed'), undefined, 'any other failure');
  assert.deepEqual(readBudget(''), undefined, 'a group that passed');
});

test('adding refsShort references is enough to clear the shortfall', () => {
  // The retry a caller writes: add what it says, rebuild, and the sum covers it.
  for (const [draw, have] of [[2_400, 0], [2_400, 2_048], [5_707, 4_096], [11_000, 0]] as const) {
    const short = readBudget(`read budget exceeded (${draw} > ${have})`)!.refsShort;
    assert.ok(have + short * READ_BUDGET_PER_BOX_REF >= draw, `draw ${draw} from ${have}`);
  }
});
