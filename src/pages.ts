/**
 * Program size, and the three things that follow from it.
 *
 * Consensus v42 lifted the 8,192-byte program cap that an app's page count used
 * to encode. Three quantities now derive from how large a program actually is:
 *
 *   - how many extra pages a create or update has to declare
 *   - whether the transaction CARRYING the program pays the oversized surcharge
 *   - how many box references EVERY LATER CALL to that app has to name
 *
 * The third is the one that bites, and it is not intuitive. The AVM charges a
 * read budget against the OLD cap for every app, whatever its page count — this
 * was measured, not inferred: a passport created fresh at four extra pages still
 * failed a call with "read budget exceeded 1291 > 0", and 1,291 is exactly its
 * program size minus 8,192. Each box reference buys 1,024 bytes of that budget,
 * so a program over the cap needs box references on calls that touch no box at
 * all. Empty references are legal, cost nothing, and use only a slot.
 *
 * Every builder in this SDK pads to `boxRefsNeeded`. The overflow it pads for is
 * the LARGEST BUNDLED BUILD's (`programs.MAX_PROGRAM_OVERFLOW`), because a builder
 * cannot see which version a passport runs and one release serves them all —
 * including passports created fresh on the large build, which pay the same
 * budget. Today's builds sit under the cap, so padding is a no-op until a larger
 * one is bundled, at which point it switches on by itself.
 *
 * TWO DIFFERENT PAGES. Everything here counts in the 2,048-byte unit that
 * `extraPages` and minimum-balance use. The registry's version hash uses a
 * 4,096-byte page (`HASH_PAGE_BYTES`). They are unrelated quantities that share a
 * name, and mixing them produces numbers that look plausible and are wrong.
 */
import type { BoxReference } from 'algosdk';
import {
  BOX_READ_BOUND,
  EXTRA_PAGES,
  LEGACY_PROGRAM_CAP,
  OVERSIZED_PROGRAM_FEE,
  PROGRAM_PAGE_BYTES,
  READ_BUDGET_PER_BOX_REF,
} from './constants.js';
import type { Num } from './types.js';

/** Approval and clear together — the AVM sizes an app by both. */
export function programBytes(p: { approval: Uint8Array; clear: Uint8Array }): number {
  return p.approval.length + p.clear.length;
}

/**
 * The `extraPages` a program needs, never below `EXTRA_PAGES`.
 *
 * The floor is deliberate. Every passport ever created declared three, so a
 * builder that computed fewer for a small program would SHRINK a passport on
 * update — accepted by the ledger, and a refund of minimum balance, but a
 * surprise nobody asked for and a re-charge the next time it grows.
 */
export function extraPagesFor(bytes: Num): number {
  const pages = Math.ceil(Number(bytes) / PROGRAM_PAGE_BYTES);
  return Math.max(EXTRA_PAGES, pages - 1);
}

/**
 * The fee for the ONE transaction carrying a program.
 *
 * Consensus v42 surcharges per byte over the old cap, on the transaction that
 * carries the program — not on whether pages grow. A later update of an
 * already-large passport with another large program pays it again; an update
 * carrying a small program does not. Measured minimum was about a hundred over
 * base; `OVERSIZED_PROGRAM_FEE` is a flat cover with room.
 */
export function programFee(bytes: Num): number {
  return Number(bytes) > LEGACY_PROGRAM_CAP ? OVERSIZED_PROGRAM_FEE : 1000;
}

/** Bytes of program past the legacy cap: the read budget every call must buy back. */
export function programOverflow(bytes: Num): number {
  return Math.max(0, Number(bytes) - LEGACY_PROGRAM_CAP);
}

/**
 * How many box references a group that touches the app must carry.
 *
 * `ceil((overflow + bound * boxes) / 1024)`, with every named box counted at
 * `BOX_READ_BOUND` bytes — a bound, not a measurement, so a rule box that grows
 * cannot quietly push a group under budget. Real references count, wherever
 * they point: a registry box named in the same group buys budget too.
 */
export function boxRefsNeeded(overflow: Num, boxes: number): number {
  return Math.ceil((Number(overflow) + BOX_READ_BOUND * boxes) / READ_BUDGET_PER_BOX_REF);
}

/** A reference that names nothing. Buys read budget and uses one slot. */
export const EMPTY_BOX: BoxReference = { appIndex: 0n, name: new Uint8Array(0) };

/**
 * Pad ONE transaction's boxes so that, alone, it meets the budget.
 *
 * Never removes anything. Padding each transaction on its own is always enough
 * for a group of them — `boxRefsNeeded` is subadditive — so builders that emit
 * single transactions pad here and need no group-level bookkeeping.
 */
export function padBoxes(boxes: readonly BoxReference[], overflow: Num): BoxReference[] {
  const need = boxRefsNeeded(overflow, boxes.length);
  const out = [...boxes];
  while (out.length < need) out.push(EMPTY_BOX);
  return out;
}

/**
 * How many empty references a GROUP still needs, given each member's real
 * boxes. Zero for any group already naming three or more real boxes on a build
 * of today's size. The group builder decides which member has the slot room.
 */
export function groupPadding(boxCounts: readonly number[], overflow: Num): number {
  const total = boxCounts.reduce((n, c) => n + c, 0);
  return Math.max(0, boxRefsNeeded(overflow, total) - total);
}
