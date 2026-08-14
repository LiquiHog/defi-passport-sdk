/**
 * Simulation, and turning a rejection into something a human can act on.
 *
 * ALWAYS SIMULATE BEFORE SUBMITTING. Every group this SDK builds carries box and
 * asset references that are correct by construction, but amounts are not — a
 * crank can move a rule's prelude between the moment you read it and the moment
 * your transaction lands, and a simulate catches that for free.
 */
import {
  encodeUnsignedSimulateTransaction,
  modelsv2,
  type Algodv2,
  type Transaction,
} from 'algosdk';
import { ALL_BUILDS, type Build } from './programs.js';

export interface SimResult {
  ok: boolean;
  /** Raw node message, or '' when the group passed. */
  failure: string;
  /** The assert's source message, when the failing app is one we have a map for. */
  reason?: string;
  app?: number;
  pc?: number;
  /** Set when the bundled builds disagree on this pc — pass a `build`. */
  ambiguous?: true;
  /** Per-transaction opcode budget consumed — useful for spotting a tight group. */
  budgets: number[];
  /** Resources the group touched but did not name. Empty when fully populated. */
  unnamed?: unknown;
}

/**
 * Resolve `assert failed pc=N` to the assert that actually fired.
 *
 * Only resolve pcs belonging to the app whose map we hold: a failure inside the
 * registry, the router or the oracle has its own program and its own pcs, and
 * looking those up here would produce a confident wrong answer.
 *
 * PASS THE BUILD YOU SUBMITTED. The full and restricted passports have different
 * maps — of 250 entries only 97 pcs are shared and NINE of those disagree — so the
 * wrong map does not merely fail to help, it names a guard that did not fire.
 * Without a build this answers only where every bundled map AGREES and reports
 * `ambiguous` otherwise, because the entire purpose of this function is to be
 * believed, and silence beats a plausible lie.
 */
export function explain(
  failure: string,
  opts: { passportAppId?: number; build?: Build } | number = {},
): { reason?: string; app?: number; pc?: number; ambiguous?: true } {
  // A bare number keeps the previous call shape working; it was always the app id.
  const o = typeof opts === 'number' ? { passportAppId: opts } : opts;
  if (!failure) return {};
  const app = /app=(\d+)/.exec(failure);
  const pc = /pc=(\d+)/.exec(failure);
  const appId = app ? Number(app[1]) : undefined;
  const pcNum = pc ? Number(pc[1]) : undefined;
  if (pcNum === undefined) return {};
  if (o.passportAppId !== undefined && appId !== undefined && appId !== o.passportAppId) {
    return { app: appId, pc: pcNum }; // not our program — do not guess
  }
  const base = { ...(appId !== undefined ? { app: appId } : {}), pc: pcNum };
  if (o.build) {
    const reason = o.build.assertMessages[pcNum];
    return { ...base, ...(reason !== undefined ? { reason } : {}) };
  }
  const answers = new Set(
    ALL_BUILDS.map((b) => b.assertMessages[pcNum]).filter(
      (m): m is string => m !== undefined,
    ),
  );
  const only = [...answers][0];
  if (answers.size === 1 && only !== undefined) return { ...base, reason: only };
  if (answers.size > 1) return { ...base, ambiguous: true };
  return base;
}

/**
 * Simulate an unsigned group. Needs no keys — which is what makes it usable for
 * previewing a KEEPER transaction from a front-end that holds no keeper
 * credential.
 *
 * `allowUnnamed` reports the resources a group touched without naming, which is
 * the input to the populate-and-rebuild loop a crank builder needs.
 */
export async function simulate(
  algod: Algodv2,
  group: Transaction[],
  opts: { passportAppId?: number; allowUnnamed?: boolean; build?: Build } = {},
): Promise<SimResult> {
  const req = new modelsv2.SimulateRequest({
    txnGroups: [
      new modelsv2.SimulateRequestTransactionGroup({
        txns: group.map((t) => encodeUnsignedSimulateTransaction(t)) as never,
      }),
    ],
    allowEmptySignatures: true,
    ...(opts.allowUnnamed ? { allowUnnamedResources: true } : {}),
  });
  const res = await algod.simulateTransactions(req).do();
  const g = res.txnGroups[0];
  const failure = g?.failureMessage ?? '';
  const budgets = (g?.txnResults ?? []).map((r) => Number(r.appBudgetConsumed ?? 0));
  const unnamed = g?.unnamedResourcesAccessed;
  return {
    ok: !failure,
    failure,
    ...explain(failure, opts),
    budgets,
    ...(unnamed ? { unnamed } : {}),
  };
}

/** Throw with the resolved assert message rather than the raw pc. */
export async function simulateOrThrow(
  algod: Algodv2,
  group: Transaction[],
  opts: { passportAppId?: number; build?: Build } = {},
): Promise<SimResult> {
  const r = await simulate(algod, group, opts);
  if (!r.ok) {
    throw new Error(
      r.reason
        ? `refused by: ${r.reason} (app ${r.app}, pc ${r.pc})`
        : r.ambiguous
          // Two bundled builds disagree on this pc. Naming either would be a
          // guess, so give the caller the pc and tell them to pass a build.
          ? `refused at app ${r.app} pc ${r.pc} — the bundled builds disagree on ` +
            `this pc; pass { build } to resolve it`
          : `simulate failed: ${r.failure}`,
    );
  }
  return r;
}
