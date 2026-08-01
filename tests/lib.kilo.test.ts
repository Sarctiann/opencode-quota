import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    resolveKiloApiKey: vi.fn(),
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/kilo-config.js", () => ({
  resolveKiloApiKey: mocks.resolveKiloApiKey,
}));

import { queryKiloPassState } from "../src/lib/kilo.js";

function mockResponse(params: { ok: boolean; status: number; json?: unknown; text?: string }) {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: params.ok,
    status: params.status,
    text: async () => params.text ?? JSON.stringify(params.json),
  });
}

function statePayload(overrides: Record<string, unknown> = {}) {
  return [
    {
      result: {
        data: {
          json: {
            subscription: {
              currentPeriodBaseCreditsUsd: 19,
              currentPeriodUsageUsd: 2.76,
              currentPeriodBonusCreditsUsd: 9.5,
              nextBillingAt: "2099-02-01T00:00:00.000Z",
              ...overrides,
            },
          },
        },
      },
    },
  ];
}

describe("queryKiloPassState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveKiloApiKey.mockResolvedValue({
      key: "kilo-secret-key",
      source: "env:KILO_API_KEY",
    });
  });

  it("returns null without a configured API key", async () => {
    mocks.resolveKiloApiKey.mockResolvedValueOnce(null);

    await expect(queryKiloPassState()).resolves.toBeNull();
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("sends the batched tRPC state request with Bearer auth", async () => {
    mockResponse({ ok: true, status: 200, json: statePayload() });

    await queryKiloPassState({ requestTimeoutMs: 1234 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://app.kilo.ai/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D",
      expect.objectContaining({
        request: {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer kilo-secret-key",
            "Content-Type": "application/json",
          },
          redirect: "manual",
        },
        timeoutMs: 1234,
        consume: expect.any(Function),
      }),
    );
  });

  it("parses the batched tRPC json envelope and derives remaining credits", async () => {
    mockResponse({ ok: true, status: 200, json: statePayload() });

    await expect(queryKiloPassState()).resolves.toEqual({
      success: true,
      baseCreditsUsd: 19,
      usageUsd: 2.76,
      bonusCreditsUsd: 9.5,
      remainingUsd: 25.74,
      resetTimeIso: "2099-02-01T00:00:00.000Z",
    });
  });

  it("clamps remaining credits to zero when usage exceeds the period credits", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: statePayload({
        currentPeriodBaseCreditsUsd: 10,
        currentPeriodUsageUsd: 12,
        currentPeriodBonusCreditsUsd: 0,
      }),
    });

    await expect(queryKiloPassState()).resolves.toMatchObject({
      success: true,
      remainingUsd: 0,
    });
  });

  it("accepts the unwrapped data envelope and treats a missing bonus as zero", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: {
        result: {
          data: {
            subscription: {
              currentPeriodBaseCreditsUsd: 5,
              currentPeriodUsageUsd: 1,
              nextRenewalAt: "2099-03-01T00:00:00.000Z",
            },
          },
        },
      },
    });

    await expect(queryKiloPassState()).resolves.toEqual({
      success: true,
      baseCreditsUsd: 5,
      usageUsd: 1,
      bonusCreditsUsd: 0,
      remainingUsd: 4,
      resetTimeIso: "2099-03-01T00:00:00.000Z",
    });
  });

  it("rejects missing subscriptions and invalid credit fields", async () => {
    mockResponse({ ok: true, status: 200, json: null });
    await expect(queryKiloPassState()).resolves.toMatchObject({ success: false });

    mockResponse({ ok: true, status: 200, json: [{ result: { data: { json: {} } } }] });
    await expect(queryKiloPassState()).resolves.toMatchObject({ success: false });

    mockResponse({
      ok: true,
      status: 200,
      json: statePayload({ currentPeriodBaseCreditsUsd: -1 }),
    });
    await expect(queryKiloPassState()).resolves.toMatchObject({ success: false });

    mockResponse({
      ok: true,
      status: 200,
      json: statePayload({ currentPeriodUsageUsd: "2.76" }),
    });
    await expect(queryKiloPassState()).resolves.toMatchObject({ success: false });

    mockResponse({
      ok: true,
      status: 200,
      json: statePayload({ currentPeriodBonusCreditsUsd: -1 }),
    });
    await expect(queryKiloPassState()).resolves.toMatchObject({ success: false });
  });

  it("reports HTTP errors without leaking the API key", async () => {
    mockResponse({
      ok: false,
      status: 401,
      text: "Unauthorized\nkilo-secret-key\u001b[31m",
    });

    const out = await queryKiloPassState();
    const error = out && !out.success ? out.error : "";

    expect(error).toBe("Kilo Gateway state API error 401: Unauthorized [redacted]");
    expect(error).not.toContain("kilo-secret-key");
    expect(error).not.toContain("\u001b");
  });

  it("rejects oversized responses before parsing", async () => {
    mockResponse({ ok: true, status: 200, text: "x".repeat(64 * 1024 + 1) });

    const out = await queryKiloPassState();
    expect(out && !out.success ? out.error : "").toBe(
      "Kilo Gateway state API response exceeded 65536 bytes",
    );
  });

  it("sanitizes parse and transport errors without leaking the key", async () => {
    mockResponse({ ok: true, status: 200, text: "not json kilo-secret-key\nnext" });

    const malformed = await queryKiloPassState();
    expect(malformed && !malformed.success ? malformed.error : "").toContain("Unexpected token");
    expect(JSON.stringify(malformed)).not.toContain("kilo-secret-key");

    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("timeout kilo-secret-key\nnext"));
    const timedOut = await queryKiloPassState();
    expect(timedOut && !timedOut.success ? timedOut.error : "").toBe("timeout [redacted] next");
  });
});
