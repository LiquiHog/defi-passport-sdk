/** Byte-level encoding, and the four rule tails. */
import { decodeAddress } from 'algosdk';
import type { AnchorSpec } from './types.js';

export type Num = number | bigint;

/** 8-byte big-endian. Every contract argument and box field is one of these. */
export function u64(x: Num): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(x);
  if (v < 0n) throw new RangeError('u64 cannot be negative');
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError('value exceeds uint64');
  return out;
}

export function readU64(b: Uint8Array, off = 0): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(b[off + i] ?? 0);
  return v;
}

/** ABI `byte[]` — a 2-byte big-endian length prefix. */
export function abiBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + b.length);
  out[0] = (b.length >> 8) & 0xff;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ASCII = new TextEncoder();

/** A box name: a short ASCII prefix followed by u64 keys. */
export function boxName(prefix: string, ...keys: Num[]): Uint8Array {
  return concat(ASCII.encode(prefix), ...keys.map(u64));
}

export function addrBox(prefix: string, address: string): Uint8Array {
  return concat(ASCII.encode(prefix), decodeAddress(address).publicKey);
}

/** Length-prefixed box-name list, for `destroy(keys)`. */
export function keyList(names: Uint8Array[]): Uint8Array {
  return concat(...names.map((n) => concat(new Uint8Array([n.length]), n)));
}

/** Packed uint64 list, for `destroy(assets)` and `close_strategy(rules)`. */
export function u64List(xs: Num[]): Uint8Array {
  return concat(...xs.map(u64));
}

// ── rule tails: CONFIG | RUNTIME ─────────────────────────────────────────
// `update_rule` rewrites config and splices the RUNTIME window back in
// byte-for-byte, so an owner can re-price a live rule but cannot rewind an
// interval gate, forge a fill count, or flip a grid cell's side. Send zeros for
// runtime fields; they are ignored, not rejected.

export function schedTail(o: {
  batch: Num;
  staticFloor: Num;
  interval?: Num;
  tolBps?: Num;
  maxReceived?: Num;
  anchors?: AnchorSpec[];
}): Uint8Array {
  const anchors = o.anchors ?? [];
  return concat(
    u64(o.batch),
    u64(o.tolBps ?? 0),
    u64(o.staticFloor), // mandatory once testing == 0
    u64(o.interval ?? 60),
    u64(0), // runtime: last_ts
    u64(0), // runtime: collected
    u64(anchors.length),
    u64(o.maxReceived ?? 0),
    ...anchors.map((a) => concat(u64(a.mode), u64(a.pool1), u64(a.pool2 ?? 0))),
  );
}

/**
 * A balancer rule. 112 bytes.
 *
 * BOTH PRICE BOUNDS ARE MANDATORY and are checked at CREATION, not just at
 * crank: `_validate` refuses a rule missing either, so a bound-less rule cannot
 * be created and then silently never fill.
 *
 * They are the only price protection the balancer has. The band asserts
 * (`not overweight` / `sell undershoots target`) are RATIO conditions evaluated
 * at the executed price, so they constrain the position's SHAPE and cannot bound
 * price at all — satisfiable with equality at any position size. Use
 * `buyCeiling()` and `sellFloorRatio()` to derive both from live spot.
 *
 * `sellFloor` is a DIFFERENT and optional guard: an absolute position-value
 * floor ("never sell while the whole position is worth less than X"), 0 = unused.
 *
 * `tolBps` and `nAnchors` are RESERVED. Live anchors exist in the contract but
 * are compiled out (`BAL_ANCHORS = False`), and `_validate` refuses any rule
 * carrying one — pass nothing. They stay in the layout so re-enabling is a patch
 * rather than a tail-width change, which would move box contents under live
 * rules and force a migration.
 */
export function balTail(o: {
  target: Num;
  bandBps: Num;
  interval?: Num;
  sellFloor?: Num;
  buyNum: Num;
  buyDen: Num;
  sellNum: Num;
  sellDen: Num;
  /** Unix seconds. MANDATORY — see `boundsExpiry()`. */
  boundsExpire: Num;
  virtAsset?: Num;
  virtLeg?: Num;
}): Uint8Array {
  return concat(
    u64(o.target),
    u64(o.bandBps),
    u64(o.sellFloor ?? 0), // OPTIONAL absolute position-value floor
    u64(o.interval ?? 60),
    u64(0), // runtime: last_ts
    u64(o.buyNum), // 40  mandatory: max quote per base
    u64(o.buyDen), // 48
    u64(o.virtAsset ?? 0), // 56
    u64(o.virtLeg ?? 0), // 64
    u64(o.sellNum), // 72  mandatory: min quote per base
    u64(o.sellDen), // 80
    u64(0), // 88  tol_bps  — reserved, anchors disabled
    u64(0), // 96  n_anchors — reserved, must be 0
    u64(o.boundsExpire), // 104  mandatory; see boundsExpiry()
  );
}

/**
 * A grid cell. `side` sits at offset 0 — it IS the runtime window — so the
 * value passed here only matters at creation.
 *
 * `quoteOut >= quoteIn` is enforced: the sell flip re-commits `quoteIn` but the
 * fill only guarantees `quoteOut`, so a cell with `quoteIn > quoteOut` would
 * convert free balance into permanently committed balance every cycle.
 */
