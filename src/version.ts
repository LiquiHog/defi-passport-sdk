/**
 * Semantic versions, packed into the uint64 the contracts compare.
 *
 *     version = major * 1_000_000 + minor * 1_000 + patch
 *
 * so v1.2.3 is 1,002,003 — readable in an explorer, and "bigger means newer"
 * still holds, which is what lets every existing on-chain comparison stay as it
 * was. Semver here is an ENCODING, not a new mechanism.
 *
 * The three parts mean what they FORCE, not how big they are:
 *
 *   MAJOR - *migration*. Record layout or schema changed. CANNOT be applied as an
 *           in-place update: the passport refuses one, because new code reading
 *           an old layout is how committed balances get stranded. Crossing a major
 *           means a FRESH passport and a deliberate migration.
 *   MINOR - *interface*. The ABI changed. In-place is safe for funds, but every
 *           caller (this SDK included) must be updated.
 *   PATCH - *fix*. Behaviour and guards only. In-place, nothing outside notices.
 */
import type { Num } from './types.js';

export const MAJOR_MUL = 1_000_000n;
export const MINOR_MUL = 1_000n;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Pack a semver. THE RANGE CHECK LIVES HERE, not on chain.
 *
 * On chain, `% 1000` makes minor and patch structurally under 1000, so an assert
 * for it could never fire — `1_000_000 + 1000` simply IS v1.1.0, which is legal
 * and still monotonic. The mistake worth catching is a caller who MEANT
 * "v1.0.1000", and that intent only exists here.
 */
export function pack(major: number, minor: number, patch: number): bigint {
  for (const [name, v] of [['major', major], ['minor', minor], ['patch', patch]] as const) {
    if (!Number.isInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer`);
  }
  if (major < 1) throw new RangeError('major must be at least 1');
  if (minor >= 1000 || patch >= 1000) {
    throw new RangeError(
      `minor and patch must be under 1000 (got ${minor}.${patch}) — the packing ` +
        `would silently roll them into the next minor/major`,
    );
  }
  return BigInt(major) * MAJOR_MUL + BigInt(minor) * MINOR_MUL + BigInt(patch);
}

export function unpack(version: Num): Semver {
  const v = BigInt(version);
  return {
    major: Number(v / MAJOR_MUL),
    minor: Number((v / MINOR_MUL) % MINOR_MUL),
    patch: Number(v % MINOR_MUL),
  };
}

/** `v1.2.3`. */
export function format(version: Num): string {
  const { major, minor, patch } = unpack(version);
  return `v${major}.${minor}.${patch}`;
}

export const majorOf = (version: Num): number => Number(BigInt(version) / MAJOR_MUL);

/**
 * Would moving from `from` to `to` be accepted as an IN-PLACE update?
 *
 * Mirrors the passport's two guards: forward only, and never across a major.
 * Surface this in a UI before asking anyone to sign — "this release needs a new
 * passport" is a very different conversation from "click upgrade".
 */
export function inPlaceUpgradeOk(from: Num, to: Num): { ok: boolean; reason?: string } {
  const f = BigInt(from);
  const t = BigInt(to);
  if (f === 0n) return { ok: false, reason: 'version not attested yet — link the passport first' };
  if (t <= f) return { ok: false, reason: 'downgrade blocked — roll forward instead' };
  if (majorOf(t) !== majorOf(f)) {
    return {
      ok: false,
      reason:
        `major bump (${format(f)} -> ${format(t)}) needs a FRESH passport and a ` +
        `migration — record layouts differ, so an in-place swap would strand funds`,
    };
  }
  return { ok: true };
}
