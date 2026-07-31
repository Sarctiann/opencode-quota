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

import { queryKiloUser } from "../src/lib/kilo.js";

function mockResponse(params: { ok: boolean; status: number; json?: unknown; text?: string }) {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: params.ok,
    status: params.status,
    text: async () => params.text ?? JSON.stringify(params.json),
  });
}

describe("queryKiloUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveKiloApiKey.mockResolvedValue({
      key: "kilo-secret-key",
      source: "env:KILO_API_KEY",
    });
  });

  it("returns null without a configured API key", async () => {
    mocks.resolveKiloApiKey.mockResolvedValueOnce(null);

    await expect(queryKiloUser()).resolves.toBeNull();
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("sends the documented user request with Bearer auth", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: {
        total_microdollars_acquired: 19_000_000,
        microdollars_used: 2_760_000,
      },
    });

    await queryKiloUser({ requestTimeoutMs: 1234 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://api.kilo.ai/api/user",
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

  it("derives the USD balance from acquired and used microdollars", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: {
        total_microdollars_acquired: 19_000_000,
        microdollars_used: 2_760_000,
      },
    });

    await expect(queryKiloUser()).resolves.toEqual({
      success: true,
      totalMicrodollars: 19_000_000,
      microdollarsUsed: 2_760_000,
      balanceUsd: 16.24,
    });
  });

  it("defaults missing usage to zero", async () => {
    mockResponse({
      ok: true,
      status: 200,
      json: { total_microdollars_acquired: 5_000_000 },
    });

    await expect(queryKiloUser()).resolves.toEqual({
      success: true,
      totalMicrodollars: 5_000_000,
      microdollarsUsed: 0,
      balanceUsd: 5,
    });
  });

  it("rejects unsupported user shapes", async () => {
    mockResponse({ ok: true, status: 200, json: null });
    await expect(queryKiloUser()).resolves.toMatchObject({ success: false });

    mockResponse({ ok: true, status: 200, json: { total_microdollars_acquired: -1 } });
    await expect(queryKiloUser()).resolves.toMatchObject({ success: false });

    mockResponse({ ok: true, status: 200, json: { total_microdollars_acquired: "19" } });
    await expect(queryKiloUser()).resolves.toMatchObject({ success: false });
  });

  it("reports HTTP errors without leaking the API key", async () => {
    mockResponse({
      ok: false,
      status: 401,
      text: "Unauthorized\nkilo-secret-key\u001b[31m",
    });

    const out = await queryKiloUser();
    const error = out && !out.success ? out.error : "";

    expect(error).toBe("Kilo Gateway user API error 401: Unauthorized [redacted]");
    expect(error).not.toContain("kilo-secret-key");
    expect(error).not.toContain("\u001b");
  });

  it("rejects oversized responses before parsing", async () => {
    mockResponse({ ok: true, status: 200, text: "x".repeat(64 * 1024 + 1) });

    const out = await queryKiloUser();
    expect(out && !out.success ? out.error : "").toBe(
      "Kilo Gateway user API response exceeded 65536 bytes",
    );
  });

  it("sanitizes parse and transport errors without leaking the key", async () => {
    mockResponse({ ok: true, status: 200, text: "not json kilo-secret-key\nnext" });

    const malformed = await queryKiloUser();
    expect(malformed && !malformed.success ? malformed.error : "").toContain("Unexpected token");
    expect(JSON.stringify(malformed)).not.toContain("kilo-secret-key");

    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error("timeout kilo-secret-key\nnext"));
    const timedOut = await queryKiloUser();
    expect(timedOut && !timedOut.success ? timedOut.error : "").toBe("timeout [redacted] next");
  });
});
