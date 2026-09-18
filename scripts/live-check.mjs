/**
 * The acceptance run: ONE SDK build against a registry's live state.
 *
 *   npm run live-check
 *   node scripts/live-check.mjs [--config <file>] [--url <algod>] [--passport <app-id>] [<app-id>[:line|major] ...]
 *
 * READS ONLY. Nothing here signs, submits, or needs an account or a key.
 *
 * WHICH REGISTRIES: the ids on the command line; else `maintainer.registries` in
 * your config (see sdk-test.config.example.json — each entry may carry a label
 * and a note, printed with its report); else the production registry.
 *
 * Per registry, the questions a unit test cannot reach:
 *
 * WHICH VERSION DOES EACH COHORT RESOLVE TO? A line is a major before the step-0
 * migration and `major * 1000 + minor` after it, and one build has to answer
 * correctly on either side. Every answer is cross-checked against the raw globals
 * rather than against the SDK's own derivation, so this cannot agree with a bug by
 * sharing it.
 *
 * DOES EVERY LIVE VERSION STILL RESOLVE TO A BUNDLED BUILD? An approved version
 * can never be un-approved, so old versions stay installable for as long as any
 * owner has not upgraded. If `buildForVersion` throws here, this SDK cannot create
 * or upgrade a passport on that registry at all.
 *
 * DOES THE REGISTRY EXERCISE THE TIER SPLIT? The two cohorts may receive
 * different programs. A registry that serves the same bytes to both still
 * behaves correctly — but it is not testing that the tiers get different bytes,
 * so this is reported as coverage rather than scored as a failure.
 *
 * DO BOTH BETA PATHS AGREE? An address reaches the beta tier two ways: a `w`
 * allowlist box, or being the manager, which `_entitled` short-circuits before it
 * ever looks for a box. They must resolve identically. The address is discovered
 * rather than configured, so nothing here goes stale when a registry changes.
 *
 * With `--passport <id>`, also rehearses that passport's upgrade (see
 * `rehearseUpgrade` in lib/checks.mjs). For your own passport and swap routes,
 * `npm run check` runs from the same config.
 */
import algosdk from 'algosdk';
import { DEFAULT_ALGOD, flag, loadConfig } from './lib/config.mjs';
import {
  PRODUCTION_REGISTRY,
  checkRegistry,
  finish,
  printCoverage,
  rehearseUpgrade,
  reporter,
} from './lib/checks.mjs';

const argv = process.argv.slice(2);
const { config } = loadConfig(argv);

const OPTS = new Set(['--config', '--url', '--passport']);
const positional = argv.filter((a, i) => !OPTS.has(a) && !OPTS.has(argv[i - 1]));
const targets = positional.length
  ? positional.map((a) => {
      const [id, expect] = a.split(':');
      return { id, ...(expect ? { expect } : {}) };
    })
  : (config.maintainer?.registries ?? []).length
    ? config.maintainer.registries.map((t) => ({ ...t, id: String(t.id) }))
    : [PRODUCTION_REGISTRY];

const url = flag(argv, '--url') ?? config.algodUrl ?? DEFAULT_ALGOD;
const passport = flag(argv, '--passport');
const algod = new algosdk.Algodv2('', url, '');
const r = reporter();

console.log(`algod: ${url}`);
const coverage = [];
for (const t of targets) coverage.push(await checkRegistry(algod, r, t));
if (passport) {
  try {
    await rehearseUpgrade(algod, r, passport);
  } catch (err) {
    r.fail(`rehearsal threw: ${err.message}`);
  }
}
printCoverage(coverage);
finish(r);
