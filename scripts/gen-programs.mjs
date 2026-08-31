/**
 * Emit src/programs.gen.ts from a directory of arc56 artifacts.
 *
 *   node scripts/gen-programs.mjs <artifact-dir> [--force]
 *
 * The artifacts are NOT in this repo — they are build output from the contracts
 * repo, and `logs/` is ignored. This script is here because the METHOD is the
 * part worth keeping: which arc56 fields matter, how a page hash is computed, and
 * how to know the extraction is right before trusting it on new builds.
 *
 * ## It validates itself first
 *
 * Before emitting anything it rebuilds every build ALREADY in programs.gen.ts
 * from the supplied artifacts and diffs approval bytes, clear bytes, page hash
 * and the whole assert map. If any of them fails to reproduce byte-for-byte it
 * refuses to write, because a generator that cannot recreate what is already
 * shipped has no business producing what will be.
 *
 * That check is the reason to run this rather than hand-editing. It is also why
 * `--force` exists and should be reached for only when the previously bundled
 * builds are deliberately being dropped.
 *
 * ## Two things that are easy to get wrong
 *
 * THE PAGE SIZE IS 4096 BYTES, not the 2048-byte unit `extraPages` and
 * minimum-balance use. Two different quantities are both called a page, and the
 * wrong one yields a hash the registry stores happily and nothing can ever
 * satisfy — permanently, since a version box cannot be rewritten.
 *
 * ASSERT MESSAGES ARE PER-PC, NOT PER-ENTRY. arc56 groups them: one entry
 * carries an `errorMessage` and a LIST of pcs that share it. Reading the entries
 * without expanding that list loses most of the map.
 *
 * ## Labels
 *
 * Keyed `tier@version`, where the version names the release a build was cut as.
 * It is an identifier, never a lookup key — the same bytes can be approved under
 * many version numbers, which is why `buildForVersion` asks the registry by hash.
 * Filenames are expected to look like `v1.0.1-public-6895.arc56.json`; `public`
 * maps to the `restricted` tier, which is what the SDK calls it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT = 'src/programs.gen.ts';
const args = process.argv.slice(2);
const force = args.includes('--force');
const dir = args.find((a) => !a.startsWith('--'));

if (!dir) {
  console.error('usage: node scripts/gen-programs.mjs <artifact-dir> [--force]');
  process.exit(2);
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/** Mirrors encode.pageHash: sha256 over the concatenated per-4096-byte-page sha256s. */
function pageHash(program, pageBytes = 4096) {
  const acc = [];
  for (let i = 0; i < program.length; i += pageBytes) {
    acc.push(sha256(program.subarray(i, i + pageBytes)));
  }
  return sha256(Buffer.concat(acc));
}

/** pc -> errorMessage, expanding each entry's pc list, in numeric key order. */
function assertMap(arc56) {
  const out = {};
  for (const e of arc56.sourceInfo?.approval?.sourceInfo ?? []) {
    if (!e.errorMessage) continue;
    for (const pc of e.pc ?? []) out[pc] = e.errorMessage;
  }
  return Object.fromEntries(
    Object.keys(out)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => [k, out[k]]),
  );
}

/** `v1.0.1-public-6895.arc56.json` -> { label, tier }. */
function labelFor(file) {
  const m = /^v(\d+\.\d+\.\d+)-(public|restricted|full)-/.exec(path.basename(file));
  if (!m) throw new Error(`cannot read a version and tier from ${file}`);
  const tier = m[2] === 'public' ? 'restricted' : m[2];
  return { label: `${tier}@${m[1]}`, tier };
}

function extract(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!j.byteCode?.approval) throw new Error(`${file} has no byteCode.approval`);
  const approval = Buffer.from(j.byteCode.approval, 'base64');
  return {
    ...labelFor(file),
    approvalB64: j.byteCode.approval,
    clearB64: j.byteCode.clear,
    approvalBytes: approval.length,
    pageHash: pageHash(approval).toString('hex'),
    assertMessages: assertMap(j),
  };
}

/** What programs.gen.ts currently ships, parsed out of the generated file. */
function bundled() {
  if (!fs.existsSync(OUT)) return {};
  const src = fs.readFileSync(OUT, 'utf8');
  const labels = [...src.matchAll(/^ {2}'([^']+)': \{/gm)].map((m) => m[1]);
  const all = (re) => [...src.matchAll(re)].map((m) => m[1]);
  const approvals = all(/approvalB64:\s*\n?\s*'([^']+)'/g);
  const clears = all(/clearB64: '([^']+)'/g);
  const hashes = all(/pageHash: '([^']+)'/g);
  const maps = all(/assertMessages:\s*(\{[\s\S]*?\})\s*,?\s*\n\s*\}/g).map((x) => eval(`(${x})`));
  return Object.fromEntries(
    labels.map((l, i) => [
      l,
      { approvalB64: approvals[i], clearB64: clears[i], pageHash: hashes[i], assertMessages: maps[i] },
    ]),
  );
}

const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.arc56.json'))
  .sort()
  .map((f) => path.join(dir, f));

if (!files.length) {
  console.error(`no *.arc56.json in ${dir}`);
  process.exit(2);
}

const rows = files.map(extract);
const byLabel = new Map(rows.map((r) => [r.label, r]));

// ── the self-check ──────────────────────────────────────────────────────────
const current = bundled();
const missing = [];
let mismatched = 0;

