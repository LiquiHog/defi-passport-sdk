/**
 * Folks Finance lending, from the OWNER's side of the table.
 *
 * A loan is a STRATEGY of type `Folks`, and its rules are the operations — a
 * deposit, a withdrawal, a borrow, a repayment — each cranked by the keeper,
 * which does every Folks transaction itself. Nothing here talks to Folks; this
 * module builds what the owner signs, and only that.
 *
 * ## Why an escrow, and why the front end makes it
 *
 * Folks records the paired payment's sender as the loan's `u` — the one address
 * allowed to act on it — and `create_loan` needs an OptIn signed by a fresh key
 * that rekeys itself to the loan app. A contract cannot mint a keypair, so the
 * front end does: it generates one, funds it, and has it sign exactly ONE
 * transaction — a zero payment to itself carrying a rekey to the passport. From
 * that moment the passport controls the escrow; `open_loan` then emits the
 * Folks legs as inner transactions with the escrow as the OptIn's sender, and
 * the loan app rekeys it once more, to itself. The key is inert after its single
 * signature. That is keeper-assisted by construction and never keeper-custodial:
 * only this passport's cranks can touch the escrow, and only toward this
 * passport.
 *
 * This module gives you the two transactions around that signature
 * (`fundEscrow`, `rekeyEscrow`) but not the keypair — generating one is one
 * algosdk call, and an SDK that hands back secret keys is the wrong shape.
 *
 * ## Which loan apps
 *
 * The contract allowlists six Folks V2 loan apps and refuses any other as
 * "unknown loan app". `FOLKS_LOAN_APPS` mirrors that list so the refusal happens
 * here, with the list in the message, rather than on chain as a bare pc.
 *
 * ## The per-op prelude, which is the part that is easy to get wrong
 *
 * `add_rule` takes two assets and two committed amounts, and what each op puts
 * in them was PROVEN on mainnet rather than reasoned out:
 *
 *   deposit   assetA 0 (the underlying)   committedA the earmark   assetB fAsset
 *   withdraw  assetA 0                    committedA 0             assetB fAsset
 *   borrow    assetA the borrow asset     committedA 0             assetB 0
 *   repay     assetA the borrow asset     committedA the earmark   assetB 0
 *
 * committedB is always 0. Withdraw and borrow proceeds arrive FREE, so an
 * earmark there is refused as funds locked to no purpose; deposit and repay
 * draw from theirs. `folksRule` encodes that table once and refuses a
 * combination the contract would.
 */
import {
  decodeAddress,
  getApplicationAddress,
  makeApplicationNoOpTxnFromObject,
  makePaymentTxnWithSuggestedParamsFromObject,
  type SuggestedParams,
  type Transaction,
} from 'algosdk';
import { PASSPORT } from './abi.js';
import {
  BOX,
  ESCROW_FUNDING,
  FOLKS_CLOSE_FEE,
  FOLKS_LOAN_APPS,
  FolksOp,
  OPEN_LOAN_FEE,
} from './constants.js';
import { boxName, folksTail, u64 } from './encode.js';
import { flat } from './create.js';
import { arc2 } from './note.js';
import { padBoxes } from './pages.js';
import { MAX_PROGRAM_OVERFLOW } from './programs.js';
import { addRule } from './strategy.js';
import type { FolksRuleSpec, Num, PassportCtx } from './types.js';

/**
 * Fund a freshly generated escrow from the owner's wallet.
 *
 * `ESCROW_FUNDING` is what the mainnet proof used and what `folks_close`
 * returns to the passport, whole, at the end. Override only if Folks' own
 * minimum-balance requirements have moved.
 */
export function fundEscrow(a: {
  from: string;
  escrow: string;
  params: SuggestedParams;
  amount?: Num;
}): Transaction {
  return makePaymentTxnWithSuggestedParamsFromObject({
    note: arc2('escrow_fund'),
    sender: a.from,
    receiver: a.escrow,
    amount: BigInt(a.amount ?? ESCROW_FUNDING),
    suggestedParams: flat(a.params, 1000),
  });
}

/**
 * The ONE transaction the escrow key ever signs: a zero payment to itself that
 * rekeys it to the passport. After this the passport controls the escrow, and
 * `openLoan` hands it on to the loan app. Sign with the escrow's key, submit,
 * then forget the key — it authorises nothing further.
 */
export function rekeyEscrow(a: { escrow: string; passport: Num; params: SuggestedParams }): Transaction {
  return makePaymentTxnWithSuggestedParamsFromObject({
    note: arc2('escrow_rekey'),
    sender: a.escrow,
    receiver: a.escrow,
    amount: 0n,
    rekeyTo: getApplicationAddress(BigInt(a.passport)).toString(),
    suggestedParams: flat(a.params, 1000),
  });
}

