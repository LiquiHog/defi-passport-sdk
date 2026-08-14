/**
 * Reading live state. Two rules here are load-bearing:
 *
 *  - `sid` and `ruleId` are READ, never guessed. `close_strategy` deletes a
 *    header without decrementing `order_count`, so a box scan predicts an id the
 *    contract will not use.
 *  - size deposits off `freeBalance`, never off the raw balance. A freshly
 *    drained passport sits exactly at its min-balance, and the difference is
 *    the whole of what `withdraw` will allow.
 */
import { encodeAddress, getApplicationAddress, type Algodv2 } from 'algosdk';
import { BOX, REG_BOX, RuleType } from './constants.js';
import { addrBox, boxName, readU64 } from './encode.js';
import type { Num, PassportState, Position, Rule, Strategy } from './types.js';

const TXT = new TextDecoder();

export type Globals = Record<string, bigint | Uint8Array>;

export async function globals(algod: Algodv2, app: Num): Promise<Globals> {
  const info = await algod.getApplicationByID(BigInt(app)).do();
  const out: Globals = {};
  for (const kv of info.params?.globalState ?? []) {
    const key = TXT.decode(kv.key);
    out[key] = kv.value.type === 2 ? kv.value.uint : kv.value.bytes;
  }
  return out;
}

const asU = (g: Globals, k: string): bigint => (typeof g[k] === 'bigint' ? (g[k] as bigint) : 0n);

export async function passportState(algod: Algodv2, app: Num): Promise<PassportState> {
  const g = await globals(algod, app);
  const raw = g['owner'];
  return {
    owner: raw instanceof Uint8Array ? encodeAddress(raw) : '',
    registry: asU(g, 'registry'),
    testing: asU(g, 'testing'),
    version: asU(g, 'version'),
    orderCount: asU(g, 'order_count'),
    oracleAppId: asU(g, 'oracle_app_id'),
    directory: asU(g, 'directory'),
    routerAppId: asU(g, 'router_app_id'),
    budgetAppId: asU(g, 'budget_app_id'),
  };
}

/** Every box, name -> value. Follows pagination; a passport can hold many. */
export async function boxes(algod: Algodv2, app: Num): Promise<Map<string, Uint8Array>> {
  const id = BigInt(app);
  const names: Uint8Array[] = [];
  let next: string | undefined;
  do {
    const page: { boxes: { name: Uint8Array }[]; nextToken?: string } = next
      ? await algod.getApplicationBoxes(id).next(next).do()
      : await algod.getApplicationBoxes(id).do();
    for (const b of page.boxes) names.push(b.name);
    next = page.nextToken;
  } while (next);

  const out = new Map<string, Uint8Array>();
  for (const name of names) {
    const one = await algod.getApplicationBoxByName(id, name).do();
    out.set(hex(name), one.value);
  }
  return out;
}

export const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * ONE box by name, or null if it does not exist.
 *
 * USE THIS WHENEVER YOU KNOW THE NAME. Reach for `boxes()` only when the answer
 * genuinely is "all of them" — it lists every box and then fetches each one, so
 * one known name costs 1 + N round trips against an app that may hold thousands.
 *
 * That matters most against the registry, whose box count grows by two with every
 * passport ever created. Code that reads two known boxes through `boxes()` gets
 * slower for everyone as adoption grows, while looking perfectly fine in a test
 * written against a registry holding four.
 *
 * A 404 means ABSENT, not broken — an unregistered owner, an address with no beta
 * entry, a line with no head — so this returns null rather than throwing. Treat
 * null as "not there yet"; it is a normal answer, not an error to surface.
 */
export async function boxValue(
  algod: Algodv2,
  app: Num,
  name: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const box = await algod.getApplicationBoxByName(BigInt(app), name).do();
    return box.value;
  } catch (e) {
    if (absent(e)) return null;
    throw e;
  }
}

/** `order_count + 1`. The next sid `open_strategy` will actually return. */
export async function nextSid(algod: Algodv2, passport: Num): Promise<bigint> {
  return (await passportState(algod, passport)).orderCount + 1n;
}

/** The header's `next_rule_id` at offset 56. Never derive this from a box scan. */
export async function nextRuleId(algod: Algodv2, passport: Num, sid: Num): Promise<bigint> {
  const raw = await boxValue(algod, passport, boxName(BOX.strategy, sid));
  if (!raw) throw new Error(`strategy ${sid} does not exist`);
  return readU64(raw, 56);
}