for (const [label, want] of Object.entries(current)) {
  const got = byLabel.get(label);
  if (!got) {
    missing.push(label);
    continue;
  }
  const fields = ['approvalB64', 'clearB64', 'pageHash'].filter((k) => got[k] !== want[k]);
  if (JSON.stringify(got.assertMessages) !== JSON.stringify(want.assertMessages)) {
    fields.push('assertMessages');
  }
  if (fields.length) {
    mismatched++;
    console.error(`  MISMATCH ${label}: ${fields.join(', ')}`);
  } else {
    console.log(`  reproduced ${label}`);
  }
}

if (missing.length) {
  console.error(`\n${missing.length} currently bundled build(s) absent from ${dir}: ${missing.join(', ')}`);
  console.error('Dropping a build is how `explain` starts answering confidently and wrongly for');
  console.error('anyone still running it, and how `buildForVersion` starts throwing on a live');
  console.error('registry. Supply every artifact, or pass --force if the drop is deliberate.');
}
if (mismatched) {
  console.error(`\n${mismatched} bundled build(s) did not reproduce.`);
  console.error('The extraction path disagrees with what is shipped, so it cannot be trusted');
  console.error('on new builds either. Fix that before regenerating.');
}
if ((missing.length || mismatched) && !force) {
  console.error('\nRefusing to write. Re-run with --force only if you mean it.');
  process.exit(1);
}

// ── emit ────────────────────────────────────────────────────────────────────

/**
 * How much of `explain`'s caution these maps actually buy.
 *
 * A pc resolves only when every bundled map that HAS it agrees, so counting the
 * pcs where they disagree measures what carrying all of them is worth: each one
 * is a place a smaller bundle would answer confidently and wrongly.
 */
function ambiguity(builds) {
  const pcs = new Set(builds.flatMap((r) => Object.keys(r.assertMessages)));
  let ambiguous = 0;
  let example;
  for (const pc of [...pcs].sort((a, b) => Number(a) - Number(b))) {
    const answers = new Set(
      builds.map((r) => r.assertMessages[pc]).filter((m) => m !== undefined),
    );
    if (answers.size > 1) {
      ambiguous++;
      example ??= { pc, answers: [...answers] };
    }
  }
  return { total: pcs.size, ambiguous, example };
}

const amb = ambiguity(rows);
const ambLine = amb.example
  ? [
      ` * Across these ${rows.length} builds there are ${amb.total} distinct pcs, of which ${amb.ambiguous} carry`,
      ` * more than one meaning. pc ${amb.example.pc}, for instance, is any of:`,
      ' *',
      ...amb.example.answers.map((a) => ` *   ${a}`),
      ' *',
      ' * Each such pc is a place a smaller bundle answers confidently and wrongly.',
      ' *',
    ].join('\n')
  : ' * The bundled maps agree everywhere they overlap.\n *';

const listing = rows
  .map((r) => ` * ${r.label.padEnd(17)} ${String(r.approvalBytes).padStart(4)} B  page-hash ${r.pageHash}`)
  .join('\n');

const header = `/**
 * GENERATED from the contracts build. DO NOT EDIT.
 *
 * Written by scripts/gen-programs.mjs from a directory of arc56 artifacts, which
 * are build output and deliberately not in this repo. Regenerate rather than
 * hand-edit: the script refuses to write unless it can first reproduce every
 * build already shipped here, byte for byte.
 *
 * EVERY LIVE BUILD STAYS BUNDLED, not for completeness. An approved version can
 * never be un-approved, so a registry keeps pointing at old versions for as long
 * as any owner has not upgraded. Drop one and two things break at once:
 * \`buildForVersion\` throws for a version that is still live, so a passport can no
 * longer be created or upgraded there at all; and pcs that agree within an era
 * but differ across it start resolving CONFIDENTLY and wrongly in \`explain\`,
 * because nothing is left to disagree with them.
 *
${ambLine}
${listing}
 */

export interface GeneratedBuild {
  /** Which tier this program serves. The public tier gets \`restricted\`. */
  readonly tier: 'restricted' | 'full';
  readonly approvalB64: string;
  readonly clearB64: string;
  readonly pageHash: string;
  readonly assertMessages: Readonly<Record<number, string>>;
}

/**
 * Keyed \`tier@version\`, where the version names the release a build was cut as —
 * an identifier, not a lookup key. The same bytes can be approved under many
 * version numbers, so resolving a version to a program is \`buildForVersion\`'s
 * job and it asks the registry by hash. Never index this by a version.
 */
export const GENERATED = {
`;

const body = rows
  .map((r) => {
    const asserts = Object.entries(r.assertMessages)
      .map(([pc, m]) => `${pc}: ${JSON.stringify(m)}`)
      .join(', ');
    return `  '${r.label}': {
    tier: '${r.tier}',
    approvalB64:
      '${r.approvalB64}',
    clearB64: '${r.clearB64}',
    pageHash: '${r.pageHash}',
    assertMessages: {${asserts}},
  },`;
  })
  .join('\n');

fs.writeFileSync(OUT, `${header}${body}\n} satisfies Record<string, GeneratedBuild>;\n`);

console.log(`\nwrote ${OUT}`);
for (const r of rows) {
  console.log(
    `  ${r.label.padEnd(18)} ${String(r.approvalBytes).padStart(4)} B  ${Object.keys(r.assertMessages).length} pcs  ${r.pageHash.slice(0, 16)}…`,
  );
}
console.log('\nNow run: npm test');
