#!/usr/bin/env node
/**
 * Turn a swap CAPTURE into an anonymized route FIXTURE for the offline tests.
 *
 *   node scripts/route-fixture.mjs <capture.json | capture-dir> [--out <dir>]
 *
 * A capture is what `npm run check -- --save` writes (or the same shape from a
 * front end): the raw router session, the group as built, and a strict and an
 * unnamed-resources simulate. A fixture keeps only what the reference layout
 * depends on — each leg's references and quoted fee, the swap's assets, and what
 * the node reported unavailable — and drops everything that identifies the
 * passport it came from: passport id, owner, quote id, senders, app arguments,
 * amounts sent by the passport.
 *
 * It REFUSES to write a fixture that still contains the passport's address, the
 * owner, the passport id or a quote id, so a capture that grows a new field
 * cannot leak it through here. Fixtures land in test/fixtures/routes/ by default,
 * where the route tests pick up every file automatically.
 *
 * Paths come from the command line only. Keep captures OUT of the repo — the
 * default `captures/` folder is git-ignored for that reason.
 */
import fs from 'node:fs';
import path from 'node:path';
import algosdk from 'algosdk';

function parse(argv) {
  let out = path.join('test', 'fixtures', 'routes');
  const inputs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else inputs.push(argv[i]);
  }
  if (!inputs.length) {
    console.error('usage: node scripts/route-fixture.mjs <capture.json | capture-dir> [--out <dir>]');
    process.exit(2);
  }
  return { out, inputs };
}

const b64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'));
const u64 = (b) => Buffer.from(b).readBigUInt64BE(0);

/** Every capture file named by the arguments, directories expanded one level. */
function captureFiles(inputs) {
  return inputs.flatMap((p) =>
    fs.statSync(p).isDirectory()
      ? fs.readdirSync(p).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(p, f))
      : [p],
  );
}

function leg(t) {
  const fee = Number(t.fee);
  if (t.payment) {
    return { type: 'pay', fee, receiver: t.payment.receiver.toString() };
  }
  if (t.assetTransfer) {
    return {
      type: 'axfer', fee,
      receiver: t.assetTransfer.receiver.toString(),
      asset: String(t.assetTransfer.assetIndex),
    };
  }
  const c = t.applicationCall;
  if (!c) throw new Error(`unsupported session transaction type: ${t.type}`);
  return {
    type: 'appl', fee,
    app: String(c.appIndex),
    accounts: c.accounts.map(String),
    apps: c.foreignApps.map(String),
    assets: c.foreignAssets.map(String),
    boxes: c.boxes.map((b) => ({ app: String(b.appIndex), name: Buffer.from(b.name).toString('base64') })),
  };
}

function fixtureOf(capture, name) {
  const head = algosdk.decodeUnsignedTransaction(b64(capture.group_as_built[0].msgpack_b64));
  const args = head.applicationCall.appArgs;
  const missing = capture.simulate_unnamed_allowed?.merged ?? {};
  return {
    name,
    routerApp: String(capture.routerAppId),
    assetIn: String(u64(args[1])),
    assetOut: String(u64(args[3])),
    asBuilt: {
      sdk: String(capture.sdk ?? 'unknown'),
      strict: capture.simulate_strict?.failure ? 'fail' : 'clean',
      missing: {
        holdings: (missing.assetHoldings ?? []).map((h) => ({ account: h.account, asset: String(h.asset) })),
        locals: (missing.appLocals ?? []).map((l) => ({ account: l.account, app: String(l.app) })),
      },
    },
    session: capture.session.map((s) => leg(algosdk.decodeUnsignedTransaction(b64(s.msgpack_b64)))),
  };
}

/** Anything that would identify the passport a capture came from. */
function identifying(capture) {
  const out = [];
  if (capture.passport) {
    out.push(['passport id', String(capture.passport)]);
    out.push(['passport address', algosdk.getApplicationAddress(BigInt(capture.passport)).toString()]);
  }
  if (capture.owner) out.push(['owner', String(capture.owner)]);
  if (capture.quote?.quote_id) out.push(['quote id', String(capture.quote.quote_id)]);
  return out;
}

const { out, inputs } = parse(process.argv.slice(2));
fs.mkdirSync(out, { recursive: true });
let refused = 0;
for (const file of captureFiles(inputs)) {
  const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
  const name = path.basename(file, '.json');
  const fixture = fixtureOf(capture, name);
  const text = JSON.stringify(fixture, null, 2) + '\n';
  const leaks = identifying(capture).filter(([, v]) => v && text.includes(v)).map(([k]) => k);
  if (leaks.length) {
    console.error(`REFUSED ${name}: the fixture would still contain the ${leaks.join(', ')}`);
    refused++;
    continue;
  }
  const dest = path.join(out, `${name}.json`);
  fs.writeFileSync(dest, text);
  console.log(`wrote ${dest}  (${fixture.session.length} session txns, as built by ${fixture.asBuilt.sdk}: ${fixture.asBuilt.strict})`);
}
process.exit(refused ? 1 : 0);
