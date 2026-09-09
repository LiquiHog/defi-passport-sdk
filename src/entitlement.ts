/**
 * Which version an address may install — the derivation, with no network in it.
 *
 * This is pure on purpose. The registry's rule is small, but it is stated twice
 * (once in the contract's `_entitled`, once here) and the two halves have to
 * agree exactly or a group fails on a BOX REFERENCE, which reads like a
 * permissions bug. A pure function is the only version of that agreement you can
 * test without a chain, a funded account and a registry in the right state.
 *
 * `read.entitled` is the async wrapper: it fetches globals, probes the `w` box
 * and calls these. Reach for that unless you are writing a test.
 *
 * ## A LINE IS NOT A MAJOR
 *
 * The registry keys version lines two different ways depending on whether the
 * step-0 migration has run:
 *
 *   before  line = major                 v1.0.x and v1.1.x SHARE one head box
 *   after   line = major * 1000 + minor  they are two independent lines
 *
 * The head box is `h` + u64(LINE) in both shapes, so the same SDK build names a
 * different box against each. There is no version of this you can compute from a
 * version number alone — you have to know which shape the registry is in, which
 * is why `detectShape` exists and why `line`, never `major`, is what comes back.
 *
 * `majorOf` and `inPlaceUpgradeOk` in `version.ts` are the one place a MAJOR is
 * still the right unit: the passport's own upgrade guard is on `v // 1_000_000`
 * and did not change. Do not "fix" those to use lines.
 */
import type { Globals } from './read.js';
import { MAJOR_MUL, MINOR_MUL } from './version.js';

/** Local by design: `read.ts` keeps its own copy of this private. */
const asU = (g: Globals, k: string): bigint => (typeof g[k] === 'bigint' ? (g[k] as bigint) : 0n);

/**
 * How a registry keys its head boxes.
 *
 *   `major`  pre-step-0:  `h` + u64(major)
 *   `line`   post-step-0: `h` + u64(major * 1000 + minor)
 */
export type RegistryShape = 'major' | 'line';

export interface LineResolution {
  /**
   * The head-box key for this address, or 0 when nothing is open to it.
   *
   * NOT a major. Feed it to `boxName(REG_BOX.head, line)` and to the `line`
   * arguments on `createGroup`, `linkGroup` and `upgradeGroup`.
   */
  line: number;
  /** True for an allowlisted address AND for the manager, which has no `w` box. */
  beta: boolean;
  migrated: boolean;
  /**
   * A line resolved, and `min_major` has retired it.
   *
   * Kept separate from `line: 0` because they are different answers to a user:
   * "your tier's line is no longer installable" versus "nothing is approved yet".
   */
  retired: boolean;
}

export interface Entitlement {
  /** See `LineResolution.line`. 0 means nothing is open to this address. */
  line: number;
  version: bigint;
  beta: boolean;
  /**
   * Which shape the registry was in when this was resolved.
   *
   * TEMPORARY. Every registry ends up migrated, at which point this is always
   * true and worth deleting. It is surfaced only so a client can tell the two
   * apart during the owner round, when both cohorts exist at once.
   */
  migrated: boolean;
}

/**
 * Which keying scheme this registry uses, or `null` if it is neither.
 *
 * `beta_line` is the only global the migration ADDS, so its presence is the
 * signal. `latest_major` is NOT: it survives the migration and stays live, so it
 * says "this is a registry", not "this registry is old".
 *
 * ## THE ONE CASE THIS CANNOT SEE
 *
 * `beta_line` is written by `set_beta_line`, not by the update — so between
 * updating the program and calling it, a registry is migrated and has no
 * `beta_line`, which is indistinguishable from an un-migrated one. This answers
 * `major` there, and a beta address then gets a head box the contract is not
 * looking at.
 *
 * Production cannot reach that state: step 0 sends the update and
 * `set_beta_line` as ONE atomic group. A harness that updates and approves
 * without calling `set_beta_line` can, and did — pass an explicit `shape` to
 * `resolveLine` if you are writing one.
 *
 * `null` means the globals look like neither shape, which in practice means the
 * app id is not a registry at all. That is worth throwing over; guessing is not.
 */
export function detectShape(g: Globals): RegistryShape | null {
  if ('beta_line' in g) return 'line';
  if ('latest_major' in g) return 'major';
  return null;
}

/**
 * Step one: which LINE this address resolves to. No box reads.
 *
 * The tiers do NOT resolve symmetrically, and that asymmetry is the whole of
 * what step 0 changed:
 *
 *   beta   -> the `beta_line` POINTER, whose head box holds the version
 *   stable -> derived from `stable_version` itself; no pointer, no head box
 *
 * Stable being pinned rather than headed is the launch shape, not an edge case:
 * v1.0.0 public while v1.1.0 is in beta. Handing a stable owner their line's
 * head names a version the registry refuses.
 *
 * `min_major` is applied to BOTH tiers and is MAJOR-granular even after the
 * split — `line // 1000 >= min_major`. Retirement deliberately did not become
 * minor-granular, so retiring a major takes all of its minor lines with it.
 * Dropping that division is the mistake this function exists to make testable:
 * with `min_major` 25, `24000 // 1000 >= 25` is false and `24000 >= 25` is true,
 * and only the first is what the contract enforces.
 */
