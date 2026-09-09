/**
 * The passport program bytes, and the machinery to PROVE they are what the
 * registry approved.
 *
 * You cannot create a passport without the exact program bytes of the version the
 * owner is entitled to. The creating transaction carries them, the registry
 * re-hashes the pages inside the group, and anything that does not match is
 * refused. The registry stores only hashes, never bytes, so they are bundled here.
 *
 * FOUR BUILDS SHIP, across two tiers AND two eras. The tier split is the obvious
 * one: a RESTRICTED build for the public and a FULL build for beta, and handing a
 * public owner the full bytes fails the page-hash check, so choosing correctly is
 * not cosmetic. The era split is the one that surprises people — an approved
 * version can never be un-approved, so v1.0.0 and v1.1.0 stay installable
 * alongside v1.0.1 and v1.1.1 and owners upgrade whenever they like.
 *
 * Which means a passport you are asked to explain a failure for may be running any
 * of the four, and `assertMessages` is NOT interchangeable between them.
 *
 * Choose by ASKING THE REGISTRY. `buildForVersion` reads the hash the registry
 * stored for that version and returns whichever bundled build matches. A local
 * table mapping version numbers to bytes cannot work — the same bytes are approved
 * under many version numbers, so it would be stale by the next approval.
 *
 * If nothing matches, this SDK is older than the version being asked for. It
 * throws with every hash named rather than falling back to a build, because a
 * fallback produces a creation the registry rejects for reasons the error would
 * not show you.
 */
import type { Algodv2 } from 'algosdk';
import { HASH_PAGE_BYTES, REG_BOX } from './constants.js';
import { boxName, pageHash, readU64 } from './encode.js';
import { GENERATED, type GeneratedBuild } from './programs.gen.js';
import { boxValue, globals, hex } from './read.js';
import { betaHeadLine, reachableVersions, type ReachableVersion } from './entitlement.js';
import type { Num } from './types.js';

// `atob` rather than `Buffer`, so this stays browser-safe: `Buffer` is Node-only
// and would force a polyfill on anyone bundling the program bytes. `atob` decodes
// to latin-1, one character per byte, which is what a byte array wants.
const b64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Which tier a build serves. The public tier gets `restricted`. */
export type BuildTier = GeneratedBuild['tier'];

/**
 * `tier@version`, naming the release a build was CUT as.
 *
 * The union comes from the generated file, so adding a build there extends this
 * automatically and every exhaustive switch stops compiling until it is handled.
 * The version in the name is an identifier, NOT a lookup key — the same bytes can
 * be approved under many version numbers, which is why `buildForVersion` asks the
 * registry by hash instead of indexing anything by version.
 */
export type BuildLabel = keyof typeof GENERATED;

export interface Build {
  /**
   * Which build this is, as `tier@version`. DIAGNOSTIC ONLY — never display it.
   *
   * It names the BYTES, not the version an owner is running, and the two come
   * apart the moment a line reaches parity. When v1.0.2 shipped bytes identical
   * to v1.1.1, `buildForVersion(1000002)` began returning `full@1.1.1` — correct
   * about the program, and a beta-looking string to show a public-channel owner.
   *
   * A `Build` cannot carry the version, and that is deliberate rather than an
   * oversight: the same bytes are approved under many version numbers, which is
   * exactly why this resolves by hash instead of by table. The version belongs to
   * the caller, who passed it in.
   *
   * To display a version, format the VERSION: `version.format(state.version)`
   * gives `v1.0.2`. Reach for this only in logs, errors and support output.
   */
  readonly label: BuildLabel;
  /**
   * The tier these bytes were CUT for. Diagnostic only, and the more misleading
   * of the two — it reads as "which tier is this owner on" and is not.
   *
   * After a line reaches parity the public tier runs the full build, so a stable
   * owner's build reports `full`. Which channel an owner is actually on comes
   * from `read.entitled().beta`, never from here.
   */
  readonly tier: BuildTier;
  readonly approval: Uint8Array;
  readonly clear: Uint8Array;
  /** The page-hash the registry stores for this program. */
  readonly pageHash: string;
  /**
   * pc -> the SOURCE message of the assert that failed, FOR THIS BUILD ONLY.
   *
   * The AVM's `assert` carries no string, so a node reports only `assert failed
   * pc=N`. The four maps are NOT interchangeable. Across all four there are 788
   * distinct pcs and only FIVE appear in every map, so the wrong map usually
   * returns nothing — and where it does return something it can be confidently
   * wrong. pc 621 is "check self.owner exists" on both 1.0.0/1.1.0 builds and
   * "version mismatch" on both 1.0.1/1.1.1 builds.
   *
   * Resolve through the build you actually submitted. `buildForVersion` gets it
   * from the passport's own version without you having to choose.
   */
  readonly assertMessages: Readonly<Record<number, string>>;
}

const materialise = (label: BuildLabel): Build => {
  const g: GeneratedBuild = GENERATED[label];
  return {
    label,
    tier: g.tier,
    approval: b64(g.approvalB64),
    clear: b64(g.clearB64),
    pageHash: g.pageHash,
    assertMessages: g.assertMessages,
  };
};

/**
 * Every bundled build, by label.
 *
 * There is deliberately no `BUILDS.full` shortcut any more. Two builds now answer
 * to "full", from different eras, and the whole failure this guards against is
 * picking one of them by habit — so the choice has to be written down.
 */
export const BUILDS: Readonly<Record<BuildLabel, Build>> = Object.fromEntries(
  (Object.keys(GENERATED) as BuildLabel[]).map((label) => [label, materialise(label)]),
) as Readonly<Record<BuildLabel, Build>>;

/** Every bundled build, for callers that must search rather than choose. */
export const ALL_BUILDS: readonly Build[] = Object.values(BUILDS);

