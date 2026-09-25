import { describe, expect, it } from "vitest";
import {
  trailingUtcDates,
  workspaceUsageDays,
} from "../src/client/components/charts/workspaceUsage";

describe("workspaceUsageDays", () => {
  it("fills trailing UTC days and keeps one Workspace name", () => {
    const nowMs = Date.parse("2026-07-28T12:00:00.000Z");
    expect(trailingUtcDates(7, nowMs)).toEqual([
      "2026-07-22",
      "2026-07-23",
      "2026-07-24",
      "2026-07-25",
      "2026-07-26",
      "2026-07-27",
      "2026-07-28",
    ]);
    expect(
      workspaceUsageDays({
        workspaceId: "workspace-1",
        nowMs,
        range: 7,
        stats: [
          {
            count: 2,
            date: "2026-07-27",
            metric: "workspace_switch",
            name: "workspace-1",
            namespace: "junior",
          },
          {
            count: 9,
            date: "2026-07-27",
            metric: "workspace_switch",
            name: "workspace-2",
            namespace: "junior",
          },
          {
            count: 1,
            date: "2026-07-28",
            metric: "skill_load",
            name: "sentry",
            namespace: "junior",
          },
          {
            count: 4,
            date: "2026-07-28",
            metric: "workspace_switch",
            name: "workspace-1",
            namespace: "junior",
          },
        ],
      }),
    ).toEqual([
      { count: 0, date: "2026-07-22" },
      { count: 0, date: "2026-07-23" },
      { count: 0, date: "2026-07-24" },
      { count: 0, date: "2026-07-25" },
      { count: 0, date: "2026-07-26" },
      { count: 2, date: "2026-07-27" },
      { count: 4, date: "2026-07-28" },
    ]);
  });
});
