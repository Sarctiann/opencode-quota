/**
 * Google Antigravity provider wrapper.
 */

import { stat } from "fs/promises";

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import type { GoogleModelId } from "../lib/types.js";
import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import { inspectAntigravityCompanionPresence } from "../lib/google-antigravity-companion.js";
import { getGoogleTokenCachePath } from "../lib/google-token-cache.js";
import {
  hasAntigravityQuotaRuntimeAvailable,
  inspectAntigravityAccountsPresence,
  queryGoogleQuota,
} from "../lib/google.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { formatGoogleAccountErrors, formatGoogleAccountLabel } from "./google-account-format.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const GOOGLE_ANTIGRAVITY_LABEL = "Google Antigravity";

async function isAccountsConfigured(): Promise<boolean> {
  try {
    return await hasAntigravityQuotaRuntimeAvailable();
  } catch {
    return false;
  }
}

export const googleAntigravityProvider: QuotaProvider = {
  id: "google-antigravity",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    // Google quota depends on both the accounts file and the separately
    // installed companion auth plugin.
    return await isAccountsConfigured();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["google", "antigravity", "opencode"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const [auth, companion] = await Promise.all([
      inspectAntigravityAccountsPresence(),
      inspectAntigravityCompanionPresence(),
    ]);
    const tokenCachePath = getGoogleTokenCachePath();
    const tokenCacheExists = await stat(tokenCachePath).then(
      () => true,
      () => false,
    );
    const statusDetails = statusDetailsFromRecord({
      auth_state: auth.state,
      selected_accounts_path: auth.selectedPath ?? "(none)",
      present_accounts_paths: auth.presentPaths.join(" | ") || "(none)",
      candidate_accounts_paths: auth.candidatePaths.join(" | ") || "(none)",
      account_count: String(auth.accountCount),
      valid_account_count: String(auth.validAccountCount),
      companion_package_state: companion.state,
      companion_package_path:
        companion.state === "present" || companion.state === "invalid"
          ? (companion.resolvedPath ?? "(none)")
          : "(none)",
      companion_error:
        companion.state !== "present" ? sanitizeDisplayText(companion.error) : undefined,
      token_cache_path: `${tokenCachePath} exists=${tokenCacheExists ? "true" : "false"}`,
      auth_error:
        auth.state === "invalid" && auth.error ? sanitizeDisplayText(auth.error) : undefined,
    });
    const modelIds = ctx.config.googleModels as GoogleModelId[];
    const result = await queryGoogleQuota(modelIds, {
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });

    if (!result) {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult("Antigravity", result.error), statusDetails);
    }

    const entries: QuotaToastEntry[] = result.models.map((m) => {
      const accountLabel = m.accountEmail
        ? formatGoogleAccountLabel(m.accountEmail, "fixedGmailHint")
        : "";
      const accountSuffix = accountLabel ? ` (${accountLabel})` : "";
      return {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
        },
        name: `${GOOGLE_ANTIGRAVITY_LABEL} ${m.displayName}${accountSuffix}`,
        group: GOOGLE_ANTIGRAVITY_LABEL,
        label: `${m.displayName}:`,
        percentRemaining: m.percentRemaining,
        resetTimeIso: m.resetTimeIso,
      };
    });

    return withStatusDetails(
      attemptedResult(entries, formatGoogleAccountErrors(result.errors, "fixedGmailHint"), {
        classicStrategy: "preserve",
      }),
      statusDetails,
    );
  },
};