export function gridTail(o: {
  side: 0 | 1;
  quoteIn: Num;
  baseAmt: Num;
  quoteOut: Num;
}): Uint8Array {
  return concat(u64(o.side), u64(o.quoteIn), u64(o.baseAmt), u64(o.quoteOut));
}

export function limitTail(o: {
  amountIn: Num;
  targetOut: Num;
  partial?: boolean;
  minFill?: Num;
  expiresTs?: Num;
}): Uint8Array {
  return concat(
    u64(o.amountIn),
    u64(o.targetOut),
    u64(0), // runtime: filled_in
    u64(0), // runtime: collected
    u64(o.partial ? 1 : 0),
    u64(o.minFill ?? 0),
    u64(o.expiresTs ?? 0),
  );
}

/**
 * Max quote-per-base as an exact ratio: `buy_num / buy_den`.
 *
 * BASE UNITS IN, BASE UNITS OUT — no `decimals` argument and no float anywhere.
 * Take them straight from a BUY quote (quote -> base): `quoteIn` is what you would
 * spend, `baseOut` what you would receive. That is the same shape the contract
 * compares — `spend/out_delta <= buy_num/buy_den` — so the units line up by
 * construction.
 *
 * NO FLOAT ANYWHERE in the derivation. This is a SAFETY bound and the contract
 * only ever sees uint64 base units, so binary floating point would add a needless
 * precision loss with unpredictable rounding.
 *
 * 500 bps by default. The bound caps what a hostile keeper can skim, so it sits
 * close above what an honest crank quotes — around 300 bps — because every extra
 * point of slack is value an attacker may take.
 */
export function buyCeiling(
  quoteIn: Num,
  baseOut: Num,
  toleranceBps = 500,
): { buyNum: bigint; buyDen: bigint } {
  if (BigInt(quoteIn) <= 0n || BigInt(baseOut) <= 0n) {
    throw new RangeError('both amounts must be positive');
  }
  if (toleranceBps >= 10_000) throw new RangeError('tolerance must be under 100%');
  return {
    buyNum: BigInt(quoteIn) * BigInt(10_000 + toleranceBps),
    buyDen: BigInt(baseOut) * 10_000n,
  };
}

/**
 * Min quote-per-base as an exact ratio: `sell_num / sell_den`.
 *
 * NOTE THE DIRECTION — it is the OPPOSITE of `buyCeiling`'s. Take these from a
 * SELL quote (base -> quote): `baseIn` is what you would spend, `quoteOut` what
 * you would receive. Mixing the two up yields a bound wrong by roughly the square
 * of the price, which is why these are named for the direction rather than for
 * "spot".
 */
export function sellFloorRatio(
  baseIn: Num,
  quoteOut: Num,
  toleranceBps = 500,
): { sellNum: bigint; sellDen: bigint } {
  if (BigInt(baseIn) <= 0n || BigInt(quoteOut) <= 0n) {
    throw new RangeError('both amounts must be positive');
  }
  if (toleranceBps >= 10_000) throw new RangeError('tolerance must be under 100%');
  return {
    sellNum: BigInt(quoteOut) * BigInt(10_000 - toleranceBps),
    sellDen: BigInt(baseIn) * 10_000n,
  };
}

/**
 * When the owner stops standing behind the static bounds. MANDATORY on a balancer
 * rule, checked at creation AND at every crank.
 *
 * Static bounds drift against spot, and the contract cannot tell a drifted ceiling
 * from a correct one without a price reference — but it CAN tell a stale one. This
 * is what converts unbounded drift into drift bounded by your re-pricing cadence.
 *
 * Re-pricing is one owner-signed `updateRule`: all four bounds are config, so a
 * LIVE rule can be re-priced without disturbing its crank interval or committed
 * balances. Renewing the expiry and re-deriving the bounds are the same act,
 * because `_validate` refuses a rewrite that does not carry a fresh expiry.
 *
 * NOTE THE CLOCK. The contract compares against `Global.latest_timestamp`, the
 * last block's timestamp, which can lag wall clock by tens of seconds. Irrelevant
 * at a 7-day expiry; do not build anything that depends on seconds.
 */
export function boundsExpiry(nowUnixSeconds: number, days = 7): number {
  return nowUnixSeconds + days * 86_400;
}

/**
 * The registry's version hash: sha256 over the concatenated per-page sha256s.
 *
 * Uses Web Crypto (`crypto.subtle`), standard in every browser and in Node 18+, so
 * this module needs no polyfill and no bundler configuration.
 *
 * The page size is 4096 bytes. That is the REGISTRY's page, not the 2048-byte unit
 * `extraPages` and minimum-balance use — two different quantities share the name,
 * and hashing with the wrong one yields a value nothing can ever satisfy.
 * Permanently, since approving a version is irreversible and a version box can
 * never be rewritten. Prefer `programs.buildForVersion`, which handles it.
 */
export async function pageHash(program: Uint8Array, pageBytes = 4096): Promise<Uint8Array> {
  const sha256 = async (b: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  const acc: Uint8Array[] = [];
  for (let i = 0; i < program.length; i += pageBytes) {
    acc.push(await sha256(program.subarray(i, i + pageBytes)));
  }
  return sha256(concat(...acc));
}
