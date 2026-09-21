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
 *     outer call has to carry the whole call tree's fees or the router dies deep
 *     in it with "group fee too small". That includes the ROUTER'S OWN inner
 *     transactions, which is what the fee the quote puts on each leg is for — a
 *     router call quoted at 7,000 pays for six more beneath it. So the head pays
 *     1,000 per outer transaction plus each session transaction's quoted fee.
 *   - A group gets 8 references per transaction and at most 4 accounts, shared
 *     group-wide. A real multi-hop route exceeds that on its own, so the overflow
 *     rides on `ping` transactions — the same trick `closeStrategyGroup` uses.
 *     WHICH references share a transaction matters as much as naming them — see
 *     `layout`.
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
import { padBoxes } from './pages.js';
import { MAX_PROGRAM_OVERFLOW } from './programs.js';
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
        `${MAX_SESSION_TXNS} — the route is too long to replay; re-quote it with fewer legs`,
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

/** A group holds at most this many transactions; the pings count. */
export const MAX_GROUP_TXNS = 16;

const slotKey = (s: Slot): string =>
  s.kind === 'box'
    ? `box:${s.v.appIndex}:${Array.from(s.v.name).join(',')}`
    : `${s.kind}:${String(s.v)}`;

/**
 * The references that must land on ONE outer transaction together.
 *
 * NAMING A REFERENCE SOMEWHERE IN THE GROUP IS NOT ENOUGH. A holding — an
 * account's balance of an asset — is only available when the account and the
 * asset are named on the SAME transaction, and a local-state read needs its
 * account beside its app. An app named anywhere makes its address an account
 * on that transaction only. None of this shows at the call site: the router
 * fails inside the replay with "unavailable Holding" or "unavailable Local
 * State", naming a pool address the builder never saw as an account.
 *
 * The quote already says which references belong together: each leg was a
 * valid transaction on its own, with everything it reads side by side. So each
 * leg is kept WHOLE, and with the app it calls — the router, whose own address
 * reads its local state in every pool it trades through. That pairing is the
 * one it is easy to lose: nothing in a leg's reference arrays names the router,
 * because in the quote it was the called app rather than a foreign one. Split
 * the pools from it and the router's first local read fails.
 *
 * Three more kinds of unit:
 *
 *   - The router beside EVERY session asset. It reads its own balance of each
 *     hop, including assets that are neither the input nor the output.
 *   - Each box beside its app. A box on the passport needs no companion; the
 *     passport is the app every outer transaction calls.
 *   - Each padding (empty) box alone, free to fill any gap.
 *
 * Proven on mainnet: five real routes, three of which 0.5.1's packer split —
 * a hop asset away from the router, a pool logic-sig away from its app — all
 * simulate clean under strict resources when laid out this way.
 */
function units(
  session: readonly Transaction[],
  res: SessionResources,
  boxes: readonly BoxReference[],
  routerApp: bigint,
  selfApp: bigint,
): Slot[][] {
  const out: Slot[][] = [];
  const app = (v: bigint): Slot => ({ kind: 'app', v });
  const asset = (v: bigint): Slot => ({ kind: 'asset', v });

  // The router's holdings: in chunks, each with the router, if a route ever
  // names more assets than fit beside it on one transaction.
  for (let i = 0; i < res.assets.length || i === 0; i += MAX_REFS_PER_TXN - 1) {
    out.push([app(routerApp), ...res.assets.slice(i, i + MAX_REFS_PER_TXN - 1).map(asset)]);
  }

  for (const [i, t] of session.entries()) {
    const c = t.type === TransactionType.appl ? t.applicationCall : undefined;
    if (!c) continue;
    const accounts: Slot[] = (c.accounts ?? []).map((x) => ({ kind: 'account', v: x.toString() }));
    const apps: Slot[] = (c.foreignApps ?? []).map((x) => app(BigInt(x)));
    const assets: Slot[] = (c.foreignAssets ?? []).map((x) => asset(BigInt(x)));
    if (!accounts.length && !apps.length && !assets.length) continue;
    const whole = dedupe([app(BigInt(c.appIndex)), ...accounts, ...apps, ...assets]);
    if (whole.length <= MAX_REFS_PER_TXN) {
      out.push(whole);
      continue;
    }
    // A full leg plus its router is one over. Cover the same pairs with two:
    // router + pools + accounts for the local reads, the leg as quoted for the
    // holdings (the router's own holdings ride on its unit above).
    const locals = dedupe([app(BigInt(c.appIndex)), ...accounts, ...apps]);
    if (locals.length > MAX_REFS_PER_TXN) {
      throw new RangeError(
        `session transaction ${i} names ${locals.length - 1} accounts and apps; with the app it ` +
          `calls that is more than one transaction can carry together — re-quote the route`,
      );
    }
    out.push(locals, dedupe([...accounts, ...apps, ...assets]));
  }

  for (const v of boxes) {
    const owner = BigInt(v.appIndex);
    const box: Slot = { kind: 'box', v };
    // App 0 is the called app itself, which is how an EMPTY reference is
    // written; neither it nor a box on the passport needs a companion.
    out.push(owner === 0n || owner === selfApp ? [box] : [app(owner), box]);
  }
  return out;
}

