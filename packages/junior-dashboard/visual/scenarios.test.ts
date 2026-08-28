import { describe, expect, it } from "vitest";
import {
  allVisualScenarioIds,
  MAX_VISUAL_SCENARIOS,
  resolveVisualScenarios,
  selectVisualScenarioIds,
  VISUAL_SCENARIOS,
} from "./scenarios";

describe("selectVisualScenarioIds", () => {
  it("selects conversation surfaces for conversation file changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/conversations/ConversationPage.tsx",
      ]),
    ).toEqual([
      "conversations",
      "conversation-detail",
      "conversation-detail-focused",
      "conversation-create-focused",
    ]);
  });

  it("selects attachment entry and modal states for attachment changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/components/ImageAttachment.tsx",
        "packages/junior-dashboard/src/client/conversations/TranscriptAttachmentsDeliveredView.tsx",
      ]),
    ).toEqual([
      "conversation-attachment",
      "conversation-attachment-modal",
    ]);
  });

  it("selects the person profile for people page changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/pages/people/PersonProfilePage.tsx",
      ]),
    ).toEqual(["person-profile"]);
  });

  it("selects the code page for code page changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/pages/code/CodePage.tsx",
      ]),
    ).toEqual(["code"]);
  });

  it("selects focused gallery pages for shared component changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/components/Button.tsx",
      ]),
    ).toEqual(["gallery-foundations", "gallery-index"]);
  });

  it("selects the charts gallery for chart component changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/components/charts/ActivityChart.tsx",
      ]),
    ).toEqual(["gallery-charts"]);
  });

  it("selects the charts gallery for feature chart fixtures under people/system", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/pages/people/ContributionGrid.tsx",
      ]),
    ).toEqual(["gallery-charts"]);
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/pages/system/ConversationActivityChart.tsx",
      ]),
    ).toEqual(["gallery-charts"]);
  });

  it("selects every gallery page for catalog source changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/pages/dev/ComponentsPage.tsx",
      ]),
    ).toEqual([
      "gallery-foundations",
      "gallery-charts",
      "gallery-transcripts",
      "gallery-index",
    ]);
  });

  it("selects the transcripts gallery for transcript fixture components", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/conversations/TranscriptMarkdown.tsx",
      ]),
    ).toEqual(["gallery-transcripts"]);
  });

  it("keeps focused gallery pages under the cap when feature pages also match", () => {
    const selected = selectVisualScenarioIds([
      "packages/junior-dashboard/src/client/components/Field.tsx",
      "packages/junior-dashboard/src/client/pages/memory/MemoryPage.tsx",
      "packages/junior-dashboard/src/client/pages/SettingsPage.tsx",
      "packages/junior-dashboard/src/client/pages/system/WorkspaceEditor.tsx",
      "packages/junior-dashboard/src/client/pages/system/WorkspacesPage.tsx",
    ]);
    expect(selected[0]).toBe("gallery-foundations");
    expect(selected).toHaveLength(MAX_VISUAL_SCENARIOS);
    expect(selected).toEqual(
      expect.arrayContaining([
        "gallery-foundations",
        "gallery-index",
        "workspaces",
        "workspace-detail",
      ]),
    );
  });

  it("selects a capped shell set for shared layout changes", () => {
    const selected = selectVisualScenarioIds([
      "packages/junior-dashboard/src/tailwind.css",
    ]);
    expect(selected).toEqual([
      "conversations",
      "conversation-detail-focused",
      "conversation-create-focused",
      "system",
    ]);
    expect(selected).toHaveLength(MAX_VISUAL_SCENARIOS);
  });

  it("selects the shell set for layout component changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/components/layout/DashboardHeader.tsx",
      ]),
    ).toEqual([
      "conversations",
      "conversation-detail-focused",
      "conversation-create-focused",
      "system",
    ]);
  });

  it("ignores e2e and test-only dashboard paths", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/e2e/conversations.spec.ts",
        "packages/junior-dashboard/tests/dashboard-routes.test.ts",
        "packages/junior/src/app.ts",
      ]),
    ).toEqual([]);
  });

  it("selects workspaces for Workspace page changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/pages/system/WorkspacesPage.tsx",
        "packages/junior-dashboard/src/client/pages/system/BaselineSnapshotCard.tsx",
        "packages/junior-dashboard/src/client/pages/system/SnapshotSummary.tsx",
        "packages/junior-dashboard/src/client/pages/system/workspaceDraft.ts",
      ]),
    ).toEqual(["workspaces", "workspace-detail"]);
  });

  it("keeps generic system pages on the system scenario", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/pages/system/SystemPage.tsx",
      ]),
    ).toEqual(["system"]);
  });

  it("keeps registry order and dedupes across multiple files", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/pages/system/SystemPage.tsx",
        "packages/junior-dashboard/src/client/pages/memory/MemoryPage.tsx",
        "packages/junior-dashboard/src/client/conversations/ConversationHeader.tsx",
      ]),
    ).toEqual([
      "conversations",
      "conversation-detail",
      "conversation-detail-focused",
      "conversation-create-focused",
    ]);
  });

  it("returns the full registry when all is forced", () => {
    expect(selectVisualScenarioIds([], { all: true })).toEqual(
      allVisualScenarioIds(),
    );
    expect(allVisualScenarioIds().length).toBeGreaterThan(MAX_VISUAL_SCENARIOS);
  });
});

describe("resolveVisualScenarios", () => {
  it("returns scenario records for known ids", () => {
    expect(resolveVisualScenarios(["settings"]).map((s) => s.id)).toEqual([
      "settings",
    ]);
    expect(resolveVisualScenarios(["settings"])[0]?.path).toBe("/settings");
  });

  it("rejects unknown ids", () => {
    expect(() => resolveVisualScenarios(["nope"])).toThrow(
      /Unknown visual scenario/,
    );
  });

  it("keeps every registered scenario unique", () => {
    const ids = VISUAL_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("registers both attachment visual states", () => {
    expect(
      resolveVisualScenarios([
        "conversation-attachment",
        "conversation-attachment-modal",
      ]).map((scenario) => scenario.prepare),
    ).toEqual(["attachment-entry", "attachment-modal"]);
  });

  it("registers the landing create compose as desktop and mobile evidence", () => {
    const scenario = resolveVisualScenarios(["conversation-create-focused"])[0];
    expect(scenario?.prepare).toBe("new-conversation-focused");
    expect(scenario?.viewports.map((viewport) => viewport.name)).toEqual([
      "desktop",
      "mobile",
    ]);
  });

  it("registers the focused reply composer as mobile-only evidence", () => {
    const scenario = resolveVisualScenarios(["conversation-detail-focused"])[0];
    expect(scenario?.prepare).toBe("conversation-detail-focused");
    expect(scenario?.viewports.map((viewport) => viewport.name)).toEqual([
      "mobile",
    ]);
  });

  it("registers one gallery scenario per category page", () => {
    expect(
      resolveVisualScenarios(["gallery-foundations", "gallery-charts", "gallery-transcripts"]).map(
        (scenario) => scenario.path,
      ),
    ).toEqual(["/dev/foundations", "/dev/charts", "/dev/transcripts"]);
  });
});