export function decodeStrategy(sid: bigint, raw: Uint8Array): Strategy {
  return {
    sid,
    type: Number(readU64(raw, 0)) as RuleType,
    feeBps: readU64(raw, 8),
    refundBudget: readU64(raw, 16),
    createdTs: readU64(raw, 24),
    quoteAsset: readU64(raw, 32),
    quoteAmount: readU64(raw, 40),
    nRules: readU64(raw, 48),
    nextRuleId: readU64(raw, 56),
  };
}

export function decodeRule(sid: bigint, ruleId: bigint, raw: Uint8Array): Rule {
  return {
    sid,
    ruleId,
    assetA: readU64(raw, 0),
    committedA: readU64(raw, 8),
    assetB: readU64(raw, 16),
    committedB: readU64(raw, 24),
    tail: raw.subarray(32),
  };
}

export function decodePosition(asset: bigint, raw: Uint8Array): Position {
  return {
    asset,
    kind: readU64(raw, 0),
    subKind: readU64(raw, 8),
    flags: readU64(raw, 16),
    amount: readU64(raw, 24),
    oracleApp: readU64(raw, 32),
    refApp: readU64(raw, 40),
    refId: readU64(raw, 48),
    legs: raw.subarray(56, 104),
  };
}

export interface Snapshot {
  strategies: Strategy[];
  rules: Rule[];
  positions: Position[];
  committed: Map<bigint, bigint>;
}

/** One pass over the boxes, decoded into the four things a UI needs. */
export async function snapshot(algod: Algodv2, passport: Num): Promise<Snapshot> {
  const all = await boxes(algod, passport);
  const s: Strategy[] = [];
  const r: Rule[] = [];
  const p: Position[] = [];
  const committed = new Map<bigint, bigint>();

  for (const [h, val] of all) {
    const name = unhex(h);
    const tag = TXT.decode(name.subarray(0, 2));
    if (tag === 'sr' && name.length === 18) {
      r.push(decodeRule(readU64(name, 2), readU64(name, 10), val));
    } else if (tag === 'cm' && name.length === 10) {
      committed.set(readU64(name, 2), readU64(val, 0));
    } else if (name[0] === 0x73 /* s */ && name.length === 9) {
      s.push(decodeStrategy(readU64(name, 1), val));
    } else if (name[0] === 0x70 /* p */ && name.length === 9) {
      p.push(decodePosition(readU64(name, 1), val));
    }
  }
  return { strategies: s, rules: r, positions: p, committed };
}

export function unhex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

/**
 * THE ONE INVARIANT: `cm(asset)` equals the sum of rule preludes, strategy quote
 * reserves and position amounts. Re-derive it in any admin view — it is the
 * single check that catches a stranded balance anywhere in the passport.
 */
export async function committedLedgerOk(
  algod: Algodv2,
  passport: Num,
): Promise<{ ok: boolean; committed: Map<bigint, bigint>; derived: Map<bigint, bigint> }> {
  const { strategies, rules, positions, committed } = await snapshot(algod, passport);
  const derived = new Map<bigint, bigint>();
  const add = (asset: bigint, amt: bigint) => {
    if (amt > 0n) derived.set(asset, (derived.get(asset) ?? 0n) + amt);
  };
  for (const r of rules) {
    add(r.assetA, r.committedA);
    add(r.assetB, r.committedB);
  }
  for (const s of strategies) add(s.quoteAsset, s.quoteAmount);
  for (const p of positions) add(p.asset, p.amount);

  const live = new Map([...committed].filter(([, v]) => v > 0n));
  let ok = live.size === derived.size;
  if (ok) for (const [k, v] of derived) ok = ok && live.get(k) === v;
  return { ok, committed: live, derived };
}

/**
 * What `withdraw` will allow. For ALGO the balance is already net of
 * min-balance, which is why a drained passport reads 0 free rather than 0.1.
 */
export async function freeBalance(algod: Algodv2, passport: Num, asset: Num): Promise<bigint> {
  const addr = getApplicationAddress(BigInt(passport)).toString();
  const ai = await algod.accountInformation(addr).do();
  const a = BigInt(asset);
  let bal: bigint;
  if (a === 0n) {
    bal = ai.amount > ai.minBalance ? ai.amount - ai.minBalance : 0n;
  } else {
    bal = ai.assets?.find((x) => BigInt(x.assetId) === a)?.amount ?? 0n;
  }
  const cm = await boxValue(algod, passport, boxName(BOX.committed, a));
  const committed = cm ? readU64(cm, 0) : 0n;
  return bal > committed ? bal - committed : 0n;
}

