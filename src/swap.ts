/**
 * Owner-driven swaps: trading from inside a passport with no keeper involved.
 *
 * `swap` is owner-gated like every other value-moving method, spends FREE
 * balance only, and is bounded by a `minOut` you declare — the contract measures
 * what actually left and what actually arrived and refuses anything short of it.
 * Being the owner does not exempt you from that check, which is the point: a
 * compromised front end handing you a bad route still cannot execute it below
 * the floor in the transaction you signed.
 *
 * No keeper fee is charged, because no keeper did any work.
 *
 * ## Why this needs a builder at all
 *
 * The call carries a SESSION BLOB — a router quote, re-encoded as instructions
 * the passport replays as inner transactions. The blob is easy; the reference
 * arrays around it are not, and every one of these is invisible at the call site:
 *
 *   - Inner transactions may only touch apps, assets and accounts the OUTER group
 *     already names. The router's own legs carry theirs in the blob, so they have
 *     to be lifted out and named again on the outside.
 *   - ASSET 0 IS THE OPPOSITE OF EVERYTHING ELSE. It is illegal on an inner
 *     transaction's foreign assets (the native asset is always available) but
 *     must be named at TOP level when a leg needs it. So it is stripped from the
 *     blob and added to the group.
 *   - Box references on session transactions are DROPPED when those transactions
 *     are replayed, so they must be named on the outer group or the router's own
 *     reads fail — as "invalid Box reference", which reads like a permission bug.
 *   - `cm`+assetIn is required: the contract re-checks the committed ledger both
 *     before and after the swap.
 *   - Fees are POOLED. Every inner transaction is submitted with fee 0, so the
 *     outer call has to carry the whole group's fees or the router dies deep in
 *     its own call tree with "group fee too small".
 *   - A group gets 8 references per transaction and at most 4 accounts, shared
 *     group-wide. A real multi-hop route exceeds that on its own, so the overflow
 *     rides on `ping` transactions — the same trick `closeStrategyGroup` uses.
 *
 * ## What the contract will refuse
 *
 * The passport allowlists the apps a session may call: its OWN cached router and
 * budget ids, and nothing else. A blob built against a different router fails
 * with "app not allowlisted" — so pass the ids from `read.passportState`, which
 * is what the passport itself will check against, rather than from a directory
 * lookup the passport may not have adopted yet.
 *
 * Only `assetIn` may leave the passport, the session's sends may not exceed
 * `spend`, and a session may carry at most `MAX_SESSION_TXNS` transactions.
 */
import {
  assignGroupID,
  makeApplicationNoOpTxnFromObject,
  TransactionType,
  type BoxReference,
  type SuggestedParams,
  type Transaction,
} from 'algosdk';
import { PASSPORT } from './abi.js';
import { BOX, MAX_REFS_PER_TXN } from './constants.js';
import { abiBytes, boxName, concat, u64 } from './encode.js';
import { flat } from './create.js';
import { arc2 } from './note.js';
import type { Group, Num, PassportCtx } from './types.js';

/** Inner transactions one session may issue. The contract enforces this. */
export const MAX_SESSION_TXNS = 8;

/** Accounts allowed on ONE transaction. Lower than the 8-reference budget. */
export const MAX_ACCOUNTS_PER_TXN = 4;

const MIN_FEE = 1000;

/**
 * Pack a router session into the blob the contract replays.
 *
 *   [1B type]  1 = pay, 4 = axfer, 6 = appcall
 *   pay:    [32B receiver][8B amount]
 *   axfer:  [32B receiver][8B asset][8B amount]
 *   appl:   [8B app][1B nArgs]([2B len][bytes])*[1B nAccts]([32B])*
 *           [1B nApps]([8B])*[1B nAssets]([8B])*
 *
 * ASSET 0 IS STRIPPED from an app call's foreign assets here, and that is not an
 * optimisation. Setting it on an inner transaction is illegal; leaving it in
 * produces a failure inside the replay rather than at the call site, where
 * nothing names the cause.
 */
