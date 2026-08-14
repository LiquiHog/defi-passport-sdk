import type { Algodv2, SuggestedParams, Transaction } from 'algosdk';
import type { RuleType } from './constants.js';

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

/** What the directory publishes. Only `router` and `budget` are contract-read. */
export interface DirectoryEntries {
  router: bigint;
  budget: bigint;
  registry: bigint;
  keeper: string;
  oracle: bigint;
  [k: string]: bigint | string | string[];
}