/**
 * Does this address have a passport, and what is it?
 *
 * ONE algod call, no indexer: the registry keeps a forward index box
 * `e`+owner -> app id, so a front end can answer "do you have a passport?" for a
 * connected wallet before showing anything else. Absent box = no passport.
 *
 * IT HOLDS ONE — THE PRIMARY. `create_entry` DELETES and re-creates this box, so
 * an owner who creates a second passport has the forward index pointing at the
 * NEW one; the old one still exists and still works, but is no longer discoverable
 * this way. (Its reverse-index `a` box persists, which is what keeps its cranks
 * authenticating.) So this answers "their current passport", not "all of them" —
 * listing every passport for an owner means scanning `a` boxes, which is an
 * indexer job, not an algod one.
 */
/**
 * Which balancer rules are running on stale price bounds, and how long the rest
 * have. Read-only.
 *
 * WHOSE JOB THIS IS. `bounds_expire` is owner-declared config and re-pricing it is
 * an owner-signed `updateRule`, so the warning belongs to whoever holds the key —
 * a UI for its users, or an SDK consumer for theirs. Deliberately NOT the keeper's:
 * the keeper is untrusted-by-construction infrastructure with no channel to the
 * owner, so a warning there would land in the operator's log, not in front of the
 * person who can act on it.
 *
 * Why the bounds expire at all: they are static, they drift against spot, and they
 * are the only thing capping what a hostile keeper can skim. The contract cannot
 * tell a drifted ceiling from a correct one without a price reference — only a
 * stale one — so the owner states how long they stand behind the numbers and the
 * crank refuses past it. A lapsed rule STOPS FILLING; it does not fill badly.
 *
 * TWO THINGS THIS GETS RIGHT that a naive version does not:
 *
 *   1. It gates on the STRATEGY TYPE. `bounds_expire` lives at tail offset 104 and
 *      only a balancer tail is that long — a schedule tail is 64 plus anchors, a
 *      grid 32, a limit 56. Reading offset 104 on those returns adjacent bytes or
 *      overruns, so the type is checked first, not assumed.
 *   2. It compares against CHAIN time, not `Date.now()`. The contract tests
 *      `Global.latest_timestamp`, the last block's timestamp, which can run tens of
 *      seconds behind the local clock — 37s was observed on a live node. Harmless
 *      against a 7-day expiry and fatal to anything finer, and it is the reason a
 *      test written against wall clock reported a working guard as broken.
 */
export interface BoundsHealth {
  sid: bigint;
  ruleId: bigint;
  /** Unix seconds the owner declared the bounds good until. */
  expiresAt: bigint;
  /** Chain seconds remaining. NEGATIVE once lapsed. */
  secondsLeft: bigint;
  expired: boolean;
}

export async function boundsHealth(
  algod: Algodv2,
  passport: Num,
): Promise<{ chainTs: bigint; rules: BoundsHealth[] }> {
  const [snap, status] = await Promise.all([
    snapshot(algod, passport),
    algod.status().do(),
  ]);
  const blk = await algod.block(status.lastRound).do();
  // `block.header.timestamp`, NOT `block.timestamp` and not the raw REST `ts`.
  // algosdk v3 nests the header, and reading the wrong path yields `undefined` ->
  // a chain time of 0, which does not throw: it silently reports every rule as
  // having ~56,000 years left. Assert it rather than defaulting, because a
  // plausible wrong answer here is worse than a failure.
  const ts = (blk.block as unknown as {
    header?: { timestamp?: bigint | number };
  }).header?.timestamp;
  if (ts === undefined) throw new Error('could not read the block timestamp');
  const chainTs = BigInt(ts);
  const balancerSids = new Set(
    snap.strategies.filter((x) => Number(x.type) === RuleType.Balancer)
      .map((x) => x.sid.toString()),
  );
  const rules: BoundsHealth[] = [];
  for (const r of snap.rules) {
    if (!balancerSids.has(r.sid.toString())) continue;
    if (r.tail.length < 112) continue; // pre-expiry layout; nothing to report
    const expiresAt = readU64(r.tail, 104);
    rules.push({
      sid: r.sid,
      ruleId: r.ruleId,
      expiresAt,
      secondsLeft: expiresAt - chainTs,
      expired: expiresAt <= chainTs,
    });
  }
  rules.sort((a, b) => (a.secondsLeft < b.secondsLeft ? -1 : 1));
  return { chainTs, rules };
}

/**
 * Is this error the box simply not existing, or did we fail to find out?
 *
 * A 404 means ABSENT, which is a normal answer: an unregistered owner, an address
 * with no beta entry, a line with no head. Anything else — a 429, a timeout, a node
 * failing over — means the question went unanswered.
 *
 * REPORTING THE SECOND AS THE FIRST IS THE DANGEROUS DIRECTION. A rate-limited read
 * that returns null tells someone who owns a passport that they have none, and the
 * obvious response is to create one, which `create_entry` refuses because a live
 * passport already exists. So they get an error on an account they now believe is
 * broken, from a transaction they should never have been offered.
 */
