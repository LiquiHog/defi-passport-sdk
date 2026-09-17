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
/**
 * The FLOOR on extra pages, not the ceiling it used to be. Consensus v42 lifted
 * the 8,192-byte program cap, so a large build declares more — `pages.extraPagesFor`
 * derives it — but never fewer than every existing passport was created with.
 */
export const EXTRA_PAGES = 3;

/**
 * The 2,048-byte page `extraPages` and minimum-balance count in. NOT the
 * 4,096-byte page the registry hashes programs with (`HASH_PAGE_BYTES`).
 */
export const PROGRAM_PAGE_BYTES = 2048;

/**
 * The program cap before consensus v42. Lifted for storage, but the AVM still
 * charges its READ BUDGET against this number for every app — so a program over
 * it needs box references on every call, empty ones included. See `pages.ts`.
 */
export const LEGACY_PROGRAM_CAP = 8192;

/**
 * Fee for the one transaction that carries a program over `LEGACY_PROGRAM_CAP`.
 * A per-byte surcharge in consensus; measured minimum about 1,100 for a 9.3 KB
 * program, so this is a flat cover rather than a computed one.
 */
export const OVERSIZED_PROGRAM_FEE = 2000;

/**
 * Minimum balance each extra page costs, charged to the CREATOR — for a passport
 * that is the owner's wallet, never the passport's own account — and applied in
 * the create or update transaction itself. Growing 3 -> 5 costs the owner
 * 200,000 spendable at the moment they sign, or the update fails.
 */
export const MBR_PER_EXTRA_PAGE = 100_000;

/** Read budget one box reference buys. */
export const READ_BUDGET_PER_BOX_REF = 1024;

/**
 * The size every named box is counted at when sizing a group's read budget. A
 * bound: the largest passport box is a balancer rule at about 104 bytes.
 */
export const BOX_READ_BOUND = 128;

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
  profit: 'sp', //   sp + sid            profit routing (40 B); absent = none
  loan: 'fl', //     fl + sid            an open Folks loan; close refuses while present
} as const;

/** Registry box prefixes. */
export const REG_BOX = {
  owner: 'e', //   e + owner   forward index, re-pointed on every create
  passport: 'a', //a + app_id  reverse index; the keeper discovers work from it
  version: 'v', // v + version approved page hashes + timelock
  beta: 'w', //    w + address present = beta tier
  head: 'h', //    h + line    the newest version approved in that LINE
} as const;

/**
 * The globals that decide which version an address may install.
 *
 * Access is by LINE, and the two tiers do NOT resolve symmetrically:
 *
 *   beta (`w`+address, or the manager) -> `beta_line`, then `h`+that line
 *   everyone else                      -> `stable_version` EXACTLY, no head box
 *
 * Stable being PINNED rather than headed is the point, and it is the launch shape
 * rather than an edge case. It lets one version be the public release while a
 * newer one is beta-tested in the same major, and because the major does not
 * change, promoting it later reaches existing owners as an in-place upgrade
 * rather than a migration. Each tier still resolves to exactly one version, so
 * there is no range to choose from and a superseded version stops being
 * installable the moment stable moves.
 *
 * WHAT A LINE IS depends on whether the step-0 migration has run: a major before
 * it, `major * 1000 + minor` after, so v1.0.x and v1.1.x go from sharing one head
 * box to having their own. `beta_line` exists only on a migrated registry, which
 * is what makes its presence the shape signal; `latest_major` is live on BOTH and
 * signals nothing about which shape you are looking at.
 *
 * `min_major` spans both shapes unchanged and stays MAJOR-granular either way —
 * `line // 1000 >= min_major` once migrated — so retiring a major retires all of
 * its minor lines at once. Retirement deliberately did not become minor-granular.
 *
 * DO NOT read `stable_major`. An older build wrote it and a newer one stopped, so
 * it still answers on any registry that ever ran the old build, frozen at
 * whatever it last held and reading as perfectly live. Derive stable's line from
 * `stable_version` instead.
 *
 * Use `read.entitled` rather than reading any of these yourself.
 */
export const LINE_GLOBALS = [
  'latest_major',
  'beta_line',
  'stable_version',
  'min_major',
] as const;

export enum RuleType {
  Schedule = 1,
  Balancer = 2,
  Grid = 3,
  Limit = 4,
  /** A Folks Finance loan. Cranked from v1.1.2; no owner builder ships yet. */
  Folks = 5,
  /** Recurring payments to a recipient. Cranked from v1.1.2. */
  Pay = 6,
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

/**
 * The per-crank gas refund ceiling, counted in TRANSACTIONS.
 *
 * 272 is the protocol's group maximum — 256 inner transactions plus 16 at the
 * top level — so it is not a tunable somebody forgot to raise. There is no group
 * larger than this, which is why the contract refuses a higher cap with "beyond
 * protocol group maxima".
 *
 * THE DEFAULT AND THE MAXIMUM ARE THE SAME NUMBER, deliberately. An unset cap
 * already sits at the ceiling, so `set_gas_cap` can only ever TIGHTEN — neither
 * an owner nor the platform can raise exposure past one group's worth without
 * every owner signing a new version.
 *
 * This bounds a RATE, not a total: how big one crank's refunded call tree may
 * get. Lifetime exposure is still the per-strategy `refund_budget` and the
 * passport's gas reserve, both owner-set and untouched by this.
 *
 * A stored `0` MEANS UNSET and resolves to this default. It does not mean "no
 * gas allowed" — see `read.gasCap`, which resolves it for you.
 */
export const GAS_CAP_MAX = 272;
export const GAS_CAP_DEFAULT = 272;

/**
 * The first version ON EACH LINE that has `set_gas_cap`, keyed by line.
 *
 * A TABLE, reluctantly, and the only one in this SDK — because neither of the
 * alternatives works. It cannot be derived from the version number: step 1 ships
 * v1.0.1 and v1.1.1, so a plain `version >= 1_000_001` would claim v1.1.0
 * (1_001_000, numerically larger) has the method when it does not. And it cannot
 * be probed from state either, because `gas_cap` is absent both on a passport
 * too old to have the method and on a new one whose owner never set a cap.
 *
 * A line that is not listed reads as UNSUPPORTED rather than assumed. That is
 * the conservative direction: the cost of being wrong is a control hidden from
 * an owner who could have used it, against an "unknown method" rejection at
 * signing time. Add a line here when one ships with the method.
 */
export const GAS_CAP_SINCE: Readonly<Record<number, bigint>> = {
  1_000: 1_000_001n, // v1.0.1, the restricted line
  1_001: 1_001_001n, // v1.1.1, the full line
};

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

/**
 * `verify_update`'s fee. The owner's wallet pays for the WHOLE upgrade group —
 * this plus the update transaction's own — so anything pricing an upgrade must
 * count both. `read.upgradeCost` does; a caller adding the update fee alone
 * under-reports by exactly this.
 */
export const VERIFY_UPDATE_FEE = 1000;

/** Group-wide reference budget. Boxes, assets, apps and accounts all share it. */
export const MAX_REFS_PER_TXN = 8;
