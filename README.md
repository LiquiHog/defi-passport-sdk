# @liquihog/defi-passport-sdk

TypeScript SDK for **LiquiHog DeFi Passport** on Algorand — create a passport,
fund it, run automated strategies against it, and read its state.

Browser-safe and Node-safe with no shims: no `node:crypto`, no `Buffer`, no
polyfills. `index`, `read` and `programs` all bundle for the browser with zero
externals, which is checked on every build rather than assumed.

```bash
npm install && npm run build
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
import { read, programs, createPassport } from '@liquihog/defi-passport-sdk';

const { major, version, beta } = await read.entitled(algod, registryId, address);
if (version === 0n) throw new Error('no line is open to this address yet');

const build = await programs.buildForVersion(algod, registryId, version);
const txns = createPassport({ /* ... */ entitledMajor: major, entitledVersion: version }, build);
```

`buildForVersion` reads the version's stored hash off the registry and returns
whichever bundled program matches, so the SDK never guesses which build a tier
gets. If nothing matches it throws with every hash named — that means this SDK is
older than the version, not that the caller did something wrong.

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
