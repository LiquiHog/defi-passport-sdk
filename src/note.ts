/**
 * Transaction notes, in ARC-2 form, so an indexer can attribute activity.
 *
 * WHY THIS MATTERS MOST FOR THE TRANSACTIONS THAT ARE NOT APP CALLS. An
 * application call already tells an indexer everything: the app id identifies the
 * passport and the first argument is the method selector. A DEPOSIT does not — it
 * is a bare payment or asset transfer to an application address, indistinguishable
 * from someone sending funds by hand. Without a note there is nothing on chain to
 * say it was a deposit into a passport, which asset it was meant for, or which
 * passport it belongs to. So notes are not decoration here; on the value-in path
 * they are the only record of intent.
 *
 * ARC-2 is the ecosystem convention (`<dapp-name>:<format><data>`), so existing
 * indexers already split it without special-casing us. Format `j` = JSON.
 *
 * NOTES ARE FREE. Algorand's minimum fee is flat per transaction, not per byte,
 * and no contract in this system reads `Txn.note` — verified across all four —
 * so adding one changes nothing about validation or cost. It does change the
 * TXID, which is occasionally useful: identical transactions in one group collide
 * as duplicates, and a distinct note separates them.
 *
 * Keep the payload SMALL. It is on chain for ever and an indexer pays to store it.
 * Anything recoverable from the transaction itself does not belong here.
 */
import type { Num } from './types.js';

/** ARC-2 dapp name. Must match `[a-zA-Z0-9][a-zA-Z0-9_/@.-]{4,31}`. */
export const NOTE_DAPP = 'defi-passport';

/** Bump only on a BREAKING payload change; indexers switch on it. */
export const NOTE_VERSION = 1;

export interface NoteFields {
  /** Operation. For app calls this is the ABI method name, set automatically. */
  t: string;
  /** Note schema version. */
  v: number;
  /** Passport app id — included only where the transaction does not reveal it. */
  p?: string;
  /** Asset id, on the value-in path. */
  a?: string;
  [k: string]: unknown;
}

/**
 * Build an ARC-2 note.
 *
 * Numbers are emitted as STRINGS. Asset and app ids exceed 2^53 on a long enough
 * timeline and JSON has no integer type, so a consumer doing `JSON.parse` would
 * silently lose precision on a float. Strings round-trip exactly.
 */
export function arc2(t: string, extra: Record<string, Num | string> = {}): Uint8Array {
  const body: NoteFields = { t, v: NOTE_VERSION };
  for (const [k, val] of Object.entries(extra)) {
    body[k] = typeof val === 'string' ? val : String(val);
  }
  return new TextEncoder().encode(`${NOTE_DAPP}:j${JSON.stringify(body)}`);
}

/**
 * Parse one of our notes back, or `undefined` if it is not ours.
 *
 * Deliberately total: an indexer reads notes written by anyone, so this must
 * survive arbitrary bytes rather than throw. Malformed JSON under our own prefix
 * returns undefined too — a wrong shape is not our note however it is labelled.
 */
export function parseNote(note?: Uint8Array | null): NoteFields | undefined {
  if (!note || note.length === 0) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(note);
  } catch {
    return undefined;
  }
  const prefix = `${NOTE_DAPP}:j`;
  if (!text.startsWith(prefix)) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(prefix.length));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const f = parsed as NoteFields;
    return typeof f.t === 'string' ? f : undefined;
  } catch {
    return undefined;
  }
}