/**
 * Merge identical references — EXCEPT empty boxes. Every empty reference is the
 * same value and each one buys another 1,024 bytes of read budget, so merging
 * two would silently halve what the padding exists to pay for.
 */
function dedupe(slots: Slot[]): Slot[] {
  const m = new Map<string, Slot>();
  let empty = 0;
  for (const s of slots) {
    const isEmpty = s.kind === 'box' && s.v.name.length === 0;
    m.set(isEmpty ? `empty:${empty++}` : slotKey(s), s);
  }
  return [...m.values()];
}

/**
 * Place units on as few transactions as the limits allow, NEVER splitting one.
 *
 * Largest first, each onto the first transaction it fits with what is already
 * there — merging identical references, since two units often share a pool or
 * an asset. The limits: 8 references of any kind and 4 accounts per
 * transaction. The price of keeping units whole is sometimes one more `ping`
 * than the tightest packing, 1,000 µAlgo, against a group that cannot fail on a
 * reference it names.
 */
function layout(all: Slot[][]): Slot[][] {
  const pages: Slot[][] = [];
  const merged = (page: Slot[], unit: Slot[]): Slot[] | null => {
    const m = dedupe([...page, ...unit]);
    const accounts = m.filter((s) => s.kind === 'account').length;
    return m.length <= MAX_REFS_PER_TXN && accounts <= MAX_ACCOUNTS_PER_TXN ? m : null;
  };
  const order = all.map((u, i) => ({ u, i })).sort((x, y) => y.u.length - x.u.length || x.i - y.i);
  for (const { u } of order) {
    const at = pages.findIndex((p) => merged(p, u) !== null);
    if (at >= 0) pages[at] = merged(pages[at]!, u)!;
    else pages.push(merged([], u)!);
  }
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
  /**
   * Read budget this group must buy for apps OTHER than the passport, in bytes
   * — in practice the router's, from `read.programDraw(algod, routerApp)`.
   *
   * A group pays the draw of every oversized app it NAMES, and a swap names its
   * router whether or not the router is the app being called. The passport's own
   * draw is known here because this SDK bundles its bytes; a router's is not,
   * because it is upgraded in place by someone else — so it is an input, cached
   * by the caller, rather than a constant that goes stale.
   *
   * Leave it unset for a router under the legacy cap, which draws nothing. Set
   * wrongly low, the group fails with "read budget exceeded", which names
   * nothing about the route; the SDK cannot detect that offline.
   */
  extraDraw?: Num;
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
  const pages = layout(
    units(
      a.session,
      res,
      // Padded as a set: the group is budgeted as a whole, and the layout puts
      // any empties wherever there is room. Draws ADD UP, so the passport's own
      // program and the router's are paid for together.
      padBoxes(res.boxes, MAX_PROGRAM_OVERFLOW + Number(a.extraDraw ?? 0)),
      BigInt(a.routerApp),
      BigInt(ctx.passport),
    ),
  );
  if (pages.length > MAX_GROUP_TXNS) {
    throw new RangeError(
      `this route needs ${pages.length} outer transactions to name its references, a group ` +
        `holds ${MAX_GROUP_TXNS} — re-quote it with fewer legs`,
    );
  }

  // The head pays for itself and every ping, and for everything the session
  // does — all submitted with fee 0. A leg's quoted fee already covers the
  // router's own inner transactions beneath it; never count one below the
  // minimum, in case a quote leaves it unset.
  const sessionFees = a.session.reduce(
    (n, t) => n + Math.max(Number(t.fee), MIN_FEE),
    0,
  );
  const fee = MIN_FEE * pages.length + sessionFees;

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
