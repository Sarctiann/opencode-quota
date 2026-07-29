import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isCommandHandledError } from "../src/lib/command-handled.js";
import {
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createPluginTestClient,
  createPluginToolMockModule,
  createPricingModuleMock,
  createProvidersRegistryModuleMock,
  getPromptText,
  getToastMessage,
  makeQuotaToastTestConfig,
  seedDefaultPluginBootstrapMocks,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-google-antigravity-surfaces";

let provider: (typeof import("../src/providers/google-antigravity.js"))["googleAntigravityProvider"];

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
  getPricingSnapshotMeta: vi.fn(),
  getPricingSnapshotSource: vi.fn(),
  getRuntimePricingRefreshStatePath: vi.fn(),
  getRuntimePricingSnapshotPath: vi.fn(),
  maybeRefreshPricingSnapshot: vi.fn(),
  setPricingSnapshotAutoRefresh: vi.fn(),
  setPricingSnapshotSelection: vi.fn(),
  queryGoogleQuota: vi.fn(),
}));

vi.mock("@opencode-ai/plugin", () => createPluginToolMockModule());
vi.mock("../src/lib/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/config.js")>()),
  ...createConfigModuleMock(mocks.loadConfig),
}));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>()),
  ...createPricingModuleMock(mocks),
}));
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT, { includeCandidates: true }),
);
vi.mock("../src/lib/google.js", () => ({
  hasAntigravityQuotaRuntimeAvailable: vi.fn(async () => true),
  queryGoogleQuota: mocks.queryGoogleQuota,
  inspectAntigravityAccountsPresence: vi.fn(async () => ({
    state: "present",
    selectedPath: `${TEST_RUNTIME_ROOT}/antigravity-accounts.json`,
    presentPaths: [`${TEST_RUNTIME_ROOT}/antigravity-accounts.json`],
    candidatePaths: [`${TEST_RUNTIME_ROOT}/antigravity-accounts.json`],
    accountCount: 2,
    validAccountCount: 2,
  })),
}));
vi.mock("../src/lib/google-antigravity-companion.js", () => ({
  inspectAntigravityCompanionPresence: vi.fn(async () => ({
    state: "present",
    resolvedPath: `${TEST_RUNTIME_ROOT}/opencode-antigravity-auth`,
  })),
}));

type PluginHooks = {
  dispose?: () => Promise<void> | void;
  event?: (input: unknown) => Promise<void> | void;
  "command.execute.before"?: (input: {
    command: string;
    sessionID: string;
  }) => Promise<void> | void;
};

function createConfig() {
  return makeQuotaToastTestConfig({
    enabled: true,
    enabledProviders: ["google-antigravity"],
    formatStyle: "singleWindow",
    googleModels: ["CLAUDE"],
    minIntervalMs: 60_000,
    onlyCurrentModel: false,
    showOnIdle: true,
    showOnCompact: true,
    showOnQuestion: false,
    showSessionTokens: false,
    telemetry: { enabled: false },
    maintainerAnnouncements: { enabled: false, home: false },
    tuiCommandDisplay: "dialog",
    tuiSidebarPanel: {
      enabled: true,
      defaultExpanded: false,
      formatStyle: "singleWindow",
    },
    tuiCompactStatus: {
      enabled: true,
      homeBottom: true,
      sessionPrompt: true,
      maxWidth: 240,
      formatStyle: "singleWindow",
      suppressWhenNativeProviderQuota: false,
    },
  });
}

async function expectHandled(value: unknown): Promise<void> {
  try {
    await Promise.resolve(value);
  } catch (error) {
    expect(isCommandHandledError(error)).toBe(true);
    return;
  }
  throw new Error("Expected the handled command sentinel");
}

function expectNoProviderMisattribution(output: string): void {
  expect(output).toContain("Antigravity");
  expect(output).not.toContain("Google Antigravity");
  expect(output).not.toContain("[Claude]");
  expect(output).not.toMatch(/Anthropic|subscription/iu);
}

describe("Google Antigravity provider surfaces", () => {
  beforeEach(async () => {
    const config = createConfig();
    seedDefaultPluginBootstrapMocks(mocks, {
      configOverrides: config,
      resetPluginState: true,
    });
    provider = (await import("../src/providers/google-antigravity.js")).googleAntigravityProvider;
    mocks.loadConfig.mockResolvedValue(config);
    mocks.getProviders.mockReturnValue([provider]);
    mocks.queryGoogleQuota.mockResolvedValue({
      success: true,
      models: [
        {
          displayName: "Claude",
          accountEmail: "alice@example.com",
          percentRemaining: 0,
          resetTimeIso: "2026-08-01T00:00:00.000Z",
        },
        {
          displayName: "Claude",
          accountEmail: "bob@example.com",
          percentRemaining: 0,
          resetTimeIso: "2026-08-02T00:00:00.000Z",
        },
      ],
      errors: [],
    });

    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
  });

  afterEach(async () => {
    const { __resetQuotaStateForTests } = await import("../src/lib/quota-state.js");
    __resetQuotaStateForTests();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("keeps two Antigravity accounts distinct on real Web, toast, sidebar, and compact paths", async () => {
    const client = createPluginTestClient({
      modelID: "google/antigravity-claude",
      providerID: "google",
    });
    client.config.providers.mockResolvedValue({
      data: { providers: [{ id: "google" }] },
    });

    const { QuotaToastPlugin } = await import("../src/plugin.js");
    const hooks = (await QuotaToastPlugin({ client } as never)) as PluginHooks;

    await expectHandled(
      hooks["command.execute.before"]?.({
        command: "quota",
        sessionID: "antigravity-session",
      }),
    );
    const command = getPromptText(client);
    expectNoProviderMisattribution(command);
    expect(command).toContain("→ [Antigravity (ali…)]");
    expect(command).toContain("→ [Antigravity (bob…)]");
    expect(command.match(/Claude/g)).toHaveLength(2);

    await hooks.event?.({
      event: {
        type: "session.idle",
        properties: { sessionID: "antigravity-session" },
      },
    });
    const toast = getToastMessage(client);
    expectNoProviderMisattribution(toast);
    expect(toast).toContain("[Antigravity (ali…): Claude]");
    expect(toast).toContain("[Antigravity (bob…): Claude]");
    expect(toast).not.toMatch(/5h|7d|Weekly|Five-hour/u);

    const tuiApi = {
      state: {
        provider: [{ id: "google" }],
        path: { worktree: process.cwd(), directory: process.cwd() },
        session: { messages: () => [] },
      },
      client,
    } as never;
    const { loadTuiSessionQuotaSurfaces } = await import("../src/lib/tui-runtime.js");
    const surfaces = await loadTuiSessionQuotaSurfaces({
      api: tuiApi,
      sessionID: "antigravity-session",
    });

    expect(surfaces.sidebar.status).toBe("ready");
    const sidebar = [...surfaces.sidebar.lines, ...(surfaces.sidebar.linesExpanded ?? [])].join(
      "\n",
    );
    expectNoProviderMisattribution(sidebar);
    expect(sidebar).toContain("[Antigravity (ali…): Claude]");
    expect(sidebar).toContain("[Antigravity (bob…): Claude]");

    expect(surfaces.compact.status).toBe("ready");
    const compact = surfaces.compact.status === "ready" ? surfaces.compact.text : "";
    expectNoProviderMisattribution(compact);
    expect(compact).toBe("Antigravity (ali…): Claude 0% | Antigravity (bob…): Claude 0%");

    expect(mocks.queryGoogleQuota).toHaveBeenCalledTimes(1);
    await hooks.dispose?.();
  });
});
