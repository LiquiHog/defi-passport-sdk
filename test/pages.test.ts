/**
 * Program size, and the three things that follow from it.
 *
 * Consensus v42 lifted the 8,192-byte program cap, and a build over it changes
 * how many pages a create or update declares, whether that one transaction pays
 * a surcharge, and — the one that bites — how many box references EVERY later
 * call to the app must name, box or no box. That last rule was measured on
 * chain, not inferred: a passport created fresh at four extra pages still failed
 * with "read budget exceeded 1291 > 0", and 1,291 is its program minus 8,192.
 *
 * These pin the arithmetic against the numbers the contract team measured, and
 * assert that the overflow every builder pads for is DERIVED from the bundle
 * rather than declared — so bundling a larger build turns padding on by itself.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EMPTY_BOX,
  boxRefsNeeded,
  extraPagesFor,
  groupPadding,
  padBoxes,
  programBytes,
  programFee,
  programOverflow,
} from '../dist/pages.js';
import { ALL_BUILDS, MAX_PROGRAM_OVERFLOW } from '../dist/programs.js';
import { EXTRA_PAGES, LEGACY_PROGRAM_CAP, OVERSIZED_PROGRAM_FEE } from '../dist/constants.js';

// v1.1.2 as specified: approval 10,588 B, clear 4 B, six pages, extra_pages 5.
const V112 = 10_588 + 4;
// Every build bundled today.
const V111 = 6_911 + 4;

test('extraPagesFor: the pages a program needs, floored at what every passport has', () => {
  assert.equal(extraPagesFor(V111), 3, 'today\'s builds fit the floor');
  assert.equal(extraPagesFor(V112), 5, 'v1.1.2 is six pages, so five extra');
  assert.equal(extraPagesFor(LEGACY_PROGRAM_CAP), 3, 'exactly four pages is still the floor');
  assert.equal(extraPagesFor(LEGACY_PROGRAM_CAP + 1), 4, 'one byte over needs a fifth page');
  assert.equal(extraPagesFor(100), EXTRA_PAGES, 'a tiny program never shrinks below the floor');
});

test('programFee: the surcharge is on the transaction carrying an oversized program', () => {
  assert.equal(programFee(V111), 1000);
  assert.equal(programFee(LEGACY_PROGRAM_CAP), 1000, 'at the cap is not over it');
  assert.equal(programFee(LEGACY_PROGRAM_CAP + 1), OVERSIZED_PROGRAM_FEE);
  assert.equal(programFee(V112), OVERSIZED_PROGRAM_FEE);
});

test('programOverflow: bytes past the legacy cap, and never negative', () => {
  assert.equal(programOverflow(V111), 0);
  assert.equal(programOverflow(V112), 2_400, '10,588 + 4 - 8,192, the number in the brief');
  assert.equal(programBytes({ approval: new Uint8Array(10_588), clear: new Uint8Array(4) }), V112);
});

test('boxRefsNeeded follows the budget the node actually charges: 2,048 a reference', () => {
  // MEASURED, NOT ASSUMED. A live v1.1.2 passport (draw 2,400) refuses with
  // "read budget exceeded (2400 > 2048)" at one reference and passes at two.
  // The table the contract team wrote against the original 1,024-byte budget
  // said three — right then, one wasted reference now, and in a swap that
  // reference competes with the route's own.
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => boxRefsNeeded(2_400, n)),
    [2, 2, 2, 2, 2, 2, 2, 2, 2],
  );
  // and "nothing extra" now holds from TWO boxes up, because need <= have there
  for (let n = 2; n <= 16; n++) assert.ok(boxRefsNeeded(2_400, n) <= n, `n=${n}`);
});

test('the draws of several apps add up, and a reference covers 2,048 of the total', () => {
  // A swap group names its passport AND its router. Mainnet charged 5,707 for
  // exactly that pair (2,400 + 3,307): two references refused with
  // "read budget exceeded (5707 > 4096)", three passed.
  assert.equal(boxRefsNeeded(2_400 + 3_307, 0), 3);
  assert.equal(boxRefsNeeded(3_307, 0), 2);
});

test('boxRefsNeeded is a no-op for a program under the cap', () => {
  assert.equal(boxRefsNeeded(0, 0), 0);
  assert.equal(boxRefsNeeded(0, 1), 1);
  assert.equal(boxRefsNeeded(0, 8), 1, 'eight boxes at 128 B fit in one unit of budget');
});

test('padBoxes adds empties up to the need and never removes a real reference', () => {
  const real = { appIndex: 555n, name: new Uint8Array([0x63, 0x6d]) };
  assert.equal(padBoxes([], 2_400).length, 2);
  assert.deepEqual(padBoxes([real], 2_400).slice(0, 1), [real]);
  assert.equal(padBoxes([real], 2_400).length, 2);
  assert.deepEqual(padBoxes([real, real], 2_400), [real, real], 'two real boxes: untouched');
  assert.deepEqual(padBoxes([real], 0), [real], 'under the cap: untouched');
  assert.deepEqual(padBoxes([], 0), []);
});

test('an empty reference names nothing on the called app', () => {
  assert.equal(EMPTY_BOX.appIndex, 0n);
  assert.equal(EMPTY_BOX.name.length, 0);
});

test('padding each member separately is always enough for the group', () => {
  // boxRefsNeeded is subadditive, so builders that emit single transactions can
  // pad in isolation and any group assembled from them meets the budget. Check
  // it rather than trust the algebra.
  for (let a = 0; a <= 8; a++) {
    for (let b = 0; b <= 8; b++) {
      const separate = boxRefsNeeded(2_400, a) + boxRefsNeeded(2_400, b);
      assert.ok(separate >= boxRefsNeeded(2_400, a + b), `a=${a} b=${b}`);
    }
  }
});

test('groupPadding counts real references across the group', () => {
  assert.equal(groupPadding([2, 2], 2_400), 0, 'four real across two members');
  assert.equal(groupPadding([1], 2_400), 1);
  assert.equal(groupPadding([0, 0], 2_400), 2);
  assert.equal(groupPadding([4, 3, 1], 2_400), 0);
  assert.equal(groupPadding([0], 0), 0);
});

test('MAX_PROGRAM_OVERFLOW is derived from the largest bundled build', () => {
  // Recomputed here rather than pinned to a number, so this stays true the day
  // an oversized build is bundled and the constant becomes 2,400 on its own.
  const expected = Math.max(0, ...ALL_BUILDS.map((b) => programOverflow(programBytes(b))));
  assert.equal(MAX_PROGRAM_OVERFLOW, expected);
  assert.ok(MAX_PROGRAM_OVERFLOW >= 0);
});
