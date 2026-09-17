# @liquihog/defi-passport-sdk

TypeScript SDK for **LiquiHog DeFi Passport** on Algorand — create a passport,
fund it, run automated strategies against it, and read its state.

Browser-safe and Node-safe with no shims: no `node:crypto`, no `Buffer`, no
polyfills. Everything it reaches for — `crypto.subtle`, `atob`, `TextEncoder` —
is standard in browsers and in Node 18+, so `index`, `read` and `programs`
bundle with zero externals.

```bash
npm install && npm run build
npm test          # the entitlement and gas-cap rules — no chain, no accounts
```

## Pure builders

**Nothing here signs or submits.** Every function returns an unsigned transaction
or reads chain state. A wallet or your backend owns signing; this owns knowing
which box references, foreign apps and group orderings each call needs — which is
the part that is invisible at the call site and expensive to get wrong.

```ts
import { read, strategy, deposit } from '@liquihog/defi-passport-sdk';

const state = await read.passportState(algod, passportId);
const { strategies, rules, positions, committed } = await read.snapshot(algod, passportId);
```

## Creating a passport

The version an address may install is decided by the registry, so ask it rather
than hardcoding one. Entitlement is by **line**, not by version number:

```ts
import { read, programs, createGroup } from '@liquihog/defi-passport-sdk';

const { line, version, beta } = await read.entitled(algod, registryId, address);
if (version === 0n) throw new Error('no line is open to this address yet');

const build = await programs.buildForVersion(algod, registryId, version);
const group = createGroup({
  owner: address,
  registry: registryId,
  params,
  approvalProgram: build.approval,
  clearProgram: build.clear,
  entitledLine: line,        // the HEAD-BOX KEY, never recomputed from a version
  entitledVersion: version,
});
```

`line` is a box key, not a major, and it is the one field you must not derive
yourself. A registry keys its head boxes by major before the version-line split
and by `major * 1000 + minor` after it, and a version number cannot tell you
which — so pass through whatever `entitled` resolved. `linkGroup` and
`upgradeGroup` take the same `line` for the same reason: both re-run the tier
gate, so both have to name the box the registry is actually reading. Get it
wrong and the group fails on an **invalid Box reference**, which reads like a
permissions bug and is not one.

`buildForVersion` reads the version's stored hash off the registry and returns
whichever bundled program matches, so the SDK never guesses which build a tier
gets. If nothing matches it throws with every hash named — that means this SDK is
older than the version, not that the caller did something wrong.

## Swapping from inside the passport

`swap` is the owner's own trade — no keeper, and therefore no keeper fee. It is
owner-gated like everything else, spends FREE balance only, and is bounded by a
`minOut` the contract checks against measured balances. Being the owner does not
exempt you from that floor, which is the point.

```ts
import { swap } from '@liquihog/defi-passport-sdk';

const group = swap.swapGroup(ctx, {
  assetIn: 0, spend: 1_000_000n, assetOut: USDC, minOut: floor,
  session,                       // the router's unsigned legs, as quoted
  routerApp: state.routerAppId,  // the PASSPORT's cached id, not the directory's
});
```

The session is re-encoded into a blob the passport replays as inner
transactions, and the references those legs need are lifted back out onto the
outer group — including the two that read as contract faults and are not: asset
0, which is illegal on an inner transaction but must be named at top level, and
box references, which are dropped on replay. Overflow rides on `ping`, and the
fee is pooled for the whole call tree.

Take `routerApp` from `read.passportState`. The passport allowlists a session's
apps against its OWN cached ids, so a blob built for a router it has not adopted
fails with `app not allowlisted`.

## Capping what automation may spend

Each passport carries its own per-crank refund ceiling, counted in transactions.
It is owner-set and defaults to **272** — the protocol group maximum, 256 inner
plus 16 at the top level. The default and the maximum are the same number, so an
unset cap already sits at the ceiling and `setGasCap` can only ever tighten it.

```ts
import { read, manage } from '@liquihog/defi-passport-sdk';

const gas = await read.gasCap(algod, passportId);
if (gas.supported) {
  const txn = manage.setGasCap(ctx, 64); // refund no tree larger than this
}
```

**Read `gasCap`, never the raw global.** Two numbers decide the answer and each
has a zero that means the opposite of how it reads: a stored `gas_cap` of `0`
means UNSET and resolves to 272, and the registry brake `crank_txn_budget` of `0`
means it is NOT braking. Surface either literally and you tell an owner their
automation is clamped shut when it is running wide open.

`effective` is what a crank is actually held to: the owner's cap, lowered by the
registry brake if there is one. The brake may only lower it, so nothing outside
the passport can widen the exposure an owner chose.

A brake sitting below the default is the ordinary state during a rollout, not an
exception. While one is set, every passport on the registry is held to it no
matter what its owner chose — so a UI showing `cap` overstates every ceiling on
the platform at once. Show `effective`.

`supported` is false on a passport whose version predates the method, where the
call would be rejected as an unknown method — check it before putting the control
in front of anyone. It is deliberately not a version comparison: v1.1.0 is
`1_001_000`, numerically larger than v1.0.1's `1_000_001`, and does not have the
method.

