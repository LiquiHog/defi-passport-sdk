/**
 * TypeScript SDK for LiquiHog DeFi Passport on Algorand.
 *
 * PURE BUILDERS. Every function returns an unsigned transaction or reads chain
 * state. Nothing here signs, submits, or holds a key — your wallet or backend owns
 * signing, and this owns knowing how each call has to be assembled.
 *
 * That assembly is the reason to use a library rather than encoding calls yourself.
 * Algorand requires a transaction to name every box, asset, app and account it will
 * touch, at signing time. Get a reference wrong and the node reports "invalid Box
 * reference", which reads like a permissions error and is not one. The lists are
 * invisible at the call site and unforgiving:
 *
 *   - the committed-ledger box on anything that moves committed funds
 *   - `confirm_version` before `link_passport`, never after
 *   - three foreign apps on `sync_contracts`
 *   - `sid` and `ruleId` read from live state, never guessed
 *   - a raised fee on `remove_entry` and `optin`, which issue inner transactions
 *   - reference overflow spread across extra `ping` transactions
 *
 * Each of those is handled for you. Where a mistake is still possible, the function
 * that could make it says so in its own documentation.
 *
 * ## Where to start
 *
 *   read.entitled           which LINE and version an address may install, if any
 *   programs.buildForVersion   the program bytes that version expects
 *   createPassport          the creation group
 *   deposit / strategy      fund it, then give it something to do
 *   read.snapshot           everything a UI needs, in one pass
 *   simulate.explain        turn a failed simulation into a readable reason
 */
export * from './constants.js';
export * from './types.js';
export * as abi from './abi.js';
export * as encode from './encode.js';
export * as read from './read.js';
// The entitlement derivation, without the network. `read.entitled` is the
// wrapper you normally want; these are what you test against, and what a
// harness driving a half-migrated registry needs in order to force a shape.
export * as entitlement from './entitlement.js';
export * as directory from './directory.js';
export * from './create.js';
export * as strategy from './strategy.js';
export * as manage from './manage.js';
export * as teardown from './teardown.js';
export * as programs from './programs.js';
export * as simulate from './simulate.js';
export * as version from './version.js';
// Program size and what follows from it: pages, the oversized-program fee, and
// the read budget that makes every call name box references once a program is
// over the legacy cap. Builders apply it; this is here for callers sizing UIs.
export * as pages from './pages.js';
// A deposit is a bare transfer with no application call, so nothing on chain says
// it was a deposit unless you attach a note. `deposit` and `note` ship together for
// that reason: use them as a pair if you want your own history to be readable.
export * as deposit from './deposit.js';
export * as lp from './lp.js';
export * as note from './note.js';
// The contract's `log(...)` lines, decoded. Fill history has to come from
// logs — nothing on chain stores it — and the six strategy fills do NOT share
// a layout, so a generic reader misreads most of them. Two v1.1.2 events carry
// a 32-byte address and one has two lengths; the layouts here were read from
// the emit sites, and differ from the brief that described them in two places.
export * as events from './events.js';
export * as template from './template.js';
// Owner-driven swaps. Trading from inside the passport with no keeper involved,
// so no keeper fee — and the session blob's reference arrays handled for you.
export * as swap from './swap.js';

export { RuleType } from './constants.js';