export function resolveLine(
  g: Globals,
  who: { isManager: boolean; hasBetaBox: boolean },
  shape?: RegistryShape,
): LineResolution {
  const s = shape ?? detectShape(g);
  if (s === null) {
    throw new Error(
      'registry globals have neither `beta_line` nor `latest_major`: this is not a ' +
        'version registry, or not one this SDK understands. Refusing to guess which ' +
        'head-box keying it uses, because the wrong guess fails at signing time as ' +
        'an "invalid Box reference" naming a box you had no reason to doubt.',
    );
  }
  const migrated = s === 'line';
  // THE MANAGER IS ALWAYS BETA AND HAS NO `w` BOX — `_entitled` short-circuits
  // on it before ever looking. Anything that tests only for the box tells your
  // own admin address it has no line open, and during a closed beta the manager
  // is the only address entitled to anything at all.
  const beta = who.isManager || who.hasBetaBox;
  const none: LineResolution = { line: 0, beta, migrated, retired: false };

  // Asserted for BOTH tiers before the tier split, exactly as the contract does.
  if (asU(g, 'latest_major') === 0n) return none;

  let line: number;
  if (beta) {
    line = Number(migrated ? asU(g, 'beta_line') : asU(g, 'latest_major'));
  } else {
    const sv = asU(g, 'stable_version');
    if (sv === 0n) return none; // permissionless path not open
    // DERIVED FROM THE VERSION, never from a global. An older build wrote
    // `stable_major` and a newer one stopped; it still answers on any registry
    // that ever ran the old build, frozen at whatever it last held and reading
    // as perfectly live. Only the derivation matches what is enforced.
    line = Number(sv / (migrated ? MINOR_MUL : MAJOR_MUL));
  }

  if (line === 0) return none;
  // Pre-migration a line IS a major, so there is nothing to divide out.
  const major = migrated ? Math.floor(line / Number(MINOR_MUL)) : line;
  if (major < Number(asU(g, 'min_major'))) return { line, beta, migrated, retired: true };
  return { line, beta, migrated, retired: false };
}

export interface ReachableVersion {
  /** Which cohort reaches it. */
  tier: 'stable' | 'beta';
  /** The head-box key for that cohort. */
  line: number;
  version: bigint;
}

/**
 * The line a BETA address resolves through, or 0 when none is open to it.
 *
 * Exposed because the head box cannot be named until the line is known, and a
 * caller that wants the beta version has to read that box itself.
 */
export function betaHeadLine(g: Globals, shape?: RegistryShape): number {
  const r = resolveLine(g, { isManager: false, hasBetaBox: true }, shape);
  return r.retired ? 0 : r.line;
}

/**
 * Every version this registry can hand to anybody. There are exactly TWO.
 *
 * This is the whole reason a coverage check is worth shipping rather than
 * leaving to each caller. The obvious implementations are all wrong in different
 * ways: checking only `stable_version` misses the beta cohort entirely; checking
 * "every line head" needs the registry's boxes ENUMERATED, which costs a listing
 * that grows by two boxes per passport ever created; and checking only the
 * version you are about to use moves the failure to a user's create call instead
 * of catching it at startup.
 *
 * Neither tier can be handed anything else. A head box for some other line
 * entitles nobody, so verifying it proves nothing about what an owner can
 * receive — which is what makes two the complete answer rather than a sample.
 *
 * `betaHead` is the u64 inside `h` + u64(`betaHeadLine(g)`), or null. Versions
 * that resolve to 0 are omitted: a closed tier is not a gap in coverage.
 */
export function reachableVersions(
  g: Globals,
  betaHead: bigint | null,
  shape?: RegistryShape,
): ReachableVersion[] {
  const cohorts = [
    ['stable', { isManager: false, hasBetaBox: false }],
    ['beta', { isManager: false, hasBetaBox: true }],
  ] as const;
  const out: ReachableVersion[] = [];
  for (const [tier, who] of cohorts) {
    const e = resolveVersion(g, resolveLine(g, who, shape), betaHead);
    if (e.version > 0n) out.push({ tier, line: e.line, version: e.version });
  }
  return out;
}

/**
 * Step two: the version that line resolves to.
 *
 * `head` is the u64 inside `h` + u64(`r.line`), or null when that box is absent.
 * It is READ ONLY FOR BETA — stable never touches a head box, which is why a
 * wrong stable line is inert on chain and a wrong beta line is not.
 *
 * Split from `resolveLine` because the box cannot be named until the line is
 * known, and naming it is the only part of this that needs the network.
 */
export function resolveVersion(g: Globals, r: LineResolution, head: bigint | null): Entitlement {
  const { beta, migrated } = r;
  if (r.line === 0 || r.retired) return { line: 0, version: 0n, beta, migrated };
  if (beta) return { line: r.line, version: head ?? 0n, beta, migrated };
  return { line: r.line, version: asU(g, 'stable_version'), beta, migrated };
}
