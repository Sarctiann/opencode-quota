import type { Attributes, MeterProvider, ObservableResult } from "@opentelemetry/api";

import type { QuotaProviderResult } from "./entries.js";
import { isPercentEntry } from "./entries.js";
import { classifyQuotaWindowText } from "./quota-entry-display.js";
import { QUOTA_PROVIDERS_AGGREGATE_ID } from "./quota-providers.js";

const METER_NAME = "@slkiser/opencode-quota";
const CONSUMED_METRIC_NAME = "opencode.quota.consumed";
const CACHE_AGE_METRIC_NAME = "opencode.quota.cache.age";

interface QuotaTelemetryObservation {
  value: number;
  attributes: Attributes;
}

interface QuotaTelemetrySnapshot {
  timestamp: number;
  consumed: QuotaTelemetryObservation[];
}

const snapshots = new Map<string, QuotaTelemetrySnapshot>();
let initialization: Promise<void> | null = null;
let telemetryApi: typeof import("@opentelemetry/api") | null = null;
let registeredProvider: MeterProvider | null = null;
let enabled = false;
let generation = 0;

function isInternalAggregateProviderId(providerId: string): boolean {
  return providerId.startsWith(`${QUOTA_PROVIDERS_AGGREGATE_ID}:`);
}

function buildAttributes(
  providerId: string,
  entry: Extract<QuotaProviderResult["entries"][number], { percentRemaining: number }>,
): Attributes {
  return {
    "quota.provider": providerId,
    "quota.result_type": entry.accounting.resultType,
    "quota.window":
      classifyQuotaWindowText(entry.label ?? "") ??
      classifyQuotaWindowText(entry.name) ??
      "unspecified",
    "quota.acquisition_method": entry.accounting.acquisitionMethod,
    "quota.ownership": entry.accounting.ownership,
    "quota.authority": entry.accounting.authority,
  };
}

function observationKey(attributes: Attributes): string {
  return [
    attributes["quota.provider"],
    attributes["quota.result_type"],
    attributes["quota.window"],
    attributes["quota.acquisition_method"],
    attributes["quota.ownership"],
    attributes["quota.authority"],
  ].join("\u0000");
}

function observeConsumed(result: ObservableResult): void {
  try {
    for (const snapshot of snapshots.values()) {
      for (const observation of snapshot.consumed) {
        result.observe(observation.value, observation.attributes);
      }
    }
  } catch {
    // Telemetry callbacks must never affect the host or quota collection.
  }
}

function observeCacheAge(result: ObservableResult): void {
  try {
    const now = Date.now();
    for (const snapshot of snapshots.values()) {
      const ageSeconds = Math.max(0, now - snapshot.timestamp) / 1000;
      for (const observation of snapshot.consumed) {
        result.observe(ageSeconds, observation.attributes);
      }
    }
  } catch {
    // Telemetry callbacks must never affect the host or quota collection.
  }
}

function registerCurrentMeterProvider(): void {
  if (!telemetryApi) return;

  const provider = telemetryApi.metrics.getMeterProvider();
  if (provider === registeredProvider) return;

  const meter = provider.getMeter(METER_NAME);
  meter
    .createObservableGauge(CONSUMED_METRIC_NAME, {
      description: "Normalized quota consumed, where 1 is 100% consumed",
      unit: "1",
    })
    .addCallback(observeConsumed);
  meter
    .createObservableGauge(CACHE_AGE_METRIC_NAME, {
      description: "Age of the normalized cached quota observation",
      unit: "s",
    })
    .addCallback(observeCacheAge);
  registeredProvider = provider;
}

function initializeTelemetry(): void {
  if (telemetryApi) {
    registerCurrentMeterProvider();
    return;
  }
  if (initialization) return;

  initialization = import("@opentelemetry/api")
    .then((api) => {
      telemetryApi = api;
      registerCurrentMeterProvider();
    })
    .catch(() => undefined);
}

export function configureQuotaTelemetry(nextEnabled: boolean): number {
  try {
    if (enabled !== nextEnabled) {
      enabled = nextEnabled;
      generation += 1;
    }

    if (!enabled) {
      snapshots.clear();
      return generation;
    }

    initializeTelemetry();
  } catch {
    // OpenTelemetry is optional and must not affect normal plugin behavior.
  }
  return generation;
}

export function updateQuotaTelemetrySnapshot(params: {
  enabled: boolean;
  generation?: number;
  providerId: string;
  timestamp: number;
  result: QuotaProviderResult | null;
}): void {
  try {
    if (params.generation !== undefined && params.generation !== generation) return;

    if (!enabled || !params.enabled || isInternalAggregateProviderId(params.providerId)) {
      snapshots.delete(params.providerId);
      return;
    }

    initializeTelemetry();

    if (!params.result || !params.result.attempted || params.result.entries.length === 0) {
      snapshots.delete(params.providerId);
      return;
    }

    const consumedByAttributes = new Map<string, QuotaTelemetryObservation>();
    for (const entry of params.result.entries) {
      if (!isPercentEntry(entry)) continue;

      const attributes = buildAttributes(params.providerId, entry);
      const value = Math.max(0, (100 - entry.percentRemaining) / 100);
      const key = observationKey(attributes);
      const existing = consumedByAttributes.get(key);
      if (!existing || value > existing.value) {
        consumedByAttributes.set(key, { value, attributes });
      }
    }

    if (consumedByAttributes.size === 0) {
      snapshots.delete(params.providerId);
      return;
    }

    snapshots.set(params.providerId, {
      timestamp: params.timestamp,
      consumed: [...consumedByAttributes.values()],
    });
  } catch {
    // Snapshot publication is deliberately best-effort and synchronous.
  }
}

export function retainQuotaTelemetryProviders(providerIds: readonly string[]): void {
  try {
    if (!enabled) return;

    const retained = new Set(providerIds);
    for (const providerId of snapshots.keys()) {
      if (!retained.has(providerId)) snapshots.delete(providerId);
    }
  } catch {
    // Reconciliation is best-effort and must not affect provider selection.
  }
}

export async function __flushQuotaTelemetryInitializationForTests(): Promise<void> {
  await initialization;
}

export function __resetQuotaTelemetryForTests(): void {
  snapshots.clear();
  initialization = null;
  telemetryApi = null;
  registeredProvider = null;
  enabled = false;
  generation = 0;
}