The cap bounds a RATE, not a total. Lifetime exposure is still the per-strategy
`refundBudget` and the passport's gas reserve, both owner-set and separate.

## Gas in another asset, and routing profit

Both are v1.1.2, so check `read.passportState(...).version` before offering
either — on an older passport the method does not exist.

```ts
import { manage, strategy, read } from '@liquihog/defi-passport-sdk';

// "I will pay gas refunds in HOG, at no more than 3/2 HOG per uALGO, until then."
manage.setGasAsset(ctx, { asset: HOG, maxNum: 3, maxDen: 2, expires });

// Send 2.5% of every fill's proceeds to the owner's wallet.
strategy.setProfit(ctx, { sid, kind: 'owner', mode: 'rate', value: 250 });

// Or into another strategy's quote pool — profits repay the loan.
const target = await read.strategy(algod, passportId, loanSid);
strategy.setProfit(ctx, {
  sid, kind: 'reserve', mode: 'rate', value: 1_000,
  destSid: loanSid, destQuoteAsset: target.quoteAsset,
});
```

The gas election is half of a bargain: the keeper states per crank which asset it
accepts and at what discount, a refund is paid in the asset only where the two
agree, and everywhere else it is ALGO. No owner can force an asset on a keeper
and no keeper can pay in one the owner did not elect. `asset: 0` clears it.

`setProfit` exists for its box references. A RESERVE routing makes the contract
pre-create the receiving strategy's quote-asset ledger box on the owner's
signature, so that a crank is never what raises minimum balance — and that asset
cannot be derived here, which is why you pass it. `{ kind: 'none' }` deletes the
routing; `read.profit` reads it back, and absent means none.

## Upgrading to a larger build

v1.1.2 is 10,588 bytes, over the 8,192-byte cap that used to bound a program.
Three things follow, and the SDK handles each — but the first is yours to check
before an owner signs:

```ts
const cost = await read.upgradeCost(algod, passportId, build);
// { currentExtraPages: 3, extraPages: 5, schema: {...}, mbrIncrease: 200_000, fee: 3000, spendable: 203_000 }

const group = upgradeGroup({
  owner, registry, passport: passportId, version, line,
  approvalProgram: build.approval, clearProgram: build.clear, params,
  currentExtraPages: cost.currentExtraPages,
  schema: cost.schema,
});
```

Growing pages raises minimum balance by 100,000 uALGO each, charged to the
OWNER'S WALLET in the update transaction itself — never to the passport — and the
wallet pays the fees of the whole group, the update and the `verify_update`
behind it. So it needs `spendable` available at the moment of signing or the
update fails with a balance error that reads like nothing to do with pages.

Pass `currentExtraPages` and `schema` straight through. The first because an
update declaring fewer pages than the passport has is accepted and shrinks it.
The second because an update that carries a page count takes the ledger's
size-change path, where the schema is not "keep what you have" but whatever the
transaction states — and stating nothing asks for 0/0, refused as "store integer
count 8 exceeds schema integer count 0". Both default to what every passport was
created with, so a passport that has never been grown is safe without them.

The other two are automatic. The one transaction carrying an oversized program
pays a surcharge, and — the part that is not intuitive — **every later call to
the app needs box references, box or no box**. The AVM charges a read budget
against the old cap for every app whatever its page count, and only box
references buy it back. Every builder here pads with empty references sized from
the largest bundled build; if you assemble raw transactions yourself, see
`pages.boxRefsNeeded`.

## Folks lending

A loan is a strategy of type `Folks`, and its rules are the operations — a
deposit, a withdrawal, a borrow, a repayment — each cranked by the keeper, which
does every Folks transaction itself. The SDK builds only what the owner signs.

```ts
import { folks, strategy, read, FolksOp, RuleType } from '@liquihog/defi-passport-sdk';

// 1. A Folks strategy. Its quote asset is the borrow asset; that pool doubles
//    as the repay reserve, and profit routing can point at it.
strategy.openStrategy(ctx, { sid, type: RuleType.Folks, quoteAsset: USDC, quoteAmount: 0 });

// 2. An escrow: a fresh keypair the front end generates. It signs ONE
//    transaction, the rekey; after that the passport controls it.
folks.fundEscrow({ from: owner, escrow, params });           // the owner signs
folks.rekeyEscrow({ escrow, passport: passportId, params }); // the escrow key signs, once

// 3. Bind the loan. Fee 3,000; refuses any loan app the contract does not accept.
folks.openLoan(ctx, { sid, escrow, loanApp: 971388781 });

// 4. Rules. The prelude each op needs is encoded once, as proven on mainnet.
const exp = encode.boundsExpiry(Math.floor(Date.now() / 1000)); // seven days
folks.folksRule(ctx, { sid, ruleId, op: FolksOp.Deposit, pool: ALGO_POOL, batch: 500_000,
  underlying: 0, fAsset: FALGO, earmark: 500_000 });
folks.folksRule(ctx, { sid, ruleId, op: FolksOp.Borrow, pool: USDC_POOL, batch: 100_000,
  maxTotal: 300_000, boundsExpire: exp, underlying: USDC });

// 5. Close. Remove the rules first; works after close_strategy too, by design.
const bound = await read.loan(algod, passportId, sid);
folks.folksClose(ctx, { sid, ...bound });
```

