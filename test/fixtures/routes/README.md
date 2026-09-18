# Route fixtures

Each file here is one real router route, made anonymous. `test/swap-routes.test.ts`
replays every file through `swapGroup` offline and checks that no pairing a leg of
the quote had — an account beside an asset, an account beside an app — is split
across outer transactions, and that the fee covers every leg.

## Adding a route

1. Capture it with the live check, which only simulates and never signs:
   `npm run check -- --save` writes into `captures/` (git-ignored).
2. Convert it: `node scripts/route-fixture.mjs captures/<file>.json`.
3. Run `npm test`. The new route is picked up with no code change.

The converter refuses to write a fixture that still contains the passport's id or
address, its owner, or a quote id. Never add a capture itself to the repo.

## Schema

| field | meaning |
|---|---|
| `name` | the file name, used in test titles |
| `routerApp` | the router app the session calls |
| `assetIn`, `assetOut` | the swap's two assets (`0` is ALGO) |
| `asBuilt.sdk` | the SDK version that built the captured group |
| `asBuilt.strict` | `fail` or `clean` under a strict simulate (no unnamed resources) |
| `asBuilt.missing` | what the node reported unavailable: `holdings` (account + asset) and `locals` (account + app) |
| `session[]` | the legs in order: `type` (`pay`, `axfer`, `appl`), the quoted `fee`, and the leg's references (`receiver`, `asset`, or `app`, `accounts`, `apps`, `assets`, `boxes`) |

Everything kept is public on-chain infrastructure — routers, pools, pool accounts
and assets. Amounts, arguments and senders are dropped: the layout does not depend
on them.
