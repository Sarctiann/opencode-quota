/**
 * Kilo Gateway API client.
 *
 * Reports Kilo Pass credit totals and usage from the authenticated tRPC
 * subscription-state endpoint.
 */

import type { QuotaError } from "./types.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { resolveKiloApiKey } from "./kilo-config.js";

const KILO_PASS_STATE_ENDPOINT = "https://app.kilo.ai/api/trpc/kiloPass.getState";
const MAX_RESPONSE_BYTES = 64 * 1024;

export type KiloPassStateResult =
  | {
      success: true;
      baseCreditsUsd: number;
      usageUsd: number;
      bonusCreditsUsd: number;
      remainingUsd: number;
      resetTimeIso?: string;
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

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseKiloPassState(payload: unknown): KiloPassStateResult {
  const item = Array.isArray(payload) ? payload[0] : payload;
  const result = isRecord(item) ? item.result : undefined;
  const data = isRecord(result) ? result.data : undefined;
  const root = isRecord(data) && isRecord(data.json) ? data.json : data;
  const subscription = isRecord(root) ? root.subscription : undefined;

  if (!isRecord(subscription)) {
    return {
      success: false,
      error: "Kilo Gateway state API returned no active Kilo Pass subscription",
    };
  }

  const baseCreditsUsd = nonnegativeNumber(subscription.currentPeriodBaseCreditsUsd);
  const usageUsd = nonnegativeNumber(subscription.currentPeriodUsageUsd);
  const rawBonusCreditsUsd = subscription.currentPeriodBonusCreditsUsd;
  const bonusCreditsUsd =
    rawBonusCreditsUsd === null || rawBonusCreditsUsd === undefined
      ? 0
      : nonnegativeNumber(rawBonusCreditsUsd);

  if (baseCreditsUsd === null) {
    return {
      success: false,
      error: "Kilo Gateway state API returned invalid currentPeriodBaseCreditsUsd",
    };
  }
  if (usageUsd === null) {
    return {
      success: false,
      error: "Kilo Gateway state API returned invalid currentPeriodUsageUsd",
    };
  }
  if (bonusCreditsUsd === null) {
    return {
      success: false,
      error: "Kilo Gateway state API returned invalid currentPeriodBonusCreditsUsd",
    };
  }

  const resetValue = subscription.nextBillingAt ?? subscription.nextRenewalAt;
  const resetTimeIso =
    typeof resetValue === "string" && Number.isFinite(Date.parse(resetValue))
      ? resetValue
      : undefined;
  const remainingUsd =
    Math.round(Math.max(0, baseCreditsUsd + bonusCreditsUsd - usageUsd) * 100) / 100;

  return {
    success: true,
    baseCreditsUsd,
    usageUsd,
    bonusCreditsUsd,
    remainingUsd,
    ...(resetTimeIso ? { resetTimeIso } : {}),
  };
}

export async function queryKiloPassState(
  options: { requestTimeoutMs?: number } = {},
): Promise<KiloPassStateResult> {
  const resolved = await resolveKiloApiKey();
  if (!resolved) return null;

  const query = new URLSearchParams({
    batch: "1",
    input: JSON.stringify({ "0": null }),
  });

  try {
    return await fetchWithTimeout(`${KILO_PASS_STATE_ENDPOINT}?${query.toString()}`, {
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
