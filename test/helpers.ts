/**
 * The placeholders every offline test builds against.
 *
 * Nothing here is real. The builders are pure — they take a context and return
 * transactions, and never call algod — so a test needs a passport id, an owner
 * address and suggested params that are merely WELL-FORMED, not ones that exist.
 * Keeping them in one place means a test you add reads the same as the ones
 * here, and none of them can reach a chain by accident: `algod` is not a client.
 *
 * Use your own ids only in the live check (`npm run check`), which reads them
 * from a config file that stays out of the repo.
 */
import algosdk from 'algosdk';
import type { PassportCtx } from '../dist/types.js';

/** Suggested params: flat 1,000 µAlgo fee, rounds 1–1001, an all-zero genesis. */
export const PARAMS = {
  fee: 1000n,
  minFee: 1000n,
  firstValid: 1n,
  lastValid: 1001n,
  genesisID: 'testnet-v1.0',
  genesisHash: new Uint8Array(32),
  flatFee: true,
};

/** A valid address whose 32 bytes are all `n`. Distinct `n`, distinct address. */
export const addr = (n: number): string => algosdk.encodeAddress(new Uint8Array(32).fill(n));

/** A placeholder passport app id. */
export const PASSPORT = 555;

/** The placeholder owner. */
export const OWNER = addr(9);

/**
 * A passport context for the builders. `algod` is deliberately not a client:
 * a builder that tried to use it would fail the test rather than reach a node.
 */
export const ctx: PassportCtx = {
  algod: null as unknown as algosdk.Algodv2,
  registry: 1,
  params: PARAMS,
  owner: OWNER,
  passport: PASSPORT,
};

/** Bytes as lowercase hex, for asserting box names and arguments. */
export const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
