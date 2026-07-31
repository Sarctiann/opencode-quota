/**
 * Kilo Gateway API client.
 *
 * Reports credit-remaining percentage, USD balance, and usage from the user
 * account endpoint alone.
 */

import type { QuotaError } from "./types.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { resolveKiloApiKey } from "./kilo-config.js";

const KILO_USER_URL = "https://api.kilo.ai/api/user";
const MAX_RESPONSE_BYTES = 64 * 1024;

export type KiloUserResult =
  | {
      success: true;
      totalMicrodollars: number;
      microdollarsUsed: number;
      balanceUsd: number;
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

function parseKiloUser(payload: unknown): KiloUserResult {
  if (!isRecord(payload)) {
    return {
      success: false,
      error: "Kilo Gateway user API returned an unexpected response shape",
    };
  }

  const totalMicrodollars = payload.total_microdollars_acquired;
  const microdollarsUsed = payload.microdollars_used;

  if (typeof totalMicrodollars !== "number" || !Number.isFinite(totalMicrodollars) || totalMicrodollars < 0) {
    return {
      success: false,
      error: "Kilo Gateway user API returned invalid total_microdollars_acquired",
    };
  }

  const used = typeof microdollarsUsed === "number" && Number.isFinite(microdollarsUsed) && microdollarsUsed >= 0
    ? microdollarsUsed
    : 0;

  return {
    success: true,
    totalMicrodollars,
    microdollarsUsed: used,
    balanceUsd: (totalMicrodollars - used) / 1_000_000,
  };
}

export async function queryKiloUser(
  options: { requestTimeoutMs?: number } = {},
): Promise<KiloUserResult> {
  const resolved = await resolveKiloApiKey();
  if (!resolved) return null;

  try {
    return await fetchWithTimeout(KILO_USER_URL, {
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
          throw new Error(`Kilo Gateway user API response exceeded ${MAX_RESPONSE_BYTES} bytes`);
        }
        if (!response.ok) {
          return {
            success: false,
            error: `Kilo Gateway user API error ${response.status}: ${sanitizeMessage(text, resolved.key)}`,
          };
        }

        return parseKiloUser(JSON.parse(text) as unknown);
      },
    });
  } catch (error) {
    return {
      success: false,
      error: sanitizeMessage(error instanceof Error ? error.message : String(error), resolved.key),
    };
  }
}