async function storedHashes(
  algod: Algodv2,
  registry: Num,
  version: Num,
): Promise<{ approval: string; clear: string }> {
  // ONE NAMED BOX. Through `boxes()` this listed and downloaded every box
  // on the registry — which grows by two per passport created — in order
  // to read `v`+version. It runs on the CREATE path, where the registry is
  // at its largest. See `read.boxValue`.
  const box = await boxValue(algod, registry, boxName(REG_BOX.version, version));
  if (!box) throw new Error(`registry ${registry} has no approved version ${version}`);
  return { approval: hex(box.subarray(0, 32)), clear: hex(box.subarray(32, 64)) };
}

/**
 * Which bundled build the registry approved as `version`.
 *
 * Ask the REGISTRY, never a local table. Version-to-program is a deploy-time
 * decision that lives on chain — the launch config happens to pair v1.0.0 with
 * restricted and v1.1.0 with full, but a later line could pair them differently and
 * a table here would be a second source of truth.
 *
 * Throws with every hash named when nothing matches, which is the honest report for
 * "this SDK is older than that version". Falling back to a build would produce a
 * creation the registry rejects for reasons the caller cannot see.
 *
 * Page size is 4096 bytes — NOT the 2048-byte unit `extraPages` and min-balance
 * count. Two different quantities both call themselves a page, and the wrong one
 * silently produces a hash nothing can ever satisfy — and permanently, since a
 * version box can never be rewritten.
 */
export async function buildForVersion(
  algod: Algodv2,
  registry: Num,
  version: Num,
): Promise<Build> {
  const want = await storedHashes(algod, registry, version);
  for (const build of ALL_BUILDS) {
    const approval = hex(await pageHash(build.approval, HASH_PAGE_BYTES));
    const clear = hex(await pageHash(build.clear, HASH_PAGE_BYTES));
    if (approval === want.approval && clear === want.clear) return build;
  }
  const bundled = ALL_BUILDS.map((b) => `${b.label}=${b.pageHash}`).join(', ');
  throw new Error(
    `no bundled build matches version ${version}: registry wants ` +
      `${want.approval}, this SDK has ${bundled}. Regenerate programs.gen.ts from ` +
      `the contracts repo, or the version predates this SDK.`,
  );
}

/**
 * Turn "the bytes are not what the registry approved" into a clear local error
 * rather than an on-chain `approval program not approved`, which reads like a
 * permission problem.
 *
 * Pass a `build` to check one specifically; omit it to accept any bundled build,
 * which is what a caller about to create a passport wants — it asks "can I serve
 * this version at all", and `matched` says with which.
 *
 * `matched` is a BuildLabel, so it is diagnostic like every other label: it names
 * the bytes that satisfied the registry, not the version asked for. Those differ
 * whenever one program serves several versions.
 */
export async function verifyVersion(
  algod: Algodv2,
  registry: Num,
  version: Num,
  build?: Build,
): Promise<{ ok: boolean; matched?: BuildLabel; expected: string; actual?: string }> {
  const want = await storedHashes(algod, registry, version);
  if (build) {
    const actual = hex(await pageHash(build.approval, HASH_PAGE_BYTES));
    const clear = hex(await pageHash(build.clear, HASH_PAGE_BYTES));
    const ok = actual === want.approval && clear === want.clear;
    return ok
      ? { ok, matched: build.label, expected: want.approval, actual }
      : { ok, expected: want.approval, actual };
  }
  try {
    const found = await buildForVersion(algod, registry, version);
    return { ok: true, matched: found.label, expected: want.approval, actual: found.pageHash };
  } catch {
    return { ok: false, expected: want.approval };
  }
}

export interface CoverageEntry extends ReachableVersion {
  /** False when this SDK carries no build matching what the registry approved. */
  ok: boolean;
  /** Which bundled build serves it. Diagnostic — see `Build.label`. */
  label?: BuildLabel;
}

export interface Coverage {
  /** True when every reachable version resolves to a bundled build. */
  ok: boolean;
  entries: CoverageEntry[];
}

/**
 * Can this SDK serve everything this registry can hand out?
 *
 * ASK AT STARTUP, NOT AT CREATE. The failure this catches is a bundle older than
 * the registry, and left unchecked it surfaces at the worst possible moment: a
 * user clicks create, and `buildForVersion` throws because the version they are
 * entitled to is newer than anything shipped here. That is a deploy problem
 * wearing a user's error message.
 *
 * TWO VERSIONS, ALWAYS. A registry can hand out exactly what its two tiers
 * resolve to — `stable_version`, and the head of `beta_line` — and nothing else.
 * See `entitlement.reachableVersions` for why that is the complete answer rather
 * than a sample, and why the tempting alternatives are each wrong.
 *
 * Costs four named reads and NO listing: the globals, the beta head box, and one
 * `v`+version box per tier. That matters because a registry gains two boxes per
 * passport ever created, so anything that enumerates gets slower for everyone as
 * adoption grows while looking fine in a test against a registry holding four.
 *
 * `ok` is true when nothing failed, which includes a registry that entitles
 * nobody yet — an empty answer is not a gap in coverage.
 */
export async function coverage(algod: Algodv2, registry: Num): Promise<Coverage> {
  const g = await globals(algod, registry);
  const line = betaHeadLine(g);
  const head = line ? await boxValue(algod, registry, boxName(REG_BOX.head, line)) : null;

  const entries: CoverageEntry[] = [];
  for (const target of reachableVersions(g, head ? readU64(head, 0) : null)) {
    const v = await verifyVersion(algod, registry, target.version);
    entries.push({ ...target, ok: v.ok, ...(v.matched ? { label: v.matched } : {}) });
  }
  return { ok: entries.every((e) => e.ok), entries };
}
