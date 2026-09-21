/**
 * Fetching a router session for `npm run check`, so a route can be checked
 * without saving a quote by hand.
 *
 * DELIBERATELY NOT IN THE SDK. The published SDK builds groups offline and
 * depends on no HTTP API; a router's API is someone else's service, with its own
 * versions and hostnames. This lives beside the check script, where a broken
 * endpoint costs a test run rather than a release.
 *
 * QUOTE PARAMETERS PASS THROUGH VERBATIM. Routers differ — one takes `max_legs`,
 * another `max_outer_txns` and `fee_ppm` — and the SDK has no business modelling
 * either. Whatever the config puts under a route's `quote`, this sends, adding
 * only `sender`.
 *
 * SENDER IS THE PASSPORT'S APPLICATION ADDRESS, not the owner's wallet: the
 * session is built FROM the passport, and the passport's own holdings are what
 * a router's fee discount is assessed against. The owner signs the outer call
 * and never appears in the quote.
 *
 * A quote is short-lived (about 30 seconds), so /quote and /execute go back to
 * back. Nothing here signs or submits: the group comes back unsigned and is
 * simulated.
 *
 * ONE REQUEST AT A TIME, ON PURPOSE. A router's edge may allow a generous rate
 * while its origin allows only a few SIMULTANEOUS route computations per IP and
 * refuses the rest outright rather than queueing — measured on one production
 * router at four in flight, where seven requests a second passed the edge and
 * were then refused by the origin. Everything here runs sequentially: each rung
 * of the ladder awaits the last, and the check script walks routes in order. If
 * you ever add fan-out, bound it at `MAX_IN_FLIGHT` and no higher.
 *
 * Naming a sender also skips a router's anonymous quote cache — every passport
 * quote is a full route plan — so batching costs real work at the other end.
 */

/** Simultaneous quote or execute requests a router origin will tolerate. */
export const MAX_IN_FLIGHT = 4;

const RETRY_STATUS = new Set([429, 502, 503]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body, attempt = 0) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return res.json();

  const text = (await res.text()).slice(0, 300);
  // 502/503 is usually the router failing to read chain state and clears at
  // once; 429 asks for a pause. One retry each, then report it as what it is.
  if (RETRY_STATUS.has(res.status) && attempt === 0) {
    const after = Number(res.headers.get('retry-after'));
    await sleep(res.status === 429 ? Math.min((after || 2) * 1000, 5000) : 500);
    return post(url, body, attempt + 1);
  }
  if (res.status === 404 && /at least/i.test(text)) {
    throw new Error(`the router refused this amount as too small: ${text}`);
  }
  throw new Error(`${url} -> HTTP ${res.status}: ${text}`);
}

/** Decode an /execute group and drop its group ids: swapGroup regroups its own. */
function decodeGroup(algosdk, unsigned) {
  return unsigned.map((u) => {
    const txn = algosdk.decodeUnsignedTransaction(Buffer.from(u.txn_b64 ?? u, 'base64'));
    txn.group = undefined;
    return txn;
  });
}

/**
 * One quote, executed into an unsigned session.
 *
 * Returns the session, the quote itself, and `minOut` — the router's
 * `min_out_at_slippage`, used AS GIVEN. The router checks it against its own
 * expected output, so scaling or clamping it here turns a live route into a
 * rejected one.
 */
export async function fetchSession(algosdk, { url, params, sender }) {
  const quote = await post(`${url.replace(/\/$/, '')}/quote`, { ...params, sender });
  const exec = await post(`${url.replace(/\/$/, '')}/execute`, {
    quote_id: quote.quote_id,
    user_address: sender,
  });
  return {
    quote,
    session: decodeGroup(algosdk, exec.unsigned_group ?? []),
    minOut: BigInt(quote.min_out_at_slippage ?? 1),
    routerAppId: exec.router_app_id,
  };
}

/**
 * A session the passport can actually replay, re-quoting when the route is too
 * long.
 *
 * A passport replays at most `maxSession` transactions. A router that takes a
 * cap on route size (V3's `max_outer_txns`) returns something that fits and this
 * loop never runs. One that does not (V2) can return a 12-leg route for a large
 * amount, and the way through is to ask for less: fewer hops, then fewer legs,
 * taking the first that fits — which is also the best, since each rung is a
 * weaker route than the one before.
 *
 * Each rung costs a quote and an execute. Set `ladder: false` in the config to
 * refuse instead, when the caller would rather see the route it asked for.
 */
export async function fetchFittingSession(algosdk, opts, maxSession, log = () => {}) {
  const rungs = [
    {},
    { max_hops: 1 },
    { max_legs: 3 },
    { max_legs: 2 },
    { max_legs: 1 },
  ];
  const tried = [];
  for (const [i, rung] of rungs.entries()) {
    // Never widen what the config asked for: a rung that relaxes a cap the
    // caller set is not the route they wanted.
    if (i > 0 && opts.ladder === false) break;
    if (Object.entries(rung).some(([k, v]) => opts.params[k] !== undefined && Number(opts.params[k]) <= v)) continue;
    const got = await fetchSession(algosdk, { ...opts, params: { ...opts.params, ...rung } });
    tried.push(`${i === 0 ? 'as asked' : JSON.stringify(rung)}: ${got.session.length} txns`);
    if (got.session.length <= maxSession) {
      if (i > 0) log(`re-quoted ${JSON.stringify(rung)} to fit ${maxSession} session transactions`);
      return got;
    }
  }
  throw new Error(
    `no route fits ${maxSession} session transactions (${tried.join('; ')}) — ` +
      'ask the router for a smaller route, or swap less at once',
  );
}
