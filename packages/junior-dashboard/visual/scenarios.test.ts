import { describe, expect, it } from "vitest";
import {
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

  it("ignores e2e and test-only dashboard paths", () => {
    expect(
      selectVisualScenarioIds([
        "packages/junior-dashboard/e2e/conversations.spec.ts",
        "packages/junior-dashboard/tests/dashboard-routes.test.ts",
        "packages/junior/src/app.ts",
      ]),
    ).toEqual([]);
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
});
