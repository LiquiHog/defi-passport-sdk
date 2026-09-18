/**
 * The live checks' configuration: `sdk-test.config.json`, git-ignored.
 *
 * Copy `sdk-test.config.example.json` to that name and fill in your own ids.
 * `--config <path>` reads another file instead. Relative paths inside it (a saved
 * session, say) resolve against the config file's own folder, so a config works
 * from wherever the command is run.
 *
 * A CONFIG NEVER HOLDS A KEY. Every live check simulates an unsigned group and
 * nothing here signs, so a field that looks like a secret is refused rather than
 * ignored: it means someone expected it to be used, and the right answer is to
 * take it out of the file.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = 'sdk-test.config.json';
export const DEFAULT_ALGOD = 'https://mainnet-api.algonode.cloud';

const SECRET = /mnemonic|secret|private|passphrase|seed|^sk$|signing.?key/i;

function secretKeys(v, at = '') {
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v).flatMap(([k, x]) => [
    ...(SECRET.test(k) ? [`${at}${k}`] : []),
    ...secretKeys(x, `${at}${k}.`),
  ]);
}

/**
 * The config named by `--config`, else ./sdk-test.config.json, else `{}`.
 * A missing DEFAULT file is not an error — it means "use the defaults". A missing
 * file you NAMED is, and so is a config holding a key: both end the run with the
 * reason, not a stack trace.
 */
export function loadConfig(argv) {
  try {
    return readConfig(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}

function readConfig(argv) {
  const i = argv.indexOf('--config');
  const named = i >= 0 ? argv[i + 1] : undefined;
  const file = path.resolve(named ?? DEFAULT_CONFIG);
  if (!fs.existsSync(file)) {
    if (named) throw new Error(`no config at ${file}`);
    return { config: {}, file: null, dir: process.cwd() };
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bad = secretKeys(config);
  if (bad.length) {
    throw new Error(
      `${path.basename(file)} has ${bad.join(', ')} — the checks only simulate and never sign, ` +
        'so a config must not hold a key. Remove it.',
    );
  }
  return { config, file, dir: path.dirname(file) };
}

/** `--flag value` from argv, or undefined. */
export const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
