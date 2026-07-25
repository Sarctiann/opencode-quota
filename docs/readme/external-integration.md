[← Back to README](../../README.md)

# External integration

Use this page when a script, status bar, or CI job needs quota data.

Choose one source:

| Source                       | Best for                                                |
| ---------------------------- | ------------------------------------------------------- |
| `opencode-quota show --json` | Reading the latest cached data from a command           |
| Export file                  | Reading the same data often without running a command   |
| OpenTelemetry metrics        | Monitoring quota consumption and freshness in a backend |

All three reuse normalized quota data already collected by OpenCode Quota. They do not add provider requests.

## JSON export v2

Both sources return schema `version: 2`.

Each provider has a status and a list of quota rows. A row says what it measures, whether it is a percentage or value, and where the data came from. `status: "partial"` means some rows worked and some failed.

A row from a configured `quotaProviders` definition includes `sourceId`. `providers["quota-providers"]` also includes a `sources` list so another tool can match results to definitions.

Secrets, URLs, checked paths, and raw provider responses remain excluded from public JSON. Use `/quota_status` for live checks. The command and export file only read cached data.

## Option 1: print JSON now

```bash
opencode-quota show --json
```

Common variants:

```bash
# One provider only
opencode-quota show --json --provider copilot

# Fail if comparable cached quota is below 5%
opencode-quota show --json --threshold 5
```

Threshold exits:

| Exit | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `0`  | Quota is available and above the threshold                     |
| `1`  | At least one comparable cached provider is below the threshold |
| `2`  | Results were incomplete or no cached percentage was comparable |

## Option 2: write an export file

Use this when a status bar or background tool reads quota often.

Add this to `opencode-quota/quota-toast.json`:

```jsonc
{
  "export": {
    "enabled": true,
  },
}
```

Default output path:

```text
$XDG_CACHE_HOME/opencode/quota-export.json
```

Usually that means:

```text
~/.cache/opencode/quota-export.json
```

The TUI updates this file after each home-bottom background refresh, about every 60 seconds. Write errors are logged as warnings and never break TUI rendering.

## Option 3: publish OpenTelemetry metrics

Use this when the OpenCode host already configures an OpenTelemetry SDK and exporter. OpenCode Quota reuses the global `MeterProvider`; it does not install an SDK, configure OTLP, own an exporter, or add a refresh timer.

Add this to `opencode-quota/quota-toast.json`:

```jsonc
{
  "telemetry": {
    "enabled": true,
  },
}
```

Telemetry is disabled by default. The host must make `@opentelemetry/api` available and register its global `MeterProvider`. If the API or a provider is unavailable, OpenCode Quota continues normally and emits no metrics.

OpenCode Quota publishes observable gauges from the latest normalized cache snapshot:

| Metric                     | Unit | Meaning                                                                                                       |
| -------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| `opencode.quota.consumed`  | `1`  | Consumed ratio derived from `percentRemaining`: `(100 - percentRemaining) / 100`, with a lower bound of zero. |
| `opencode.quota.cache.age` | `s`  | Seconds since that normalized provider snapshot was fetched; the timestamp is preserved across cache hits.    |

`opencode.quota.consumed` is `0` when unused and `1` at 100% consumed. It can exceed `1` when a provider reports quota below zero. Human-readable value rows such as balances are not converted into metrics.

Both gauges use the same bounded attributes:

- `quota.provider`
- `quota.result_type`
- `quota.window`
- `quota.acquisition_method`
- `quota.ownership`
- `quota.authority`

Raw row labels are reduced to a bounded window classification such as `five_hour`, `day`, `week`, or `month`; unclassified rows use `unspecified`. Display names, account identifiers, configured source IDs, credentials, URLs, paths, models, errors, and raw provider responses are never metric attributes. When multiple rows have identical safe attributes, the gauge reports the highest consumed ratio.

Metric callbacks only read in-memory snapshots. They never contact a provider or read the cache, and telemetry failures never affect collection, commands, exports, or UI behavior.

## Copy-paste examples

### CI: stop when quota is low

```bash
npx @slkiser/opencode-quota show --json --threshold 5
```

### Shell: branch on Copilot only when a real percentage exists

Copilot Free, Student, organization, and enterprise usage can be value-only. Select a percentage row instead of assuming the first row has one:

```bash
PCT=$(opencode-quota show --json --provider copilot \
  | jq -r '.providers.copilot.entries | map(select(.renderType == "percent" and .percentRemaining != null)) | first | .percentRemaining // empty')

if [ -n "$PCT" ] && [ "${PCT%.*}" -lt 10 ]; then
  echo "Low Copilot allowance or budget; skipping."
  exit 0
fi
```

### tmux: read the export file

