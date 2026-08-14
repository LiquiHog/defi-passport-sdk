/**
 * Protocol constants.
 *
 * The only app id you should hardcode is the directory. Everything else — router,
 * budget, registry, keeper — is resolved through it at runtime, so those can move
 * without you shipping a new build. See `directory.ts`.
 */

/**
 * THE DIRECTORY APP ID IS NOT SHIPPED, and is a required argument everywhere it
 * is needed.
 *
 * It is deliberately not a constant here. An id compiled into a release is a
 * promise that it will not change, and pinning one before it is settled is how a
 * published SDK ends up pointing at the wrong app with no way to correct it except
 * a new release every consumer has to install.
 *
 * Take it from your own configuration and pass it in. Verify the app's creator
 * address before trusting anything it publishes — that check is what makes a
 * directory id safe to accept from config in the first place.
 */

/**
 * Passport creation parameters.
 *
 * These are FROZEN at creation — no upgrade can change an app's schema or page
 * count. They are set larger than the current contract needs so a passport has
 * room to grow, which is what lets a later version install in place instead of
 * forcing you to create a new passport and migrate funds into it.
 */
export const GLOBAL_UINTS = 12;
export const GLOBAL_BYTES = 2;
export const EXTRA_PAGES = 3; // 4 pages total = 8192 B, the AVM maximum

/**
 * What registration costs, paid by whoever creates the passport.
 *
 * The registry writes two index boxes: `e`+owner (33 B name, 8 B value) and
 * `a`+app_id (9 B name, 32 B value). Fund this on top of the passport's own
 * minimum balance or creation fails partway through the group.
 */
export const INDEX_BOX_MBR = 18_900 * 2;

/**
 * Program pages for the registry's version hash are **4096 bytes**.
 *
 * This is NOT the 2048-byte unit that `extraPages` and minimum-balance use. Two
 * different quantities are both called a page, and hashing with the wrong one
 * produces a value the registry stores happily and nothing can ever satisfy.
 * Prefer `programs.buildForVersion`, which handles this for you.
 */
export const HASH_PAGE_BYTES = 4096;

/** Passport box prefixes. Kept short: a box costs 400 uALGO per byte of name. */
export const BOX = {
  strategy: 's', //  s  + sid            strategy header (64 B)
  rule: 'sr', //     sr + sid + rule_id  one rule
  committed: 'cm', //cm + asset          the committed ledger
  position: 'p', //  p  + asset          locked funds + valuation legs
} as const;

/** Registry box prefixes. */
export const REG_BOX = {
  owner: 'e', //   e + owner   forward index, re-pointed on every create
  passport: 'a', //a + app_id  reverse index; the keeper discovers work from it
  version: 'v', // v + version approved page hashes + timelock
  beta: 'w', //    w + address present = beta tier
  head: 'h', //    h + major   the newest version approved in that LINE
} as const;

/**
 * Version access is by LINE, and the two tiers resolve differently:
 *
 *   beta (`w`+address) -> `h`+major, the newest patch in the line it asks for
 *   everyone else      -> `stable_version`, one pinned version that MAY LAG
 *
 * That lag is the feature. It lets one version be the public release while a newer
 * one is beta-tested in the same line, and because the major does not change,
 * promoting it reaches existing owners as an in-place upgrade rather than a
 * migration. `min_major` retires a line outright.
 *
 * Each tier still resolves to exactly one version, so there is no range to choose
 * from and a superseded version stops being installable the moment stable moves.
 *
 * Use `read.entitled` rather than reading these yourself.
 */
export const LINE_GLOBALS = ['latest_major', 'stable_version', 'min_major'] as const;

export enum RuleType {
  Schedule = 1,
  Balancer = 2,
  Grid = 3,
  Limit = 4,
}

/** Anti-dust floor on a balancer crank: the move must be worth target/200. */
export const MIN_MOVE_DIV = 200;
export const MAX_ANCHORS = 4;

/**
 * The default `refundBudget`: effectively unlimited, and normally left alone.
 *
 * A strategy's refund budget is a per-strategy CEILING on gas spend, not a pot of
 * money — the ALGO itself comes from the passport's single gas reserve, which every
 * strategy shares. Because the ceilings are never reconciled against that reserve,
 * setting one does not protect a strategy from the others: if one drains the gas,
 * all of them stop regardless of their budgets.
 *
 * So the model to hold in your head is one number, not two: your passport has a gas
 * reserve, automation spends from it, top it up when it runs low.
 *
 * Set a real value only if you specifically want to cap ONE strategy's lifetime gas
 * spend. The contract does not validate this field, so it is entirely your choice.
 */
export const UNLIMITED_REFUND_BUDGET = 18446744073709551615n;

/** An app account cannot hold ALGO at all below this. */
export const APP_MIN_BALANCE = 100_000;

/**
 * `remove_entry` refunds the index-box minimum balance with an inner payment, so
 * it needs more than the base fee. At 1000 it fails with "group fee too small",
 * which does not read like a fee problem.
 */
export const REMOVE_ENTRY_FEE = 3000;

/** `optin` issues one inner asset transfer. */
export const OPTIN_FEE = 2000;

/** Group-wide reference budget. Boxes, assets, apps and accounts all share it. */
export const MAX_REFS_PER_TXN = 8;
