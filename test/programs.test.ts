/**
 * The bundled builds, and the guard that stops `explain` lying across eras.
 *
 * Four builds ship: two tiers (restricted for the public, full for beta) across
 * two eras (v1.0.0/v1.1.0, still installable forever because an approved version
 * cannot be un-approved, and v1.0.1/v1.1.1 from step 1).
 *
 * THE TEST THAT MATTERS HERE is the last one. Twenty-three pcs carry one message
 * on both old builds and a different one on both new builds — they agree within
 * an era and disagree across it. `explain` resolves a pc only when every bundled
 * map that has it agrees, so bundling all four is what makes those report
 * `ambiguous`. Ship only the new pair and they agree again, for the opposite
 * reason, and answer confidently wrong for every passport that has not upgraded.
 * If someone later prunes the old builds to save bundle size, this file fails.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_BUILDS, BUILDS } from '../dist/programs.js';
import { explain } from '../dist/simulate.js';
import { pageHash } from '../dist/encode.js';
import { HASH_PAGE_BYTES } from '../dist/constants.js';
import { createHash } from 'node:crypto';

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const OLD = ['restricted@1.0.0', 'full@1.1.0'] as const;
const NEW = ['restricted@1.0.1', 'full@1.1.1'] as const;
// The beta line's next build. Full only — there is no restricted build on it.
const NEXT = ['full@1.1.2'] as const;

test('all five builds are bundled: both tiers in both eras, plus the beta line\'s next', () => {
  assert.equal(ALL_BUILDS.length, 5);
  for (const label of [...OLD, ...NEW, ...NEXT]) {
    assert.ok(BUILDS[label], `${label} must stay bundled`);
  }
  assert.deepEqual(
    ALL_BUILDS.map((b) => b.tier).sort(),
    ['full', 'full', 'full', 'restricted', 'restricted'],
  );
});

test('full@1.1.2 is the frozen build, by both digests in the NOTE', () => {
  // Two independent pins. The page hash is what the registry stores and what
  // its version box will hold once 1001002 is approved — already visible on the
  // suite-managed fixture. The plain sha256 is what identifies the bytes
  // themselves, independent of the hashing scheme. Either alone could be
  // satisfied by a mistake the other catches.
  const b = BUILDS['full@1.1.2'];
  assert.equal(b.approval.length, 10_588);
  assert.equal(b.clear.length, 4);
  assert.equal(b.pageHash, '196ffc1c458b52885007c81c70423ea1a275c62a02d7d8b8f12306280ac35629');
  assert.equal(
    createHash('sha256').update(b.approval).digest('hex'),
    'c09607df40079f46af414a3832a5b0e5d9b0958882e14fc438755df264c730f9',
  );
  assert.equal(
    createHash('sha256').update(b.clear).digest('hex'),
    'ed90f0d2da1f1d1abd773c45230651a292a90edbc12a7bf859a493a12a640ce7',
  );
  assert.equal(b.tier, 'full');
});

test('each declared pageHash really is the hash of the bundled bytes', async () => {
  // Catches a bad regeneration: a hash copied from the wrong artifact, or bytes
  // and hash drifting apart. A version box can never be rewritten, so a wrong
  // hash here produces a creation the registry refuses and nothing can correct.
  for (const b of ALL_BUILDS) {
    assert.equal(hex(await pageHash(b.approval, HASH_PAGE_BYTES)), b.pageHash, b.label);
  }
});

test('the five builds are five distinct programs', () => {
  const hashes = new Set(ALL_BUILDS.map((b) => b.pageHash));
  assert.equal(hashes.size, 5, 'two builds sharing a page hash means a generation mistake');
});

test('an explicit build resolves pc 621 to that era, and never hedges', () => {
  const failure = 'logic eval error: assert failed pc=621. Details: app=99';
  for (const label of OLD) {
    const r = explain(failure, { build: BUILDS[label] });
    assert.equal(r.reason, 'check self.owner exists', label);
    assert.equal(r.ambiguous, undefined);
  }
  for (const label of NEW) {
    const r = explain(failure, { build: BUILDS[label] });
    assert.equal(r.reason, 'version mismatch', label);
    assert.equal(r.ambiguous, undefined);
  }
});

test('without a build, a pc that changed meaning across eras is AMBIGUOUS', () => {
  // The regression guard. With only the new pair bundled this returns a confident
  // "version mismatch" for a v1.0.0 passport, which is a lie the caller cannot
  // detect. Keeping the old maps is what turns it into a refusal to answer.
  const r = explain('logic eval error: assert failed pc=621. Details: app=99');
  assert.equal(r.ambiguous, true);
  assert.equal(r.reason, undefined, 'must not name a guard when the eras disagree');
  assert.equal(r.pc, 621);
});

test('the named cross-era pcs all refuse to answer without a build', () => {
  // Sampled from diffing the deployed and step-1 maps. Each of these resolves
  // confidently with only one era bundled, and each confident answer is wrong for
  // roughly half the fleet.
  for (const pc of [591, 621, 1129, 1767]) {
    const r = explain(`logic eval error: assert failed pc=${pc}. Details: app=99`);
    assert.equal(r.ambiguous, true, `pc ${pc} must not be answered without a build`);
    assert.equal(r.reason, undefined, `pc ${pc}`);
  }
});

test('pc 1767 is the worst shape: a wrong answer that reads like a product limit', () => {
  // Not a clean era flip — it exists in only TWO of the four maps, and those two
  // disagree. On full@1.1.0 it is a missing-state check; on restricted@1.0.1 it is
  // a sentence about which rule types the build supports. That second one is a
  // plausible PRODUCT answer, so whoever read it would go and rewrite a strategy
  // config that was never the problem. Silence is worth a great deal here.
  assert.equal(BUILDS['full@1.1.0'].assertMessages[1767], 'check self.order_count exists');
  assert.equal(
    BUILDS['restricted@1.0.1'].assertMessages[1767],
    'this version supports DCA and limit rules only',
  );
  assert.equal(BUILDS['restricted@1.0.0'].assertMessages[1767], undefined);
  assert.equal(BUILDS['full@1.1.1'].assertMessages[1767], undefined);

  // A pc that only SOME maps carry is still ambiguous when those maps disagree —
  // abstaining is not the same as agreeing.
  const r = explain('logic eval error: assert failed pc=1767. Details: app=99');
  assert.equal(r.ambiguous, true);
  assert.equal(r.reason, undefined);
});

test('pcs that changed meaning across eras are not a one-off', () => {
  // Both eras must still be present for this to hold, which is the point: the
  // count only stays above zero while the old pair is bundled.
  const old = OLD.map((l) => BUILDS[l].assertMessages);
  const neu = NEW.map((l) => BUILDS[l].assertMessages);
  // Defined answers only, because that is what `explain` compares: a map that
  // simply lacks the pc abstains rather than disagreeing.
  const answers = (maps: Readonly<Record<number, string>>[], pc: number) =>
    new Set(maps.map((m) => m[pc]).filter((x): x is string => x !== undefined));

  let flipped = 0;
  for (const key of new Set([...old, ...neu].flatMap((m) => Object.keys(m)))) {
    const pc = Number(key);
    const o = answers(old, pc);
    const n = answers(neu, pc);
    if (o.size === 1 && n.size === 1 && [...o][0] !== [...n][0]) flipped++;
  }
  assert.equal(flipped, 23, 'pcs that agree within each era but differ across them');
});