```bash
set -g status-interval 30
set -g status-right '#(jq -r "[.providers|to_entries[]|select(.value.status==\"ok\")|first(.value.entries[]?|select(.renderType==\"percent\" and .percentRemaining!=null))|(.percentRemaining|floor|tostring)+\"%\"]|join(\" · \")" ~/.cache/opencode/quota-export.json 2>/dev/null)'
```

### Starship: run the JSON command

```toml
[custom.quota]
command = "opencode-quota show --json 2>/dev/null | jq -r '[.providers|to_entries[]|select(.value.status==\"ok\")|first(.value.entries[]?|select(.renderType==\"percent\" and .percentRemaining!=null))|(.percentRemaining|floor|tostring)+\"%\"]|join(\" \")'"
when = "true"
interval = 60
```

<details>
<summary><strong>JSON shape</strong></summary>

Both `show --json` and the export file use this v2 structure:

```jsonc
{
  "version": 2,
  "exportedAt": 1748736000,
  "fromCache": true,
  "cacheAgeSeconds": 42,
  "providers": {
    "copilot": {
      "status": "ok",
      "fetchedAt": 1748735958,
      "entries": [
        {
          "name": "Premium Requests",
          "resultType": "quota",
          "acquisitionMethod": "remote_api",
          "ownership": "maintained",
          "authority": "provider_reported",
          "window": "Monthly",
          "resetAt": 1748908800,
          "renderType": "percent",
          "percentRemaining": 62.3,
        },
      ],
    },
    "quota-providers": {
      "status": "partial",
      "fetchedAt": 1748735958,
      "entries": [
        {
          "name": "OpenRouter Primary budget",
          "resultType": "budget",
          "acquisitionMethod": "remote_api",
          "ownership": "user_configured",
          "authority": "provider_reported",
          "sourceId": "openrouter-primary",
          "renderType": "percent",
          "percentRemaining": 40,
        },
      ],
      "errors": [
        {
          "label": "Internal accounting",
          "message": "HTTP 503",
        },
      ],
      "sources": [
        {
          "id": "openrouter-primary",
          "providerId": "openrouter",
          "status": "ok",
          "entryCount": 1,
        },
        {
          "id": "internal-accounting",
          "providerId": "internal_gateway",
          "status": "error",
          "entryCount": 0,
        },
        {
          "id": "model-specific",
          "providerId": "internal_gateway",
          "status": "unavailable",
          "entryCount": 0,
        },
      ],
    },
    "opencode-go": {
      "status": "error",
      "fetchedAt": 1748735958,
      "error": "Request timeout after 5s",
    },
    "anthropic": {
      "status": "unavailable",
    },
  },
}
```

Provider and quota-provider definition statuses:

| Value         | Meaning                                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`          | Provider: cached rows exist with no provider errors. Definition summary: its request succeeded and produced rows; failed mapping candidates can still make the aggregate provider `partial`. |
| `partial`     | Cached rows and sanitized errors both exist. Consumers may display the rows, but threshold and routing decisions should treat the result as incomplete.                                      |
| `error`       | The cached provider or definition failed and has no successful row. Provider-level errors include a sanitized message; definition summaries do not expose detailed outcomes.                 |
| `unavailable` | No matching cached data exists. For a quota-provider definition this also covers an exact runtime `providerId` that was unavailable when the aggregate cache was written.                    |

Entry fields:

- `renderType: "percent"` uses `percentRemaining`; `renderType: "value"` uses `value`.
- `resultType` is one of `quota`, `rate_limit`, `usage`, `spend`, `budget`, `balance`, or `status`.
- `window`, `resetAt`, and `observedAt` appear only when provider accounting data supplies them.
- `sourceId` is the stable `quotaProviders` definition id stamped onto rows from the `quota-providers` aggregate; it is identity, not a display label.
- `sources` preserves `quotaProviders` definition order. Each summary is exactly `id`, effective `providerId`, coarse `status`, and `entryCount`; the count is the cached normalized row count for that definition, and duplicate labels remain separate by stable `id`. A `json-v1` source can be `ok` after producing valid rows while its rejected mapping candidates make the aggregate provider `partial`.

</details>

<details>
<summary><strong>More integration ideas</strong></summary>

### File watcher: refresh only when the export changes

```bash
# macOS
fswatch -o ~/.cache/opencode/quota-export.json | xargs -I{} my-status-refresh

# Linux
inotifywait -m -e close_write ~/.cache/opencode/quota-export.json \
  | while read; do my-status-refresh; done
```

### Router: pick the provider with the most headroom

```python
import json, subprocess

data = json.loads(subprocess.check_output(
    ["opencode-quota", "show", "--json"], timeout=1
))
best = max(
    (k for k, v in data["providers"].items() if v["status"] == "ok"),
    key=lambda k: next(
        (e["percentRemaining"] for e in data["providers"][k]["entries"]
         if e["renderType"] == "percent" and e.get("percentRemaining") is not None), 0
    ),
    default=None,
)
```

</details>
