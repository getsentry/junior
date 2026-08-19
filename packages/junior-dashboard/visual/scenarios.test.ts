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
    ).toEqual(["conversations", "conversation-detail"]);
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

  it("selects the component gallery for shared component changes", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/src/client/components/Button.tsx",
      ]),
    ).toEqual(["component-gallery"]);
  });

  it("selects a capped shell set for shared layout changes", () => {
    const selected = selectVisualScenarioIds([
      "packages/junior-dashboard/src/tailwind.css",
    ]);
    expect(selected).toEqual([
      "conversations",
      "conversation-detail",
      "system",
      "component-gallery",
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
      "conversation-detail",
      "system",
      "component-gallery",
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
      "system",
      "memories",
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

  it("defines both attachment visual states", () => {
    expect(
      resolveVisualScenarios([
        "conversation-attachment",
        "conversation-attachment-modal",
      ]).map((scenario) => scenario.state),
    ).toEqual(["attachment-entry", "attachment-modal"]);
  });
});