export function packSession(session: readonly Transaction[]): Uint8Array {
  if (session.length === 0) throw new Error('session is empty');
  if (session.length > MAX_SESSION_TXNS) {
    throw new RangeError(
      `session has ${session.length} transactions, the contract accepts ` +
        `${MAX_SESSION_TXNS} — the route is too long to replay`,
    );
  }
  const parts: Uint8Array[] = [];
  for (const t of session) {
    if (t.type === TransactionType.pay) {
      const p = t.payment;
      if (!p) throw new Error('payment transaction has no payment fields');
      parts.push(new Uint8Array([1]), p.receiver.publicKey, u64(p.amount));
    } else if (t.type === TransactionType.axfer) {
      const a = t.assetTransfer;
      if (!a) throw new Error('asset transfer has no assetTransfer fields');
      parts.push(
        new Uint8Array([4]),
        a.receiver.publicKey,
        u64(a.assetIndex),
        u64(a.amount),
      );
    } else if (t.type === TransactionType.appl) {
      const c = t.applicationCall;
      if (!c) throw new Error('application call has no applicationCall fields');
      const args = c.appArgs ?? [];
      const accts = c.accounts ?? [];
      const apps = c.foreignApps ?? [];
      // See the note above: illegal on an inner transaction, named on the group.
      const assets = (c.foreignAssets ?? []).filter((x) => BigInt(x) !== 0n);
      parts.push(new Uint8Array([6]), u64(c.appIndex), new Uint8Array([args.length]));
      for (const arg of args) {
        parts.push(new Uint8Array([arg.length >> 8, arg.length & 0xff]), arg);
      }
      parts.push(new Uint8Array([accts.length]), ...accts.map((x) => x.publicKey));
      parts.push(new Uint8Array([apps.length]), ...apps.map((x) => u64(x)));
      parts.push(new Uint8Array([assets.length]), ...assets.map((x) => u64(x)));
    } else {
      throw new Error(`session carries an unsupported transaction type: ${t.type}`);
    }
  }
  return concat(...parts);
}

export interface SessionResources {
  apps: bigint[];
  accounts: string[];
  assets: bigint[];
  boxes: BoxReference[];
}

/**
 * Every reference the replayed session will touch, lifted out of the blob.
 *
 * `needsAlgo` is tracked separately from the asset list because asset 0 is
 * removed from the blob and has to reappear here — the two are the same fact
 * pointing in opposite directions.
 */
export function sessionResources(
  ctx: PassportCtx,
  a: {
    session: readonly Transaction[];
    assetIn: Num;
    assetOut: Num;
    routerApp: Num;
  },
): SessionResources {
  const apps = new Set<bigint>([BigInt(a.routerApp)]);
  const accounts = new Set<string>();
  const assets = new Set<bigint>([BigInt(a.assetIn), BigInt(a.assetOut)]);
  const boxes: BoxReference[] = [
    { appIndex: BigInt(ctx.passport), name: boxName(BOX.committed, a.assetIn) },
  ];
  let needsAlgo = false;
  const seenBox = new Set<string>();

  for (const t of a.session) {
    if (t.type === TransactionType.pay && t.payment) {
      accounts.add(t.payment.receiver.toString());
    } else if (t.type === TransactionType.axfer && t.assetTransfer) {
      accounts.add(t.assetTransfer.receiver.toString());
      assets.add(BigInt(t.assetTransfer.assetIndex));
    } else if (t.type === TransactionType.appl && t.applicationCall) {
      const c = t.applicationCall;
      apps.add(BigInt(c.appIndex));
      for (const x of c.accounts ?? []) accounts.add(x.toString());
      for (const x of c.foreignApps ?? []) apps.add(BigInt(x));
      for (const x of c.foreignAssets ?? []) {
        if (BigInt(x) === 0n) needsAlgo = true;
        else assets.add(BigInt(x));
      }
      // Dropped on replay — see the module note.
      for (const bx of c.boxes ?? []) {
        const app = BigInt(bx.appIndex) === 0n ? BigInt(c.appIndex) : BigInt(bx.appIndex);
        const k = `${app}:${Array.from(bx.name).join(',')}`;
        if (!seenBox.has(k)) {
          seenBox.add(k);
          boxes.push({ appIndex: app, name: bx.name });
        }
      }
    }
  }
  assets.delete(0n);
  const assetList = [...assets].sort((x, y) => (x < y ? -1 : 1));
  return {
    apps: [...apps].sort((x, y) => (x < y ? -1 : 1)),
    accounts: [...accounts].sort(),
    // Top level accepts asset 0; the inner legs cannot carry it.
    assets: needsAlgo || BigInt(a.assetIn) === 0n || BigInt(a.assetOut) === 0n
      ? [0n, ...assetList]
      : assetList,
    boxes,
  };
}

