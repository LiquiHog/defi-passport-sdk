/**
 * The passport program bytes, and the machinery to PROVE they are what the
 * registry approved.
 *
 * You cannot create a passport without the exact program bytes of the version the
 * owner is entitled to. The creating transaction carries them, the registry
 * re-hashes the pages inside the group, and anything that does not match is
 * refused. The registry stores only hashes, never bytes, so they are bundled here.
 *
 * TWO BUILDS SHIP, because two programs are live at once: a RESTRICTED build for
 * the public tier and a FULL build for beta. Handing a public owner the full bytes
 * fails the page-hash check and their creation is refused, so choosing correctly
 * is not cosmetic.
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
import { boxName, pageHash } from './encode.js';
import { GENERATED, type GeneratedBuild } from './programs.gen.js';
import { boxValue, hex } from './read.js';
import type { Num } from './types.js';

// `atob` rather than `Buffer`, so this stays browser-safe: `Buffer` is Node-only
// and would force a polyfill on anyone bundling the program bytes. `atob` decodes
// to latin-1, one character per byte, which is what a byte array wants.
const b64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export type BuildLabel = 'full' | 'restricted';

export interface Build {
  /** Which build this is. `restricted` is the public v1.0.0 tier. */
  readonly label: BuildLabel;
  readonly approval: Uint8Array;
  readonly clear: Uint8Array;
  /** The page-hash the registry stores for this program. */
  readonly pageHash: string;
  /**
   * pc -> the SOURCE message of the assert that failed, FOR THIS BUILD ONLY.
   *
   * The AVM's `assert` carries no string, so a node reports only `assert failed
   * pc=N`. The two builds' maps are NOT interchangeable: of 250 entries only 97
   * pcs are shared and NINE of those disagree, so the wrong map returns nothing
   * for most failures and a confident WRONG assert name for nine of them. Resolve
   * through the build you actually submitted.
   */
  readonly assertMessages: Readonly<Record<number, string>>;
}

const materialise = (label: BuildLabel, g: GeneratedBuild): Build => ({
  label,
  approval: b64(g.approvalB64),
  clear: b64(g.clearB64),
  pageHash: g.pageHash,
  assertMessages: g.assertMessages,
});

export const BUILDS: Readonly<Record<BuildLabel, Build>> = {
  full: materialise('full', GENERATED.full),
  restricted: materialise('restricted', GENERATED.restricted),
};

/** Every bundled build, for callers that must search rather than choose. */
export const ALL_BUILDS: readonly Build[] = [BUILDS.restricted, BUILDS.full];

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
