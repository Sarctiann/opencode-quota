import { beforeEach, describe, expect, it, vi } from "vitest";

const otel = vi.hoisted(() => {
  const callbacks = new Map<
    string,
    (result: { observe: (value: number, attributes?: Record<string, unknown>) => void }) => void
  >();
  const instruments: Array<{ name: string; options: Record<string, unknown> }> = [];
  const meter = {
    createObservableGauge: vi.fn((name: string, options: Record<string, unknown>) => {
      instruments.push({ name, options });
      return {
        addCallback: (
          callback: (result: {
            observe: (value: number, attributes?: Record<string, unknown>) => void;
          }) => void,
        ) => callbacks.set(name, callback),
      };
    }),
  };
  const getMeter = vi.fn(() => meter);
  const capturingProvider = { getMeter };
  const currentProvider: { value: { getMeter: (...args: any[]) => any } } = {
    value: capturingProvider,
  };
  const getMeterProvider = vi.fn(() => currentProvider.value);

  return {
    callbacks,
    capturingProvider,
    currentProvider,
    getMeter,
    getMeterProvider,
    instruments,
  };
});

vi.mock("@opentelemetry/api", () => ({
  metrics: { getMeterProvider: otel.getMeterProvider },
}));

const ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function collect(name: string) {
  const observations: Array<{ value: number; attributes?: Record<string, unknown> }> = [];
  otel.callbacks.get(name)?.({
    observe: (value, attributes) => observations.push({ value, attributes }),
  });
  return observations;
}

