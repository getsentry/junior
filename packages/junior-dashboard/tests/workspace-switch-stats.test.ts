import { describe, expect, it } from "vitest";
import {
  trailingUtcDates,
  workspaceSwitchDays,
} from "../src/client/pages/system/workspaceSwitchStats";

describe("workspaceSwitchDays", () => {
  it("fills trailing UTC days and keeps one Workspace name", () => {
    const nowMs = Date.parse("2026-07-28T12:00:00.000Z");
    expect(trailingUtcDates(3, nowMs)).toEqual([
      "2026-07-26",
      "2026-07-27",
      "2026-07-28",
    ]);
    expect(
      workspaceSwitchDays({
        name: "sentry",
        nowMs,
        range: 3,
        stats: [
          {
            count: 2,
            date: "2026-07-27",
            metric: "workspace_switch",
            name: "sentry",
            namespace: "junior",
          },
          {
            count: 9,
            date: "2026-07-27",
            metric: "workspace_switch",
            name: "snuba",
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
            name: "sentry",
            namespace: "junior",
          },
        ],
      }),
    ).toEqual([
      { count: 0, date: "2026-07-26" },
      { count: 2, date: "2026-07-27" },
      { count: 4, date: "2026-07-28" },
    ]);
  });
});
