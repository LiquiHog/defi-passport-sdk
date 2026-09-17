/**
 * Folks lending, owner side.
 *
 * The thing most worth pinning is the per-op prelude: which asset and which
 * committed amount go in which slot of `add_rule` for each of the four ops.
 * That table was PROVEN on mainnet by the contract team's harness, and every
 * row below is asserted against the exact call that harness made. A wrong row
 * does not fail at signing time — it fails at crank time, or worse, cranks the
 * wrong thing.
 *
 * `open_loan`'s box set is asserted from the contract, not the brief: the brief
 * said two boxes, the contract calls `_free_ok(0)` and needs three.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import algosdk from 'algosdk';
import { folks, abi, read } from '../dist/index.js';
import {
  BOX,
  ESCROW_FUNDING,
  FOLKS_CLOSE_FEE,
  FOLKS_LOAN_APPS,
  FolksOp,
  OPEN_LOAN_FEE,
  RuleType,
} from '../dist/constants.js';
import { boxName, boundsExpiry, decodeFolksTail, folksTail } from '../dist/encode.js';
import { RULE_LAYOUT, readTail } from '../dist/template.js';
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
const ESCROW = addr(3);
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u64hex = (n: bigint | number): string => BigInt(n).toString(16).padStart(16, '0');
const args = (t: algosdk.Transaction) => (t.applicationCall?.appArgs ?? []).map(hex);
const boxesOf = (t: algosdk.Transaction) => t.applicationCall?.boxes ?? [];
const realNames = (t: algosdk.Transaction) => boxesOf(t).filter((b) => b.name.length).map((b) => hex(b.name)).sort();
const empties = (t: algosdk.Transaction) => boxesOf(t).filter((b) => b.name.length === 0).length;

// Mainnet, as the harness used them. Examples, not constants: pools are not
// contract-enforced, only loan apps are.
const GENERAL = 971388781;
const POOL_ALGO = 971368268;
const FALGO = 971381860;
const POOL_USDC = 971372237;
const USDC = 31566704;
const FUTURE = boundsExpiry(Math.floor(Date.now() / 1000));

const S = (sid: number) => hex(boxName(BOX.strategy, sid));
const FL = (sid: number) => hex(boxName(BOX.loan, sid));
const CM = (asset: number) => hex(boxName(BOX.committed, asset));

// ── the tail ────────────────────────────────────────────────────────────────

test('folksTail is 72 bytes in the contract\'s order, runtime zeroed', () => {
  const t = folksTail({ op: FolksOp.Borrow, pool: POOL_USDC, batch: 100_000, interval: 3600, maxTotal: 30_000, boundsExpire: FUTURE });
  assert.equal(t.length, 72);
  assert.equal(hex(t), [2, POOL_USDC, 100_000, 3600, 30_000, 0, 0, 0, FUTURE].map(u64hex).join(''));
  assert.deepEqual(decodeFolksTail(t), {
    op: FolksOp.Borrow, pool: BigInt(POOL_USDC), batch: 100_000n, interval: 3600n,
    maxTotal: 30_000n, lastTs: 0n, done: 0n, minCb: 0n, boundsExpire: BigInt(FUTURE),
  });
});

test('folksTail refuses what the contract refuses', () => {
  assert.throws(() => folksTail({ op: 4 as FolksOp, pool: 1, batch: 1 }), /bad folks op/);
  assert.throws(() => folksTail({ op: FolksOp.Deposit, pool: 0, batch: 1 }), /pool app/);
  assert.throws(() => folksTail({ op: FolksOp.Deposit, pool: 1, batch: 0 }), /batch/);
  assert.throws(() => folksTail({ op: FolksOp.Deposit, pool: 1, batch: 1, interval: 30 }), /at least 60/);
  // The envelope must lapse — for the two ops that have one.
  assert.throws(() => folksTail({ op: FolksOp.Borrow, pool: 1, batch: 1 }), /boundsExpire/);
  assert.throws(() => folksTail({ op: FolksOp.Withdraw, pool: 1, batch: 1, boundsExpire: 1 }), /boundsExpire/);
  assert.doesNotThrow(() => folksTail({ op: FolksOp.Deposit, pool: 1, batch: 1 }), 'deposit needs no envelope');
  assert.doesNotThrow(() => folksTail({ op: FolksOp.Repay, pool: 1, batch: 1 }), 'nor repay');
});

test('the Folks template layout matches the tail and readTail decodes it', () => {
  const l = RULE_LAYOUT[RuleType.Folks]!;
  assert.equal(l.length, 72);
  assert.deepEqual(l.runtime, [40, 16]);
  const t = folksTail({ op: FolksOp.Deposit, pool: POOL_ALGO, batch: 500_000, interval: 60 });
  const r = readTail(RuleType.Folks, t);
  assert.equal(r.fields['pool'], BigInt(POOL_ALGO));
  assert.equal(r.fields['batch'], 500_000n);
  assert.equal(r.kinds['boundsExpire'], 'deadline');
});

// ── the prelude, row by row against the harness ──────────────────────────────

const prelude = (t: algosdk.Transaction) => {
  const a = args(t);
  return [a[2], a[3], a[4], a[5]].map((h) => BigInt('0x' + h));
};

test('DEPOSIT: (0, earmark, fAsset, 0) — as proven', () => {
  // harness: add_rule_txn(..., 0, DEPOSIT, FALGO, 0, folks_tail(OP_DEPOSIT, POOL_ALGO, DEPOSIT))
  const t = folks.folksRule(ctx, { sid: 7, ruleId: 1, op: FolksOp.Deposit, pool: POOL_ALGO, batch: 500_000, underlying: 0, fAsset: FALGO, earmark: 500_000 });
  assert.deepEqual(prelude(t), [0n, 500_000n, BigInt(FALGO), 0n]);
});

test('BORROW: (borrowAsset, 0, 0, 0) — as proven', () => {
  // harness: add_rule_txn(..., USDC, 0, 0, 0, folks_tail(OP_BORROW, POOL_USDC, BORROW, max_total=CAP, bounds_expire=exp))
  const t = folks.folksRule(ctx, { sid: 7, ruleId: 2, op: FolksOp.Borrow, pool: POOL_USDC, batch: 100_000, maxTotal: 30_000, boundsExpire: FUTURE, underlying: USDC });
  assert.deepEqual(prelude(t), [BigInt(USDC), 0n, 0n, 0n]);
});

test('REPAY: (borrowAsset, earmark, 0, 0) — as proven', () => {
  // harness: add_rule_txn(..., USDC, earmark, 0, 0, folks_tail(OP_REPAY, POOL_USDC, 400_000))
  const t = folks.folksRule(ctx, { sid: 7, ruleId: 3, op: FolksOp.Repay, pool: POOL_USDC, batch: 400_000, underlying: USDC, earmark: 250_000 });
  assert.deepEqual(prelude(t), [BigInt(USDC), 250_000n, 0n, 0n]);
});

test('WITHDRAW: (0, 0, fAsset, 0) — the contract\'s "holds no funds" shape', () => {
  const t = folks.folksRule(ctx, { sid: 7, ruleId: 4, op: FolksOp.Withdraw, pool: POOL_ALGO, batch: 100_000, minCb: 1_000, boundsExpire: FUTURE, underlying: 0, fAsset: FALGO });
  assert.deepEqual(prelude(t), [0n, 0n, BigInt(FALGO), 0n]);
});

test('folksRule refuses the combinations the contract refuses, with a sentence', () => {
  const base = { sid: 7, ruleId: 1, pool: POOL_ALGO, batch: 1, boundsExpire: FUTURE, underlying: 0 } as const;
  assert.throws(() => folks.folksRule(ctx, { ...base, op: FolksOp.Deposit, fAsset: FALGO }), /needs an earmark/);
  assert.throws(() => folks.folksRule(ctx, { ...base, op: FolksOp.Borrow, earmark: 1 }), /holds no funds/);
  assert.throws(() => folks.folksRule(ctx, { ...base, op: FolksOp.Withdraw, earmark: 1, fAsset: FALGO }), /holds no funds/);
  assert.throws(() => folks.folksRule(ctx, { ...base, op: FolksOp.Deposit, earmark: 1 }), /must name it/);
  assert.throws(() => folks.folksRule(ctx, { ...base, op: FolksOp.Borrow, fAsset: FALGO }), /moves no fAsset/);
  assert.throws(() => folks.folksRule(ctx, { ...base, op: FolksOp.Repay, earmark: 1, fAsset: FALGO }), /moves no fAsset/);
});

test('a Folks rule commits assetA only and names both legs\' ledgers', () => {
  const t = folks.folksRule(ctx, { sid: 7, ruleId: 1, op: FolksOp.Deposit, pool: POOL_ALGO, batch: 5, underlying: 0, fAsset: FALGO, earmark: 5 });
  const names = realNames(t);
  assert.ok(names.includes(S(7)) && names.includes(CM(0)) && names.includes(CM(FALGO)));
  assert.deepEqual((t.applicationCall?.foreignAssets ?? []).map(Number), [FALGO], 'the fAsset is a foreign asset; ALGO is not');
});

// ── open_loan ───────────────────────────────────────────────────────────────

test('openLoan: selector, args, escrow in accounts, loan app in apps, fee 3000', () => {
  const t = folks.openLoan(ctx, { sid: 7, escrow: ESCROW, loanApp: GENERAL });
  const a = args(t);
  assert.equal(a[0], hex(abi.PASSPORT.open_loan.getSelector()));
  assert.equal(a[1], u64hex(7));
  assert.equal(a[2], hex(algosdk.decodeAddress(ESCROW).publicKey));
  assert.equal(a[3], u64hex(GENERAL));
  assert.deepEqual((t.applicationCall?.accounts ?? []).map(String), [ESCROW]);
  assert.deepEqual((t.applicationCall?.foreignApps ?? []).map(Number), [GENERAL]);
  assert.equal(Number(t.fee), OPEN_LOAN_FEE);
});

test('openLoan names THREE boxes — s, fl and cm+0 — not the two in the brief', () => {
  // The contract calls _free_ok(0) after creating the loan box, and reading an
  // unnamed box is a hard error. Three real boxes meet the budget; no empties.
  const t = folks.openLoan(ctx, { sid: 7, escrow: ESCROW, loanApp: GENERAL });
  assert.deepEqual(realNames(t), [S(7), FL(7), CM(0)].sort());
  assert.equal(empties(t), 0);
  assert.doesNotThrow(() => algosdk.encodeUnsignedTransaction(t));
});

test('openLoan refuses a loan app the contract does not accept, naming the six it does', () => {
  assert.throws(() => folks.openLoan(ctx, { sid: 7, escrow: ESCROW, loanApp: 9_999_999 }), /not one the contract accepts/);
  assert.equal(FOLKS_LOAN_APPS.length, 6);
  for (const app of FOLKS_LOAN_APPS) {
    assert.doesNotThrow(() => folks.openLoan(ctx, { sid: 7, escrow: ESCROW, loanApp: app }), String(app));
  }
});

// ── folks_close ─────────────────────────────────────────────────────────────

test('folksClose: s and fl plus one empty, escrow and loan app referenced, fee 6000', () => {
  const t = folks.folksClose(ctx, { sid: 7, escrow: ESCROW, loanApp: GENERAL });
  assert.equal(args(t)[0], hex(abi.PASSPORT.folks_close.getSelector()));
  assert.deepEqual(realNames(t), [S(7), FL(7)].sort());
  assert.equal(empties(t), 1, 'two real boxes need one empty to reach the budget');
  assert.deepEqual((t.applicationCall?.accounts ?? []).map(String), [ESCROW]);
  assert.deepEqual((t.applicationCall?.foreignApps ?? []).map(Number), [GENERAL]);
  assert.equal(Number(t.fee), FOLKS_CLOSE_FEE);
});

// ── the escrow's two transactions ───────────────────────────────────────────

test('fundEscrow pays the proven amount from the owner to the escrow', () => {
  const t = folks.fundEscrow({ from: addr(9), escrow: ESCROW, params: PARAMS });
  assert.equal(t.payment?.receiver.toString(), ESCROW);
  assert.equal(Number(t.payment?.amount), ESCROW_FUNDING);
  assert.equal(ESCROW_FUNDING, 950_000);
});

test('rekeyEscrow is a zero self-payment rekeying to the PASSPORT address', () => {
  // The one signature the escrow key ever gives.
  const t = folks.rekeyEscrow({ escrow: ESCROW, passport: PASSPORT, params: PARAMS });
  assert.equal(t.sender.toString(), ESCROW);
  assert.equal(t.payment?.receiver.toString(), ESCROW);
  assert.equal(Number(t.payment?.amount), 0);
  assert.equal(t.rekeyTo?.toString(), algosdk.getApplicationAddress(BigInt(PASSPORT)).toString());
});

// ── the fl box ──────────────────────────────────────────────────────────────

test('decodeLoan reads escrow then loan app from the 40-byte box', () => {
  const raw = Uint8Array.from([...algosdk.decodeAddress(ESCROW).publicKey, ...Buffer.from(u64hex(GENERAL), 'hex')]);
  assert.deepEqual(read.decodeLoan(raw), { escrow: ESCROW, loanApp: BigInt(GENERAL) });
  assert.throws(() => read.decodeLoan(new Uint8Array(39)), /39 B, expected 40/);
});
