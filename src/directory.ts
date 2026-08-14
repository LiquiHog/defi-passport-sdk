/**
 * Resolving live contract ids through the directory, so the only app id you keep
 * in configuration is the directory itself.
 *
 * That id is a REQUIRED ARGUMENT here, never a default. Supply it from your own
 * configuration and verify the app's creator address before trusting what it
 * publishes.
 *
 * Two tiers, and the split is forced by the AVM: an application cannot read
 * another application's BOXES, only its globals. So anything a CONTRACT must act
 * on lives in a global under the exact key the contract looks up (`router`,
 * `budget`); the wider catalogue can live in boxes, which only off-chain
 * consumers read. A directory that puts the router in a box looks complete and
 * is unusable by any passport.
 */
import type { Algodv2 } from 'algosdk';
import { encodeAddress } from 'algosdk';
import { globals } from './read.js';
import type { DirectoryEntries, Num } from './types.js';

export interface ResolveOptions {
  /**
   * Ids that decide WHERE FUNDS GO must not be adopted unattended. Whoever holds
   * the directory's manager key would otherwise be able to redirect every
   * consumer's swaps — a strictly larger blast radius than the manual releases
   * this replaces. Pin them, or surface a confirmation, and only then override.
   *
   * The passport contract already works this way: `sync_contracts` refreshes
   * the router ONLY when the owner asks. An SDK should not be more trusting
   * than the contract is.
   */
  pinned?: Partial<Pick<DirectoryEntries, 'router' | 'budget'>>;
}

export const ZERO_ADDRESS =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'.slice(0, 58);

export interface Resolved extends DirectoryEntries {
  /** Bump this on any change so consumers can cache and poll one integer. */
  generation: bigint;
  /**
   * Which of `registry` / `keeper` / `oracle` are not published yet. A
   * production directory starts with all three absent, on purpose — see
   * `resolve`. Check this before using any of them.
   */
  unpublished: string[];
}

const cache = new Map<string, Resolved>();

export async function resolve(
  algod: Algodv2,
  directory: Num,
  opts: ResolveOptions = {},
): Promise<Resolved> {
  const g = await globals(algod, directory);
  const uint = (k: string): bigint => (typeof g[k] === 'bigint' ? (g[k] as bigint) : 0n);
  const addr = (k: string): string => {
    const v = g[k];
    return v instanceof Uint8Array ? encodeAddress(v) : '';
  };

  const out: Resolved = {
    router: opts.pinned?.router ?? uint('router'),
    budget: opts.pinned?.budget ?? uint('budget'),
    registry: uint('registry'),
    keeper: addr('keeper'),
    oracle: uint('oracle'),
    generation: uint('generation'),
    unpublished: [],
  };

  // `router` and `budget` are the two a passport's `sync_contracts` reads, so
  // a directory missing either is the wrong app. `registry`, `keeper` and
  // `oracle` may legitimately be UNPUBLISHED (0 / zero address) — an id that does
  // not exist yet is published as 0 rather than pointed somewhere wrong, and filled
  // in once it does. So report them as absent instead of throwing.
  for (const k of ['router', 'budget'] as const) {
    if (out[k] === 0n) {
      throw new Error(`directory ${directory} publishes no \`${k}\` — wrong app?`);
    }
  }
  out.unpublished = (['registry', 'keeper', 'oracle'] as const).filter(
    (k) => out[k] === 0n || out[k] === '' || out[k] === ZERO_ADDRESS,
  );
  cache.set(String(directory), out);
  return out;
}

/** The cached copy, if `resolve` has run for this directory in this process. */
export const cached = (directory: Num): Resolved | undefined =>
  cache.get(String(directory));

/**
 * Cheap staleness check: read one integer and compare. Only refetch the
 * catalogue when it moves.
 */
export async function changed(algod: Algodv2, directory: Num): Promise<boolean> {
  const have = cached(directory);
  if (!have) return true;
  const g = await globals(algod, directory);
  return (typeof g['generation'] === 'bigint' ? g['generation'] : 0n) !== have.generation;
}

/**
 * Prove a resolved id is a live application before trusting it. Turns a stale
 * catalogue into a caught error instead of a failed transaction.
 */
export async function verifyLive(algod: Algodv2, appId: Num): Promise<boolean> {
  try {
    await algod.getApplicationByID(BigInt(appId)).do();
    return true;
  } catch {
    return false;
  }
}