What each op puts in `add_rule`, and what the contract refuses otherwise:

| op | assetA | committedA | assetB |
|---|---|---|---|
| deposit | the underlying (0 for ALGO) | the earmark | the fAsset |
| withdraw | the underlying | 0 — proceeds arrive free | the fAsset |
| borrow | the borrow asset | 0 — proceeds arrive free | 0 |
| repay | the borrow asset | the earmark | 0 |

Borrow and withdraw rules must carry a future `boundsExpire`: the health envelope
(`maxTotal`, `minCb`) is the owner's own price assumption and has to lapse.
Re-pricing is an ordinary `updateRule`. `read.loan` reads the binding back;
absent means no loan is open.

## Recurring payments

A `Pay` strategy sends a fixed amount to one recipient on an interval until its
budget is spent or `maxPayments` is reached. One asset, named in both prelude
slots — the contract insists — and opened with quote asset 0.

```ts
strategy.openStrategy(ctx, { sid, type: RuleType.Pay, quoteAsset: 0, quoteAmount: 0 });
strategy.payRule(ctx, { sid, ruleId, asset: 0, budget: 250_000, batch: 100_000, recipient });
```

An ASA payment to a recipient who has not opted in fails LOUDLY at crank time
rather than being skipped. Pay has no template layout, on purpose: a payment
names a specific person, and there is nothing portable in it. Read one back with
`encode.decodePayTail`.
## Events

Fill history lives only in logs. `events.decodeEvent` turns one log line into
`{ tag, fields, addresses?, ruleType? }`, and `events.eventsIn(txn)` walks a
transaction's inner transactions and the registry's relay envelopes so a
fleet-wide read still knows whose fill it was.

All twenty-six tags through v1.1.2 are carried, with layouts read from the
contract's emit sites rather than from descriptions of them — two of the nine
v1.1.2 tags differ from how they were described (`skim` has six fields, and
`lopen`'s escrow address sits between its two integers). `pfill` and `lfill`
are crank fills of the Pay and Folks rule types; `ovfy` is relayed like one but
is `verify_fill` settling a fill, and `isCrankFill` says no to it.

## Reading state, cheaply

`read.boxValue` fetches ONE box by name. Reach for `read.boxes` only when the
answer genuinely is "all of them": it lists every box and then fetches each
individually, and a registry's box count grows with every passport ever created.

## Failures that explain themselves

The AVM's `assert` carries no message, so a node reports only `assert failed
pc=N`. `simulate.explain` resolves that pc back to the source assertion, using the
map for the build you actually submitted:

```ts
import { simulate } from '@liquihog/defi-passport-sdk';
const why = simulate.explain(failure, { build });
```

## One id, and it comes from your config

The **directory** is the only app id you need to hold. Everything else — router,
budget, registry, keeper — resolves from it at runtime, so those can move without
you shipping a new build.

This SDK does not bake that id in. An id compiled into a release is a promise that
it will never change. Keep it in your own configuration, and verify the app's
creator address before trusting what it publishes.

```ts
import { directory } from '@liquihog/defi-passport-sdk';
const live = await directory.resolve(algod, DIRECTORY_APP_ID);
```

Entries that are not published yet come back as `0` — or the zero address — rather
than throwing, so check the one you need before relying on it.

## What the tests cover

The entitlement rule, the gas-cap resolution and the bundled program builds are
unit-tested against synthetic registry and passport state — both sides of the
version-line split, no chain and no funded account.

That split matters because the failure these guard against is invisible on a
healthy registry. The obvious live check — resolve one address per tier and
confirm it names the version that passport is already running — cannot tell
`line // 1000 >= min_major` from `line >= min_major`, because both answer
identically for every line a working registry actually has. The rule only shows
its granularity against a RETIRED line, which a healthy registry has none of, so
the boundary is constructed in the suite instead.

The build suite guards a different silence. Four programs are bundled — two tiers
across two eras — because an approved version can never be un-approved, so v1.0.0
and v1.1.0 stay installable alongside v1.0.1 and v1.1.1. Twenty-three pcs agree
within each era and disagree across it, and `simulate.explain` answers only where
every map that has a pc agrees. Drop the older pair to save bundle size and those
pcs start answering confidently and wrongly for every passport that has not
upgraded yet — so a test asserts they stay ambiguous.

## Scope

This is the **user-facing** SDK: everything an owner does with their own passport.
Protocol administration — approving versions, moving the stable pointer, the beta
allowlist, keeper and fee configuration, directory publishing — is deliberately not
here, and those methods are not merely undocumented but absent from the build.

## Versioning

The bundled program bytes must match what the registry has approved, so a release
of this SDK is tied to a set of approved contract versions. `buildForVersion`
throws with every hash named if it is asked for a version newer than the builds it
carries — that means upgrade the SDK, not that the call was wrong.