describe("quota telemetry", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
    otel.callbacks.clear();
    otel.instruments.length = 0;
    otel.currentProvider.value = otel.capturingProvider;
  });

  it("does not initialize OpenTelemetry while disabled", async () => {
    const telemetry = await import("../src/lib/quota-telemetry.js");

    telemetry.configureQuotaTelemetry(false);
    telemetry.updateQuotaTelemetrySnapshot({
      enabled: false,
      providerId: "synthetic",
      timestamp: Date.now(),
      result: {
        attempted: true,
        entries: [{ accounting: ACCOUNTING, name: "Synthetic", percentRemaining: 50 }],
        errors: [],
      },
    });
    await telemetry.__flushQuotaTelemetryInitializationForTests();

    expect(otel.getMeter).not.toHaveBeenCalled();
    expect(otel.callbacks.size).toBe(0);
  });

  it("publishes normalized consumption and cache age with bounded attributes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:42.000Z"));
    const telemetry = await import("../src/lib/quota-telemetry.js");
    telemetry.configureQuotaTelemetry(true);

    telemetry.updateQuotaTelemetrySnapshot({
      enabled: true,
      providerId: "openai",
      timestamp: Date.parse("2026-07-25T12:00:00.000Z"),
      result: {
        attempted: true,
        entries: [
          {
            accounting: {
              ...ACCOUNTING,
              sourceId: "account@example.com",
              observedAtIso: "2026-07-25T11:59:00.000Z",
            },
            name: "OpenAI (account@example.com)",
            label: "5h:",
            percentRemaining: 25,
          },
          {
            accounting: ACCOUNTING,
            name: "OpenAI (another@example.com)",
            label: "5 hour:",
            percentRemaining: 10,
          },
          {
            accounting: { ...ACCOUNTING, resultType: "rate_limit" },
            name: "OpenAI Weekly https://sensitive.example",
            percentRemaining: -20,
          },
          {
            accounting: { ...ACCOUNTING, resultType: "balance" },
            kind: "value",
            name: "Balance",
            value: "$42.00",
          },
        ],
        errors: [{ label: "OpenAI", message: "token secret" }],
      },
    });
    await telemetry.__flushQuotaTelemetryInitializationForTests();

    expect(otel.getMeter).toHaveBeenCalledOnce();
    expect(otel.instruments).toEqual([
      {
        name: "opencode.quota.consumed",
        options: {
          description: "Normalized quota consumed, where 1 is 100% consumed",
          unit: "1",
        },
      },
      {
        name: "opencode.quota.cache.age",
        options: {
          description: "Age of the normalized cached quota observation",
          unit: "s",
        },
      },
    ]);

    const consumed = collect("opencode.quota.consumed");
    expect(consumed).toHaveLength(2);
    expect(consumed.map(({ value }) => value).sort()).toEqual([0.9, 1.2]);
    expect(consumed[0]?.attributes).toEqual({
      "quota.provider": "openai",
      "quota.result_type": "quota",
      "quota.window": "five_hour",
      "quota.acquisition_method": "remote_api",
      "quota.ownership": "maintained",
      "quota.authority": "provider_reported",
    });
    expect(JSON.stringify(consumed)).not.toMatch(
      /account@example\.com|another@example\.com|sensitive\.example|token secret|\$42/,
    );

    const ages = collect("opencode.quota.cache.age");
    expect(ages).toHaveLength(2);
    expect(ages.every(({ value }) => value === 42)).toBe(true);
  });

  it("replaces stale windows, clears on disable, and ignores internal aggregate sources", async () => {
    const telemetry = await import("../src/lib/quota-telemetry.js");
    telemetry.configureQuotaTelemetry(true);
    const result = {
      attempted: true,
      entries: [
        { accounting: ACCOUNTING, name: "Synthetic Daily", percentRemaining: 50 },
        { accounting: ACCOUNTING, name: "Synthetic Weekly", percentRemaining: 25 },
      ],
      errors: [],
    } as const;

    telemetry.updateQuotaTelemetrySnapshot({
      enabled: true,
      providerId: "quota-providers:private-source-id",
      timestamp: Date.now(),
      result,
    });
    telemetry.updateQuotaTelemetrySnapshot({
      enabled: true,
      providerId: "synthetic",
      timestamp: Date.now(),
      result,
    });
    await telemetry.__flushQuotaTelemetryInitializationForTests();
    expect(collect("opencode.quota.consumed")).toHaveLength(2);

    telemetry.updateQuotaTelemetrySnapshot({
      enabled: true,
      providerId: "synthetic",
      timestamp: Date.now(),
      result: {
        attempted: true,
        entries: [result.entries[0]],
        errors: [],
      },
    });
    expect(collect("opencode.quota.consumed")).toHaveLength(1);

    telemetry.configureQuotaTelemetry(false);
    expect(collect("opencode.quota.consumed")).toEqual([]);
  });

  it("isolates observer failures from callers", async () => {
    const telemetry = await import("../src/lib/quota-telemetry.js");
    telemetry.configureQuotaTelemetry(true);
    telemetry.updateQuotaTelemetrySnapshot({
      enabled: true,
      providerId: "synthetic",
      timestamp: Date.now(),
      result: {
        attempted: true,
        entries: [{ accounting: ACCOUNTING, name: "Synthetic", percentRemaining: 50 }],
        errors: [],
      },
    });
    await telemetry.__flushQuotaTelemetryInitializationForTests();

    expect(() =>
      otel.callbacks.get("opencode.quota.consumed")?.({
        observe: () => {
          throw new Error("collector failed");
        },
      }),
    ).not.toThrow();
  });

  it("registers instruments when the global MeterProvider changes", async () => {
    const noopProvider = {
      getMeter: vi.fn(() => ({
        createObservableGauge: vi.fn(() => ({ addCallback: vi.fn() })),
      })),
    };
    otel.currentProvider.value = noopProvider;
    const telemetry = await import("../src/lib/quota-telemetry.js");

    telemetry.configureQuotaTelemetry(true);
    await telemetry.__flushQuotaTelemetryInitializationForTests();
    expect(otel.callbacks.size).toBe(0);

    otel.currentProvider.value = otel.capturingProvider;
    telemetry.updateQuotaTelemetrySnapshot({
      enabled: true,
      providerId: "synthetic",
      timestamp: Date.now(),
      result: {
        attempted: true,
        entries: [{ accounting: ACCOUNTING, name: "Synthetic", percentRemaining: 50 }],
        errors: [],
      },
    });

    expect(otel.callbacks.has("opencode.quota.consumed")).toBe(true);
    expect(otel.callbacks.has("opencode.quota.cache.age")).toBe(true);
  });

  it("rejects snapshots from an obsolete telemetry configuration", async () => {
    const telemetry = await import("../src/lib/quota-telemetry.js");
    const oldGeneration = telemetry.configureQuotaTelemetry(true);
    await telemetry.__flushQuotaTelemetryInitializationForTests();
    telemetry.configureQuotaTelemetry(false);
    telemetry.configureQuotaTelemetry(true);

    telemetry.updateQuotaTelemetrySnapshot({
      enabled: true,
      generation: oldGeneration,
      providerId: "synthetic",
      timestamp: Date.now(),
      result: {
        attempted: true,
        entries: [{ accounting: ACCOUNTING, name: "Synthetic", percentRemaining: 50 }],
        errors: [],
      },
    });

    expect(collect("opencode.quota.consumed")).toEqual([]);
  });
});
