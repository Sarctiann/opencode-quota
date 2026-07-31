/**
 * Kilo Gateway provider wrapper.
 */

import type { AccountingMetadata } from "../lib/entries.js";
import type { QuotaProvider, QuotaProviderContext, QuotaProviderResult, QuotaToastEntry } from "../lib/entries.js";
import { fmtUsdAmount } from "../lib/format-utils.js";
import { getKiloKeyDiagnostics, hasKiloApiKey } from "../lib/kilo-config.js";
import { queryKiloUser, type KiloUserResult } from "../lib/kilo.js";
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

type KiloUserSuccess = Extract<NonNullable<KiloUserResult>, { success: true }>;

function buildKiloGatewayEntries(user: KiloUserSuccess): QuotaToastEntry[] {
  const percentEntry: QuotaToastEntry | undefined =
    user.totalMicrodollars > 0
      ? {
          accounting: KILO_ACCOUNTING,
          name: "Kilo Gateway",
          group: "Kilo Gateway",
          label: "Credits:",
          percentRemaining: Math.min(
            100,
            Math.max(0, ((user.totalMicrodollars - user.microdollarsUsed) / user.totalMicrodollars) * 100),
          ),
        }
      : undefined;

  return [
    ...(percentEntry ? [percentEntry] : []),
    {
      kind: "value",
      accounting: KILO_ACCOUNTING,
      name: "Kilo Gateway Balance",
      group: "Kilo Gateway",
      label: "Balance:",
      value: `${fmtUsdAmount(user.balanceUsd)}  │  Usage: ${fmtUsdAmount(user.microdollarsUsed / 1_000_000)}`,
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

    const userResult = await queryKiloUser({ requestTimeoutMs: ctx.config?.requestTimeoutMs });

    const keyStatusDetails = simpleApiKeyStatusDetails(diagnostics);

    if (!userResult) {
      return withStatusDetails(notAttemptedResult(), [...keyStatusDetails]);
    }

    if (!userResult.success) {
      return withStatusDetails(
        { attempted: true, entries: [], errors: [{ label: "Kilo Gateway", message: userResult.error }] },
        [...keyStatusDetails],
      );
    }

    const entries = buildKiloGatewayEntries(userResult);

    return withStatusDetails(attemptedResult(entries), [
      ...keyStatusDetails,
      ...statusDetailsFromRecord({ balance_usd: fmtUsdAmount(userResult.balanceUsd) }),
    ]);
  },
};
