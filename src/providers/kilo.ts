/**
 * Kilo Gateway provider wrapper.
 */

import type { AccountingMetadata } from "../lib/entries.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { getKiloKeyDiagnostics, hasKiloApiKey } from "../lib/kilo-config.js";
import { queryKiloPassState, type KiloPassStateResult } from "../lib/kilo.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import {
  attemptedResult,
  notAttemptedResult,
  simpleApiKeyStatusDetails,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const KILO_QUOTA_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "locally_derived",
};

const KILO_REMAINING_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "locally_derived",
};

type KiloPassStateSuccess = Extract<NonNullable<KiloPassStateResult>, { success: true }>;

function buildKiloGatewayEntries(state: KiloPassStateSuccess): QuotaToastEntry[] {
  const totalCreditsUsd = state.baseCreditsUsd + state.bonusCreditsUsd;
  const entries: QuotaToastEntry[] = [];

  if (totalCreditsUsd > 0) {
    entries.push({
      accounting: KILO_QUOTA_ACCOUNTING,
      name: "Kilo Gateway Credits",
      group: "Kilo Gateway",
      label: "Credits:",
      right: `${fmtUsdAmount(state.usageUsd)}/${fmtUsdAmount(totalCreditsUsd)} used`,
      percentRemaining: Math.min(
        100,
        Math.max(0, ((totalCreditsUsd - state.usageUsd) / totalCreditsUsd) * 100),
      ),
      resetTimeIso: state.resetTimeIso,
    });
  }

  const bonusText =
    state.bonusCreditsUsd > 0 ? ` (${fmtUsdAmount(state.bonusCreditsUsd)} bonus)` : "";
  entries.push({
    kind: "value",
    accounting: KILO_REMAINING_ACCOUNTING,
    name: "Kilo Gateway Remaining Credits",
    group: "Kilo Gateway",
    label: "Credits:",
    value: `Used: ${fmtUsdAmount(state.usageUsd)} · Remaining: ${fmtUsdAmount(state.remainingUsd)}${bonusText}`,
    resetTimeIso: state.resetTimeIso,
  });

  return entries;
}

export const kiloProvider: QuotaProvider = {
  id: "kilo",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    return await hasKiloApiKey();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "kilo");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getKiloKeyDiagnostics().catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
      authPaths: [],
    }));
    const stateResult = await queryKiloPassState({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    const keyStatusDetails = simpleApiKeyStatusDetails(diagnostics);

    if (!stateResult) {
      return withStatusDetails(notAttemptedResult(), keyStatusDetails);
    }
    if (!stateResult.success) {
      return withStatusDetails(
        {
          attempted: true,
          entries: [],
          errors: [{ label: "Kilo Gateway", message: stateResult.error }],
        },
        keyStatusDetails,
      );
    }

    return withStatusDetails(attemptedResult(buildKiloGatewayEntries(stateResult)), [
      ...keyStatusDetails,
      ...statusDetailsFromRecord({
        base_credits_usd: fmtUsdAmount(stateResult.baseCreditsUsd),
        usage_usd: fmtUsdAmount(stateResult.usageUsd),
        bonus_credits_usd: fmtUsdAmount(stateResult.bonusCreditsUsd),
        remaining_usd: fmtUsdAmount(stateResult.remainingUsd),
        reset_at: stateResult.resetTimeIso ?? "(none)",
      }),
    ]);
  },
};
