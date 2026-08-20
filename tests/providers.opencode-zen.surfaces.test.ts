import { describe, expect, it } from "vitest";
import { formatQuotaRows } from "../src/lib/format.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const accounting = {
  resultType: "budget",
  acquisitionMethod: "dashboard_scrape",
  ownership: "maintained",
  authority: "locally_derived",
} as const;

const defaultData: QuotaRenderData = {
  entries: [
    {
      accounting,
      name: "",
      group: "OpenCode Zen",
      percentRemaining: 42.5,
    },
  ],
  errors: [],
};

const detailedData: QuotaRenderData = {
  entries: [
    {
      accounting,
      name: "",
      group: "OpenCode Zen",
      right: "Limit $100.00  Auto $20/5",
      barValue: "¤ $42.50",
      percentRemaining: 94.25,
    },
  ],
  errors: [],
};

function renderFourSurfaces(data: QuotaRenderData) {
  return {
    command: formatQuotaCommand({ ...data, generatedAtMs: 0 }),
    toast: formatQuotaRows({
      version: "test",
      style: "singleWindow",
      entries: data.entries,
      errors: data.errors,
      percentDisplayMode: "remaining",
    }),
    sidebar: buildSidebarQuotaPanelLines({
      data,
      config: { formatStyle: "singleWindow", percentDisplayMode: "remaining" },
    }).join("\n"),
    compact: buildCompactQuotaStatusLine({
      data,
      percentDisplayMode: "remaining",
      maxWidth: 200,
    }),
  };
}

describe("OpenCode Zen four-surface formatting", () => {
  it("preserves the default monthly-budget percentage", () => {
    for (const output of Object.values(renderFourSurfaces(defaultData))) {
      expect(output).toContain("43%");
      expect(output).toContain("OpenCode Zen");
    }
  });

  it("shows detailed Zen values deliberately on every surface", () => {
    const outputs = renderFourSurfaces(detailedData);

    for (const output of [outputs.command, outputs.toast]) {
      expect(output).toContain("Limit $100.00");
      expect(output).toContain("Auto $20/5");
      expect(output).toContain("¤ $42.50");
      expect(output).not.toContain("94%");
    }

    expect(outputs.sidebar).toContain("OpenCode Zen");
    expect(outputs.sidebar).toContain("¤ $42.50");
    expect(outputs.sidebar).not.toContain("94%");

    expect(outputs.compact).toContain("OpenCode Zen");
    expect(outputs.compact).toContain("¤ $42.50");
    expect(outputs.compact).not.toContain("94%");
  });
});
