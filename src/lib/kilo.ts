/**
 * Kilo Gateway API client.
 *
 * Reports credit-remaining percentage, USD balance, and usage from the Kilo
 * Pass subscription state endpoint (tRPC) alone.
 */

import type { QuotaError } from "./types.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { resolveKiloApiKey } from "./kilo-config.js";

const KILO_PASS_STATE_URL = "https://app.kilo.ai/api/trpc/kiloPass.getState";
const MAX_RESPONSE_BYTES = 64 * 1024;

export type KiloPassStateResult =
  | {
      success: true;
      totalUsd: number;
      usageUsd: number;
      balanceUsd: number;
      bonusUsd: number;
    }
  | QuotaError
  | null;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeMessage(text: string, secret?: string, maxLength = 200): string {
  const redacted = secret ? text.split(secret).join("[redacted]") : text;
  return (sanitizeSingleLineDisplayText(redacted) || "unknown").slice(0, maxLength);
}

function parseKiloPassState(payload: unknown): KiloPassStateResult {
  if (
    !isRecord(payload) ||
    !isRecord(payload.result) ||
    !isRecord(payload.result.data) ||
    !isRecord(payload.result.data.subscription)
  ) {
    return {
      success: false,
      error: "Kilo Gateway state API returned an unexpected response shape",
    };
  }

  const subscription = payload.result.data.subscription;
  const baseCreditsUsd = subscription.currentPeriodBaseCreditsUsd;
  const usageUsd = subscription.currentPeriodUsageUsd;
  const bonusCreditsUsd = subscription.currentPeriodBonusCreditsUsd;

  if (typeof baseCreditsUsd !== "number" || !Number.isFinite(baseCreditsUsd) || baseCreditsUsd < 0) {
    return {
      success: false,
      error: "Kilo Gateway state API returned invalid currentPeriodBaseCreditsUsd",
    };
  }

  const used =
    typeof usageUsd === "number" && Number.isFinite(usageUsd) && usageUsd >= 0 ? usageUsd : 0;
  const bonus =
    typeof bonusCreditsUsd === "number" && Number.isFinite(bonusCreditsUsd) && bonusCreditsUsd >= 0
      ? bonusCreditsUsd
      : 0;

  const balanceUsd = Math.round((baseCreditsUsd - used) * 100) / 100;

  return {
    success: true,
    totalUsd: baseCreditsUsd,
    usageUsd: used,
    balanceUsd,
    bonusUsd: bonus,
  };
}

export async function queryKiloPassState(
  options: { requestTimeoutMs?: number } = {},
): Promise<KiloPassStateResult> {
  const resolved = await resolveKiloApiKey();
  if (!resolved) return null;

  try {
    return await fetchWithTimeout(KILO_PASS_STATE_URL, {
      request: {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${resolved.key}`,
          "Content-Type": "application/json",
        },
        redirect: "manual",
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
          throw new Error(`Kilo Gateway state API response exceeded ${MAX_RESPONSE_BYTES} bytes`);
        }
        if (!response.ok) {
          return {
            success: false,
            error: `Kilo Gateway state API error ${response.status}: ${sanitizeMessage(text, resolved.key)}`,
          };
        }

        return parseKiloPassState(JSON.parse(text) as unknown);
      },
    });
  } catch (error) {
    return {
      success: false,
      error: sanitizeMessage(error instanceof Error ? error.message : String(error), resolved.key),
    };
  }
}
