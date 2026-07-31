/**
 * Kilo Gateway provider wrapper.
 */

import type { AccountingMetadata } from "../lib/entries.js";
import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult, QuotaToastEntry } from "../lib/entries.js";
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

const KILO_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

type KiloPassStateSuccess = Extract<NonNullable<KiloPassStateResult>, { success: true }>;

function buildKiloGatewayEntries(state: KiloPassStateSuccess): QuotaToastEntry[] {
  const total = state.totalUsd + state.bonusUsd;

  const percentEntry: QuotaToastEntry | undefined =
    total > 0
      ? {
          accounting: KILO_ACCOUNTING,
          name: "Kilo Gateway",
          group: "Kilo Gateway",
          label: "Credits:",
          percentRemaining: Math.min(100, Math.max(0, ((total - state.usageUsd) / total) * 100)),
        }
      : undefined;

  const bonusText = state.bonusUsd > 0 ? ` + ${fmtUsdAmount(state.bonusUsd)}` : "";

  return [
    ...(percentEntry ? [percentEntry] : []),
    {
      kind: "value",
      accounting: KILO_ACCOUNTING,
      name: "Kilo Gateway Balance",
      group: "Kilo Gateway",
      label: `U: ${fmtUsdAmount(state.usageUsd)}`,
      value: `B: ${fmtUsdAmount(state.balanceUsd)}${bonusText}`,
    },
  ];
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

    const stateResult = await queryKiloPassState({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    const keyStatusDetails = simpleApiKeyStatusDetails(diagnostics);

    if (!stateResult) {
      return withStatusDetails(notAttemptedResult(), [...keyStatusDetails]);
    }

    if (!stateResult.success) {
      return withStatusDetails(
        { attempted: true, entries: [], errors: [{ label: "Kilo Gateway", message: stateResult.error }] },
        [...keyStatusDetails],
      );
    }

    const entries = buildKiloGatewayEntries(stateResult);

    return withStatusDetails(attemptedResult(entries), [
      ...keyStatusDetails,
      ...statusDetailsFromRecord({ balance_usd: fmtUsdAmount(stateResult.balanceUsd) }),
    ]);
  },
};
