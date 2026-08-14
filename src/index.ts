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
 *   read.entitled           which version an address may install, if any
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
export * as directory from './directory.js';
export * from './create.js';
export * as strategy from './strategy.js';
export * as manage from './manage.js';
export * as teardown from './teardown.js';
export * as programs from './programs.js';
export * as simulate from './simulate.js';
export * as version from './version.js';
// A deposit is a bare transfer with no application call, so nothing on chain says
// it was a deposit unless you attach a note. `deposit` and `note` ship together for
// that reason: use them as a pair if you want your own history to be readable.
export * as deposit from './deposit.js';
export * as lp from './lp.js';
export * as note from './note.js';
// The contract's `log(...)` lines, decoded. Fill history has to come from
// logs — nothing on chain stores it — and the four strategy fills do NOT
// share a layout, so a generic reader misreads three of them.
export * as events from './events.js';
export * as template from './template.js';

export { RuleType } from './constants.js';
