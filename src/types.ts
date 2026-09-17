import type { Algodv2, SuggestedParams, Transaction } from 'algosdk';
import type { FolksOp, RuleType } from './constants.js';

export type Num = number | bigint;

/** Everything a builder needs. `params` is fetched once and reused per group. */
export interface Ctx {
  algod: Algodv2;
  /** The registry this passport is bound to. IMMUTABLE once created. */
  registry: Num;
  params: SuggestedParams;
  /** Address that signs — always the passport owner for these builders. */
  owner: string;
}

export interface PassportCtx extends Ctx {
  passport: Num;
}

export type Group = Transaction[];

export interface AnchorSpec {
  /** 0 = direct pool, 1 = cross (two pools through a middle asset). */
  mode: 0 | 1;
  pool1: Num;
  pool2?: Num;
}

/** A passport's global state, decoded. */
export interface PassportState {
  owner: string;
  registry: bigint;
  testing: bigint;
  /** 0 means the version has not been attested yet — see `confirm_version`. */
  version: bigint;
  orderCount: bigint;
  oracleAppId: bigint;
  directory: bigint;
  routerAppId: bigint;
  budgetAppId: bigint;
  /**
   * The per-crank refund ceiling, RAW.
   *
   * 0 means UNSET, which resolves to `GAS_CAP_DEFAULT` — the opposite of "no gas
   * allowed". It also reads 0 on any passport too old to have the field at all.
   * Use `read.gasCap`, which tells those two apart and applies the registry's
   * brake, rather than surfacing this number directly.
   */
  gasCap: bigint;
  /**
   * The owner's election to have gas refunds charged in another asset, or null
   * when none is set. A refund is paid in the asset only where the keeper also
   * accepts it, at no worse than `maxNum / maxDen` units per uALGO, and only
   * until `expires`; everywhere else it is ALGO. See `manage.setGasAsset`.
   */
  gasAsset: GasAsset | null;
}

/** The `ga` global: four u64s. */
export interface GasAsset {
  asset: bigint;
  /** The most of `asset` the owner will pay per uALGO, as a fraction. */
  maxNum: bigint;
  maxDen: bigint;
  /** Unix seconds. The contract refuses an election that has already expired. */
  expires: bigint;
}

/** A strategy header (`s`+sid, 64 B). */
export interface Strategy {
  sid: bigint;
  type: RuleType;
  feeBps: bigint;
  refundBudget: bigint;
  createdTs: bigint;
  quoteAsset: bigint;
  quoteAmount: bigint;
  nRules: bigint;
  nextRuleId: bigint;
}

/** A rule (`sr`+sid+rule_id): a 32-byte committed prelude, then the tail. */
export interface Rule {
  sid: bigint;
  ruleId: bigint;
  assetA: bigint;
  committedA: bigint;
  assetB: bigint;
  committedB: bigint;
  tail: Uint8Array;
}

/** A typed position (`p`+asset, 104 B). */
export interface Position {
  asset: bigint;
  kind: bigint;
  subKind: bigint;
  flags: bigint;
  amount: bigint;
  oracleApp: bigint;
  refApp: bigint;
  refId: bigint;
  legs: Uint8Array; // 2 x [valAsset, rateNum, rateDen]
}

/**
 * A strategy's profit routing (`sp`+sid, 40 B). Absent means none: every fill's
 * proceeds stay in the strategy, which is what every passport did before v1.1.2.
 */
export interface ProfitRouting {
  /** `rate`: `value` is basis points of net proceeds. `fixed`: an amount, capped at the net. */
  mode: 'rate' | 'fixed';
  value: bigint;
  /** Where the skim goes: the owner, another strategy's quote reserve, or the ALGO gas lock. */
  kind: 'owner' | 'reserve' | 'gas';
  /** The receiving strategy. Meaningful only when `kind` is `reserve`. */
  destSid: bigint;
}

/**
 * What `manage.setProfit` writes. `none` deletes the routing; the other three
 * are the contract's destination kinds 1, 2 and 3.
 */