type Slot =
  | { kind: 'account'; v: string }
  | { kind: 'app'; v: bigint }
  | { kind: 'asset'; v: bigint }
  | { kind: 'box'; v: BoxReference };

/**
 * Spread references across as few transactions as the limits allow.
 *
 * THREE constraints, not two, and the third couples slots that look independent:
 *
 *   - 8 references of any kind, per transaction
 *   - at most 4 ACCOUNTS, per transaction
 *   - a BOX is only valid on a transaction that ALSO names the app it belongs to
 *
 * A packer that counts only the first produces a group the node rejects on a
 * route with five pool addresses, which is an ordinary route rather than a
 * strange one. A packer that treats boxes and apps as separate items lets a box
 * land on one transaction and its app on the next, and then algosdk refuses to
 * encode the group at all — "Box ref with appId N not in foreign-apps", raised
 * from inside `assignGroupID`, which reads like a caller mistake rather than a
 * packing one. It appears only once a route needs more than one page, which is
 * the case this function exists for.
 *
 * So a box is placed TOGETHER with its app, and an app placed that way also
 * satisfies the group-wide requirement that every app be named somewhere. A box
 * on the passport's own app needs no companion: that app is the one being
 * called, so it is always available at index 0.
 */
function spread(all: Slot[], selfApp: bigint): Slot[][] {
  const pages: Slot[][] = [];
  let cur: Slot[] = [];
  let accts = 0;
  let appsHere = new Set<bigint>();
  const placed = new Set<bigint>();

  const flush = () => {
    if (cur.length) pages.push(cur);
    cur = [];
    accts = 0;
    appsHere = new Set();
  };

  // Boxes first, each pulling its own app onto the same page. A fresh page is
  // empty, so the pair always fits.
  for (const s of all) {
    if (s.kind !== 'box') continue;
    const app = BigInt(s.v.appIndex);
    const needs = app !== selfApp && !appsHere.has(app) ? 2 : 1;
    if (cur.length + needs > MAX_REFS_PER_TXN) flush();
    if (app !== selfApp && !appsHere.has(app)) {
      cur.push({ kind: 'app', v: app });
      appsHere.add(app);
      placed.add(app);
    }
    cur.push(s);
  }

  // Then everything else, skipping any app a box already brought with it.
  for (const s of all) {
    if (s.kind === 'box') continue;
    if (s.kind === 'app' && placed.has(s.v)) continue;
    const tooManyAccounts = s.kind === 'account' && accts >= MAX_ACCOUNTS_PER_TXN;
    if (cur.length >= MAX_REFS_PER_TXN || tooManyAccounts) flush();
    cur.push(s);
    if (s.kind === 'account') accts++;
    if (s.kind === 'app') appsHere.add(s.v);
  }

  flush();
  return pages.length ? pages : [[]];
}