function absent(e: unknown): boolean {
  const status =
    (e as { status?: number })?.status ??
    (e as { response?: { status?: number } })?.response?.status;
  return status === 404;
}

export async function findPassport(
  algod: Algodv2,
  registry: Num,
  owner: string,
): Promise<bigint | null> {
  const name = addrBox(REG_BOX.owner, owner);
  try {
    const box = await algod.getApplicationBoxByName(BigInt(registry), name).do();
    return readU64(box.value, 0);
  } catch (e) {
    if (absent(e)) return null; // no registration
    throw e;
  }
}

/**
 * The reverse direction: who owns this passport? Reads `a`+app_id, which is the
 * box `emit_event` authenticates cranks against — so its presence also tells you
 * the passport is linked and therefore crankable.
 */
export async function ownerOf(
  algod: Algodv2,
  registry: Num,
  passport: Num,
): Promise<string | null> {
  const name = boxName(REG_BOX.passport, passport);
  try {
    const box = await algod.getApplicationBoxByName(BigInt(registry), name).do();
    return encodeAddress(box.value);
  } catch (e) {
    if (absent(e)) return null; // not linked — the keeper cannot crank it
    throw e;
  }
}

/**
 * Which version `who` may install, mirroring exactly what the registry enforces.
 *
 * ASK THIS BEFORE OFFERING TO CREATE ANYTHING. It answers three questions a UI
 * needs on its first screen: whether this address may create a passport at all,
 * which version it would get, and whether it is on the beta tier.
 *
 * Two steps, because access is granted by LINE rather than by version. The tier
 * picks a major — the newest line for a beta address, stable's own major for
 * everyone else — and the registry returns that line's newest approved patch.
 *
 * THE MANAGER IS ALWAYS ON THE BETA TIER and never has a beta box, so it is
 * checked separately. Skipping that check does not merely lose an edge case: while
 * a registry is in closed beta with no public version pinned, the manager is the
 * only address entitled to anything, and you would report "no line open" for the
 * one address that can in fact create.
 *
 * Stable's major is DERIVED from the version number rather than read from a
 * global. An older registry build stored it separately, and that key still answers
 * on any registry that ever ran that build — an upgrade does not clear globals the
 * new code stopped writing, so it sits at a stale value and reads as perfectly
 * live. Deriving is the only way to match what will actually be enforced.
 *
 * You need the result even though `create_entry` derives its own: box references
 * are named at SIGNING time, so the creation group has to name the boxes for this
 * major and version. Guessing wrong surfaces as "invalid Box reference", not as a
 * passport created on the wrong line.
 *
 * Returns `{ major: 0, version: 0n }` when no line is open to this address — say
 * so in the UI rather than letting the create fail on chain.
 */
export async function entitled(
  algod: Algodv2,
  registry: Num,
  who: string,
): Promise<{ major: number; version: bigint; beta: boolean }> {
  // TWO NAMED BOXES, NEVER A SCAN. The registry gains two index boxes per
  // passport created, so reading these through `boxes()` cost 1 + N round
  // trips and grew with adoption — on the first screen a visitor sees.
  // See `boxValue`.
  //
  // The manager check is settled from GLOBALS alone, so an allowlisted
  // address costs one box read and the manager costs none.
  const g = await globals(algod, registry);
  const mgr = g['manager'];
  const isManager = mgr instanceof Uint8Array && encodeAddress(mgr) === who;
  const beta = isManager
    || (await boxValue(algod, registry, addrBox(REG_BOX.beta, who))) !== null;
  if (beta) {
    // BETA tracks the LINE HEAD, so it always gets the newest patch — and
    // therefore takes any notice period on a fresh approval itself.
    const major = Number(asU(g, 'latest_major'));
    if (major === 0 || major < Number(asU(g, 'min_major'))) {
      return { major: 0, version: 0n, beta };
    }
    const head = await boxValue(algod, registry, boxName(REG_BOX.head, major));
    return { major, version: head ? readU64(head, 0) : 0n, beta };
  }
  // EVERYONE ELSE gets exactly `stable_version`, which may LAG its line. That
  // lag is the mechanism: it lets v1.0.0 stay public while v1.1.0 is beta-tested,
  // and lets the tested change land later as an IN-PLACE upgrade.
  const version = asU(g, 'stable_version');
  if (version === 0n) return { major: 0, version: 0n, beta };
  const major = Number(version / 1_000_000n);
  if (major < Number(asU(g, 'min_major'))) return { major: 0, version: 0n, beta };
  return { major, version, beta };
}
