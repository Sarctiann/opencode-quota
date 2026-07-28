import { describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";
import { visibleEntries } from "./helpers/provider-assertions.js";
import { googleAntigravityProvider } from "../src/providers/google-antigravity.js";

vi.mock("../src/lib/google.js", () => ({
  hasAntigravityQuotaRuntimeAvailable: vi.fn(),
  queryGoogleQuota: vi.fn(),
  inspectAntigravityAccountsPresence: vi.fn(async () => ({
    state: "missing",
    selectedPath: null,
    presentPaths: [],
    candidatePaths: [],
    accountCount: 0,
    validAccountCount: 0,
  })),
}));

vi.mock("../src/lib/google-antigravity-companion.js", () => ({
  inspectAntigravityCompanionPresence: vi.fn(async () => ({
    state: "missing",
    error: "companion unavailable",
  })),
}));

describe("google antigravity provider", () => {
  it("returns attempted:false when antigravity accounts are not configured", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce(null);

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expectNotAttempted(out);
  });

  it("maps success into toast entries and truncated error labels", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: true,
      models: [
        {
          displayName: "Claude",
          accountEmail: "alice@example.com",
          percentRemaining: 64,
          resetTimeIso: "2026-01-01T00:00:00.000Z",
        },
      ],
      errors: [{ email: "bob@example.com", error: "Unauthorized" }],
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "google-antigravity")).toEqual([
      {
        name: "Google Antigravity Claude (ali..gmail)",
        group: "Google Antigravity",
        label: "Claude:",
        percentRemaining: 64,
        resetTimeIso: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(out.entries[0]?.accounting).toEqual({
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    });
    expect(JSON.stringify(out.entries)).not.toContain("Anthropic");
    expect(out.errors).toEqual([{ label: "bob..gmail", message: "Unauthorized" }]);
  });

  it("omits the account suffix when the quota result has no email", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: true,
      models: [
        {
          displayName: "Claude",
          percentRemaining: 64,
        },
      ],
      errors: [],
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expect(visibleEntries(out.entries, "google-antigravity")).toEqual([
      {
        name: "Google Antigravity Claude",
        group: "Google Antigravity",
        label: "Claude:",
        percentRemaining: 64,
      },
    ]);
  });

  it("maps fetch failures into toast errors", async () => {
    const { queryGoogleQuota } = await import("../src/lib/google.js");
    (queryGoogleQuota as any).mockResolvedValueOnce({
      success: false,
      error: "Token expired",
    });

    const out = await googleAntigravityProvider.fetch({ config: { googleModels: [] } } as any);
    expectAttemptedWithErrorLabel(out, "Antigravity");
  });

  it("is available only when the antigravity runtime is configured", async () => {
    const { hasAntigravityQuotaRuntimeAvailable } = await import("../src/lib/google.js");
    (hasAntigravityQuotaRuntimeAvailable as any).mockResolvedValueOnce(true);
    await expect(googleAntigravityProvider.isAvailable({} as any)).resolves.toBe(true);

    (hasAntigravityQuotaRuntimeAvailable as any).mockResolvedValueOnce(false);
    await expect(googleAntigravityProvider.isAvailable({} as any)).resolves.toBe(false);
  });

  it("returns false when runtime detection throws", async () => {
    const { hasAntigravityQuotaRuntimeAvailable } = await import("../src/lib/google.js");
    (hasAntigravityQuotaRuntimeAvailable as any).mockRejectedValueOnce(new Error("boom"));

    await expect(googleAntigravityProvider.isAvailable({} as any)).resolves.toBe(false);
  });
});
