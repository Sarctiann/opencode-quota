import { describe, expect, it } from "vitest";

import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const resetTimeIso = "2099-02-01T00:00:00.000Z";
const data: QuotaRenderData = {
  entries: [
    {
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "locally_derived",
      },
      name: "Kilo Gateway Credits",
      group: "Kilo Gateway",
      label: "Credits:",
      right: "$2.50/$15.00 used",
      percentRemaining: 83.33333333333334,
      resetTimeIso,
    },
    {
      kind: "value",
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "locally_derived",
      },
      name: "Kilo Gateway Remaining Credits",
      group: "Kilo Gateway",
      label: "Credits:",
      value: "Used: $2.50 · Remaining: $12.50 ($5.00 bonus)",
      resetTimeIso,
    },
  ],
  errors: [],
};

describe("Kilo Gateway four-surface formatting", () => {
  it("shows Kilo Pass quota, usage, remaining credits, bonus, and reset data", () => {
    const web = formatQuotaCommand({ ...data, generatedAtMs: 0 });
    const toast = formatQuotaRowsGrouped(data);
    const sidebar = buildSidebarQuotaPanelLines({
      data,
      config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
    }).join("\n");
    const compact = buildCompactQuotaStatusLine({
      data,
      percentDisplayMode: "remaining",
      maxWidth: 240,
    });

    for (const output of [web, toast, sidebar, compact]) {
      expect(output).toContain("Kilo Gateway");
      expect(output).toContain("83%");
      expect(output).toContain("$2.50");
      expect(output).toContain("$12.50");
    }

    for (const output of [web, compact]) {
      expect(output).toContain("$5.00 bonus");
    }
    expect(web.toLowerCase()).toContain("reset");
    expect(toast).toMatch(/\d+d/u);
  });
});