/** Throws with the allowlist in the message rather than letting chain say "unknown loan app". */
function assertLoanApp(loanApp: Num): void {
  if (!FOLKS_LOAN_APPS.includes(BigInt(loanApp))) {
    throw new RangeError(
      `loan app ${loanApp} is not one the contract accepts: ${FOLKS_LOAN_APPS.join(', ')}`,
    );
  }
}

/**
 * Bind a loan to a `Folks` strategy. Owner-signed, fee 3,000: two inner
 * transactions (the pairing payment to the loan app, and the escrow's OptIn
 * that creates the loan and rekeys the escrow to it).
 *
 * The escrow must already be funded and rekeyed to the passport — see
 * `fundEscrow` and `rekeyEscrow`. Named in `accounts` because the inner OptIn
 * is sent from it; the loan app in `foreignApps` because the contract resolves
 * its address. Three boxes: the strategy header, the loan box it creates, and
 * `cm`+0 for the free-balance check that follows. A second open on the same
 * strategy is refused as "loan already open".
 */
export function openLoan(
  ctx: PassportCtx,
  a: { sid: Num; escrow: string; loanApp: Num },
): Transaction {
  assertLoanApp(a.loanApp);
  const p = BigInt(ctx.passport);
  return makeApplicationNoOpTxnFromObject({
    note: arc2('open_loan', { sid: a.sid }),
    sender: ctx.owner,
    suggestedParams: flat(ctx.params, OPEN_LOAN_FEE),
    appIndex: p,
    appArgs: [PASSPORT.open_loan.getSelector(), u64(a.sid), decodeAddress(a.escrow).publicKey, u64(a.loanApp)],
    accounts: [a.escrow],
    foreignApps: [Number(a.loanApp)],
    boxes: padBoxes(
      [
        { appIndex: p, name: boxName(BOX.strategy, a.sid) },
        { appIndex: p, name: boxName(BOX.loan, a.sid) },
        { appIndex: p, name: boxName(BOX.committed, 0) },
      ],
      MAX_PROGRAM_OVERFLOW,
    ),
  });
}

/**
 * Close the loan and return the escrow's whole minimum balance to the passport.
 * Owner-signed, fee 6,000: three inner transactions (`remove_loan`, the
 * escrow's CloseOut, and a zero payment from the escrow closing its remainder
 * here).
 *
 * `escrow` and `loanApp` come from `read.loan` — the `fl` box records both.
 *
 * Works whether or not the strategy header still exists, on purpose: a loan
 * whose strategy was closed must still be closable or the escrow's balance is
 * stranded with no method able to reach it. With a header present, its rules
 * must be removed first ("remove the rules first").
 */
export function folksClose(
  ctx: PassportCtx,
  a: { sid: Num; escrow: string; loanApp: Num },
): Transaction {
  const p = BigInt(ctx.passport);
  return makeApplicationNoOpTxnFromObject({
    note: arc2('folks_close', { sid: a.sid }),
    sender: ctx.owner,
    suggestedParams: flat(ctx.params, FOLKS_CLOSE_FEE),
    appIndex: p,
    appArgs: [PASSPORT.folks_close.getSelector(), u64(a.sid)],
    accounts: [a.escrow],
    foreignApps: [Number(a.loanApp)],
    boxes: padBoxes(
      [
        { appIndex: p, name: boxName(BOX.strategy, a.sid) },
        { appIndex: p, name: boxName(BOX.loan, a.sid) },
      ],
      MAX_PROGRAM_OVERFLOW,
    ),
  });
}

/**
 * Add one operation to a `Folks` strategy, with the prelude the op needs.
 *
 * The four combinations are the ones proven on mainnet (see the module note).
 * Each refusal below is one the contract makes too, so a wrong shape fails here
 * with a sentence instead of on chain with a pc.
 */
export function folksRule(ctx: PassportCtx, s: FolksRuleSpec): Transaction {
  const drawing = s.op === FolksOp.Deposit || s.op === FolksOp.Repay;
  const movesFAsset = s.op === FolksOp.Deposit || s.op === FolksOp.Withdraw;
  const earmark = BigInt(s.earmark ?? 0);
  const fAsset = BigInt(s.fAsset ?? 0);

  if (drawing && earmark <= 0n) {
    throw new RangeError(`a ${FolksOp[s.op]} rule needs an earmark — the amount it may draw`);
  }
  if (!drawing && earmark !== 0n) {
    throw new RangeError(
      `a ${FolksOp[s.op]} rule holds no funds — its proceeds arrive free; the contract refuses an earmark`,
    );
  }
  if (movesFAsset && fAsset === 0n) {
    throw new RangeError(`a ${FolksOp[s.op]} rule moves the pool's fAsset and must name it`);
  }
  if (!movesFAsset && fAsset !== 0n) {
    throw new RangeError(`a ${FolksOp[s.op]} rule moves no fAsset; leave it unset`);
  }

  return addRule(ctx, {
    sid: s.sid,
    ruleId: s.ruleId,
    assetA: s.underlying,
    committedA: earmark,
    assetB: fAsset,
    committedB: 0,
    tail: folksTail(s),
  });
}
