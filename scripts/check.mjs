/**
 * Check the SDK against YOUR passport and routes — simulate only, never signs.
 *
 *   npm run check                         # reads ./sdk-test.config.json
 *   npm run check -- --config <file>      # another config
 *   npm run check -- --save [<dir>]       # also write each swap as a capture (default captures/)
 *
 * Copy sdk-test.config.example.json to sdk-test.config.json and fill in what you
 * want checked; every section is optional and runs only when its fields are set.
 * Both that file and captures/ are git-ignored — they name your passport.
 *
 *   registry            the registry's live state (as `npm run live-check` does)
 *   registry + owner    what that owner is entitled to, and whether this SDK has the bytes
 *   passport            its state, and a simulated upgrade to its entitlement
 *   passport + swaps    each route built by swapGroup from a saved session and
 *                       strict-simulated: every resource named where it is needed
 *
 * A swap route comes from one of two places: a `session` file you saved from a
 * router quote (see loadSession in lib/checks.mjs for the formats), or a live
 * quote, by setting `quote.url` and giving the route a `quote` object of that
 * router's own parameters, which are sent verbatim. A saved quote expires;
 * simulate does not care, but a stale price can stop the swap at "below min_out"
 * — reported, not failed, since it says nothing about the group this SDK built.
 *
 * Nothing here signs or submits, and a config holding anything that looks like a
 * key is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import algosdk from 'algosdk';
import { DEFAULT_ALGOD, flag, loadConfig } from './lib/config.mjs';
import {
  checkEntitlement,
  checkRegistry,
  checkSwap,
  finish,
  header,
  printCoverage,
  rehearseUpgrade,
  reporter,
} from './lib/checks.mjs';
import { read, version as version_ } from '../dist/index.js';

const argv = process.argv.slice(2);
const { config, file, dir } = loadConfig(argv);
if (!file) {
  console.error(
    'No config found. Copy sdk-test.config.example.json to sdk-test.config.json and\n' +
      'fill in the sections you want checked, or pass --config <file>.',
  );
  process.exit(2);
}

const saveAt = argv.indexOf('--save');
const saveDir =
  saveAt < 0 ? null : argv[saveAt + 1] && !argv[saveAt + 1].startsWith('--') ? argv[saveAt + 1] : 'captures';
const sdkVersion = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const url = flag(argv, '--url') ?? config.algodUrl ?? DEFAULT_ALGOD;
const algod = new algosdk.Algodv2('', url, '');
const r = reporter();
console.log(`SDK ${sdkVersion}  algod ${url}  config ${path.basename(file)}`);

const set = (v) => v !== undefined && v !== null && v !== '' && v !== 0 && v !== '0';

async function step(what, fn) {
  try {
    await fn();
  } catch (err) {
    r.fail(`${what} threw: ${err.message}`);
  }
}

if (set(config.registry)) {
  const coverage = [];
  await step('registry check', async () => {
    coverage.push(await checkRegistry(algod, r, { id: String(config.registry), label: 'YOUR REGISTRY' }));
  });
  if (coverage.length) printCoverage(coverage);
  if (set(config.owner)) {
    await step('entitlement', () => checkEntitlement(algod, r, { registry: config.registry, owner: config.owner }));
  }
}

if (set(config.passport)) {
  await step('passport', async () => {
    header(`PASSPORT ${config.passport}`);
    const st = await read.passportState(algod, BigInt(config.passport));
    console.log(`  runs ${version_.format(st.version)}  owner ${st.owner.slice(0, 8)}…  registry ${st.registry}  router ${st.routerAppId}`);
  });
  await step('upgrade rehearsal', () => rehearseUpgrade(algod, r, config.passport));

  for (const route of config.swaps ?? []) {
    const quoteUrl = config.quote?.url;
    if (!set(route.session) && !(route.quote && set(quoteUrl))) {
      r.note(`swap ${route.name ?? ''}: needs a saved session, or quote.url plus quote parameters — skipped`);
      continue;
    }
    await step(`swap ${route.name ?? ''}`, () =>
      checkSwap(algod, r, { passport: config.passport, route, dir, saveDir, sdkVersion, quoteUrl }),
    );
  }
} else if ((config.swaps ?? []).length) {
  r.note('swaps are configured but no passport is: a swap is checked from a passport');
}

finish(r);