const apply = (slots: Slot[]) => ({
  ...(slots.some((s) => s.kind === 'box')
    ? { boxes: slots.filter((s) => s.kind === 'box').map((s) => s.v as BoxReference) }
    : {}),
  ...(slots.some((s) => s.kind === 'app')
    ? { foreignApps: slots.filter((s) => s.kind === 'app').map((s) => Number(s.v)) }
    : {}),
  ...(slots.some((s) => s.kind === 'asset')
    ? { foreignAssets: slots.filter((s) => s.kind === 'asset').map((s) => Number(s.v)) }
    : {}),
  ...(slots.some((s) => s.kind === 'account')
    ? { accounts: slots.filter((s) => s.kind === 'account').map((s) => s.v as string) }
    : {}),
});

export interface SwapArgs {
  assetIn: Num;
  /** Spent from FREE balance. Committed funds are not reachable. */
  spend: Num;
  assetOut: Num;
  /**
   * The floor, in `assetOut` units, checked against measured balances. Must be
   * greater than zero — the contract refuses a swap with no floor, and so does
   * this, because a zero floor is an unbounded trade rather than a lenient one.
   */
  minOut: Num;
  /** The router session, unsigned, exactly as the quote produced it. */
  session: readonly Transaction[];
  /**
   * From `read.passportState` — the passport's OWN cached ids, not the
   * directory's. The passport allowlists a session's apps against these, so a
   * blob built for a router it has not adopted fails with "app not allowlisted".
   */
  routerApp: Num;
}

/**
 * Build the swap. Returns one transaction, or a group when the route needs more
 * references than a single transaction can name.
 *
 * DO NOT re-group the result: the group id is a hash over its members, so
 * assigning a new one leaves the node rejecting the lot as incomplete.
 */
export function swapGroup(ctx: PassportCtx, a: SwapArgs): Group {
  if (BigInt(a.assetIn) === BigInt(a.assetOut)) {
    throw new Error('assetIn and assetOut must differ');
  }
  if (BigInt(a.spend) <= 0n) throw new RangeError('spend must be positive');
  if (BigInt(a.minOut) <= 0n) throw new RangeError('minOut must be positive');

  const blob = packSession(a.session);
  const res = sessionResources(ctx, a);
  const slots: Slot[] = [
    ...res.boxes.map((v) => ({ kind: 'box', v }) as Slot),
    ...res.apps.map((v) => ({ kind: 'app', v }) as Slot),
    ...res.assets.map((v) => ({ kind: 'asset', v }) as Slot),
    ...res.accounts.map((v) => ({ kind: 'account', v }) as Slot),
  ];
  const pages = spread(slots, BigInt(ctx.passport));

  // The head pays for itself, for every ping, and for every inner transaction
  // the session issues — all of which are submitted with fee 0.
  const fee = MIN_FEE * (pages.length + a.session.length);

  const head = {
    appArgs: [
      PASSPORT.swap.getSelector(),
      u64(a.assetIn),
      u64(a.spend),
      u64(a.assetOut),
      u64(a.minOut),
      abiBytes(blob),
    ],
    note: arc2('swap', { i: a.assetIn, o: a.assetOut, s: a.spend }),
  };

  const txns: Transaction[] = [
    makeCall(
      ctx.owner,
      BigInt(ctx.passport),
      head.appArgs,
      head.note,
      flat(ctx.params, fee),
      pages[0] ?? [],
    ),
  ];
  for (const page of pages.slice(1)) {
    txns.push(
      makeCall(
        ctx.owner,
        BigInt(ctx.passport),
        [PASSPORT.ping.getSelector()],
        arc2('ping'),
        flat(ctx.params, 0),
        page,
      ),
    );
  }
  return txns.length > 1 ? assignGroupID(txns) : txns;
}

// Split out only so the head and the pings cannot drift apart in how they turn a
// reference page into transaction fields.
function makeCall(
  sender: string,
  appIndex: bigint,
  appArgs: Uint8Array[],
  note: Uint8Array,
  suggestedParams: SuggestedParams,
  page: Slot[],
): Transaction {
  return makeApplicationNoOpTxnFromObject({
    sender,
    appIndex,
    appArgs,
    note,
    suggestedParams,
    ...apply(page),
  });
}