export type ProfitSpec =
  | { kind: 'none' }
  | { kind: 'owner' | 'gas'; mode: 'rate' | 'fixed'; value: Num }
  | {
      kind: 'reserve';
      mode: 'rate' | 'fixed';
      value: Num;
      /** The strategy whose quote pool receives the skim. Not `sid` itself. */
      destSid: Num;
      /**
       * The receiving strategy's quote asset, from `read.strategy`. The contract
       * pre-creates that asset's committed-ledger box on the owner's signature,
       * so the box has to be named here and the builder cannot derive it.
       */
      destQuoteAsset: Num;
    };

/** An app's state schema, as frozen at creation. */
export interface AppSchema {
  globalInts: number;
  globalBytes: number;
  localInts: number;
  localBytes: number;
}

/** What an app declares today: read before an update, and restated on it. */
export interface AppParams {
  extraPages: number;
  schema: AppSchema;
}

/** What an in-place upgrade will cost the OWNER'S WALLET, before they sign. */
export interface UpgradeCost {
  /** Extra pages the passport declares now. */
  currentExtraPages: number;
  /** Extra pages the update will declare — never below the current count. */
  extraPages: number;
  /**
   * The schema the passport declares now. Pass it to `upgradeGroup`: an update
   * that changes the app's size must restate the schema, and one that omits it
   * asks for 0/0.
   */
  schema: AppSchema;
  /** Minimum-balance increase, charged to the wallet in the update itself. */
  mbrIncrease: number;
  /**
   * The fee for the WHOLE group — the update plus `verify_update`. The wallet
   * pays both; counting only the update under-reports by `VERIFY_UPDATE_FEE`.
   */
  fee: number;
  /** `mbrIncrease + fee`: what must be SPENDABLE at the moment of signing. */
  spendable: number;
}

/** The `fl`+sid box: which escrow and loan app a `Folks` strategy is bound to. */
export interface LoanBinding {
  escrow: string;
  loanApp: bigint;
}

/** The config half of a `Folks` rule's 72-byte tail. Runtime fields are the contract's. */
export interface FolksTailSpec {
  op: FolksOp;
  /** The Folks pool app the op goes through. */
  pool: Num;
  /** The most one crank may move. */
  batch: Num;
  /** Seconds between cranks; the contract floors this at 60. */
  interval?: Num;
  /** Borrow only: a cumulative cap on what the rule may ever borrow. 0 means none. */
  maxTotal?: Num;
  /** Withdraw only: the fAsset the escrow must still hold afterwards. 0 means none. */
  minCb?: Num;
  /**
   * Borrow and withdraw refuse after this unix time — MANDATORY for those two,
   * because the health envelope (`maxTotal`, `minCb`) is the owner's own price
   * assumption and must carry an expiry. `encode.boundsExpiry` gives the
   * seven-day convention; re-pricing is an ordinary `updateRule`.
   */
  boundsExpire?: Num;
}

/** Everything `folks.folksRule` needs: the tail, plus the prelude the op takes. */
export interface FolksRuleSpec extends FolksTailSpec {
  sid: Num;
  ruleId: Num;
  /** 0 for ALGO on a deposit or withdrawal of an ALGO pool; the borrow asset on a borrow or repay. */
  underlying: Num;
  /** The pool's fAsset. Required for deposit and withdraw; must be absent otherwise. */
  fAsset?: Num;
  /** What the rule may draw. Required for deposit and repay; refused otherwise. */
  earmark?: Num;
}

/** A `Pay` rule: a fixed amount to one recipient on an interval, until the budget is spent. */
export interface PayRuleSpec {
  sid: Num;
  ruleId: Num;
  /** The asset paid. 0 for ALGO. A recipient not opted in to an ASA fails loudly at crank time. */
  asset: Num;
  /** The total the rule may pay out. The last payment is the remainder. */
  budget: Num;
  /** Per payment. */
  batch: Num;
  /** Seconds between payments; floored at 60 by the contract. */
  interval?: Num;
  recipient: string;
  /** Stop after this many payments. 0 means until the budget is spent. */
  maxPayments?: Num;
}

/** What the directory publishes. Only `router` and `budget` are contract-read. */
export interface DirectoryEntries {
  router: bigint;
  budget: bigint;
  registry: bigint;
  keeper: string;
  oracle: bigint;
  [k: string]: bigint | string | string[];
}
