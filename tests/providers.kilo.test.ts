import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  getKiloKeyDiagnostics: vi.fn(),
  hasKiloApiKey: vi.fn(),
  queryKiloPassState: vi.fn(),
}));

vi.mock("../src/lib/kilo-config.js", () => ({
  getKiloKeyDiagnostics: mocks.getKiloKeyDiagnostics,
  hasKiloApiKey: mocks.hasKiloApiKey,
}));

vi.mock("../src/lib/kilo.js", () => ({
  queryKiloPassState: mocks.queryKiloPassState,
}));

import { kiloProvider } from "../src/providers/kilo.js";

describe("Kilo Gateway provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getKiloKeyDiagnostics.mockResolvedValue({
      configured: true,
      source: "env:KILO_API_KEY",
      checkedPaths: ["env:KILO_API_KEY"],
      authPaths: ["/tmp/auth.json"],
    });
  });

  it("uses the documented canonical provider identity and model prefix", () => {
    expect(kiloProvider.id).toBe("kilo");
    expect(kiloProvider.matchesCurrentModel?.("kilo/anthropic/claude-sonnet-4")).toBe(true);
    expect(kiloProvider.matchesCurrentModel?.("kilo-gateway/model")).toBe(false);
    expect(kiloProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });

  it("is available only when a trusted Kilo API key exists", async () => {
    mocks.hasKiloApiKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(kiloProvider.isAvailable({} as any)).resolves.toBe(true);
    await expect(kiloProvider.isAvailable({} as any)).resolves.toBe(false);
  });

  it("does not attempt a request without trusted configuration", async () => {
    mocks.queryKiloPassState.mockResolvedValueOnce(null);

    const out = await kiloProvider.fetch({} as any);

    expectNotAttempted(out);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "api_key_configured", value: "true" },
        { key: "api_key_source", value: "env:KILO_API_KEY" },
      ]),
    );
  });

  it("shows credit percentage, balance, usage, and bonus from the state API", async () => {
    mocks.queryKiloPassState.mockResolvedValueOnce({
      success: true,
      totalUsd: 10,
      usageUsd: 2.5,
      balanceUsd: 7.5,
      bonusUsd: 5,
    });

    const out = await kiloProvider.fetch({ config: { requestTimeoutMs: 9000 } } as any);

    expectAttemptedWithNoErrors(out);
    expect(mocks.queryKiloPassState).toHaveBeenCalledWith({ requestTimeoutMs: 9000 });
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        name: "Kilo Gateway",
        group: "Kilo Gateway",
        label: "Credits:",
        percentRemaining: 83.33333333333334,
      },
      {
        kind: "value",
        name: "Kilo Gateway Balance",
        group: "Kilo Gateway",
        label: "U: $2.50",
        value: "B: $7.50 + $5.00",
      },
    ]);
    expect(out.statusDetails).toContainEqual({ key: "balance_usd", value: "$7.50" });
  });

  it("omits the bonus segment and counts only base credits when no bonus exists", async () => {
    mocks.queryKiloPassState.mockResolvedValueOnce({
      success: true,
      totalUsd: 10,
      usageUsd: 2.5,
      balanceUsd: 7.5,
      bonusUsd: 0,
    });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        name: "Kilo Gateway",
        group: "Kilo Gateway",
        label: "Credits:",
        percentRemaining: 75,
      },
      {
        kind: "value",
        name: "Kilo Gateway Balance",
        group: "Kilo Gateway",
        label: "U: $2.50",
        value: "B: $7.50",
      },
    ]);
  });

  it("hides the percent entry when no credits were acquired", async () => {
    mocks.queryKiloPassState.mockResolvedValueOnce({
      success: true,
      totalUsd: 0,
      usageUsd: 0,
      balanceUsd: 0,
      bonusUsd: 0,
    });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "kilo")).toEqual([
      {
        kind: "value",
        name: "Kilo Gateway Balance",
        group: "Kilo Gateway",
        label: "U: $0.00",
        value: "B: $0.00",
      },
    ]);
  });

  it("maps API failures into a safe Kilo Gateway error", async () => {
    mocks.queryKiloPassState.mockResolvedValueOnce({ success: false, error: "Unauthorized" });

    const out = await kiloProvider.fetch({} as any);

    expectAttemptedWithErrorLabel(out, "Kilo Gateway");
  });
});
