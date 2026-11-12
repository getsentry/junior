import { http, HttpResponse } from "msw";
import type { PluginCache } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubGetStatusTool } from "../src/tools/get-status";
import { mswServer } from "./msw";

function memoryCache(): PluginCache {
  const values = new Map<string, unknown>();
  return {
    async getOrLoad<T>(
      key: string,
      load: () => Promise<{ ttlMs?: number; value: T }>,
    ) {
      if (values.has(key)) return values.get(key) as T;
      const entry = await load();
      if (entry.ttlMs) values.set(key, entry.value);
      return entry.value;
    },
  };
}

function incident(overrides: Record<string, unknown>) {
  return {
    components: [{ name: "Actions" }],
    created_at: "2026-11-04T09:49:00.000Z",
    impact: "major",
    name: "Incident with Actions",
    resolved_at: null,
    shortlink: "https://stspg.io/open",
    started_at: "2026-11-04T09:50:00.000Z",
    status: "investigating",
    ...overrides,
  };
}

describe("getStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists open and recent incidents from one shared status read", async () => {
    let requests = 0;
    mswServer.use(
      http.get("https://www.githubstatus.com/api/v2/incidents.json", () => {
        requests += 1;
        return HttpResponse.json({
          incidents: [
            incident({}),
            incident({
              components: [],
              name: "Incident with Git Operations",
              resolved_at: "2026-11-03T22:41:00.000Z",
              shortlink: "https://stspg.io/recent",
              started_at: "2026-11-03T20:57:00.000Z",
              status: "resolved",
            }),
            incident({
              name: "Old incident",
              resolved_at: "2026-11-02T08:00:00.000Z",
              shortlink: "https://stspg.io/old",
              status: "resolved",
            }),
          ],
        });
      }),
    );
    const tool = createGitHubGetStatusTool({ cache: memoryCache() });

    const first = await tool.execute?.({}, { toolCallId: "status-1" });
    const second = await tool.execute?.({}, { toolCallId: "status-2" });

    expect(requests).toBe(1);
    expect(second).toEqual(first);
    expect(first).toEqual({
      target: "getStatus",
      incidents: [
        {
          components: ["Actions"],
          impact: "major",
          name: "Incident with Actions",
          started_at: "2026-11-04T09:50:00.000Z",
          status: "investigating",
          url: "https://stspg.io/open",
        },
        {
          components: [],
          impact: "major",
          name: "Incident with Git Operations",
          resolved_at: "2026-11-03T22:41:00.000Z",
          started_at: "2026-11-03T20:57:00.000Z",
          status: "resolved",
          url: "https://stspg.io/recent",
        },
      ],
    });
  });

  it("fails when the status page fails", async () => {
    mswServer.use(
      http.get(
        "https://www.githubstatus.com/api/v2/incidents.json",
        () => new HttpResponse(null, { status: 503 }),
      ),
    );
    const tool = createGitHubGetStatusTool({ cache: memoryCache() });

    await expect(
      tool.execute?.({}, { toolCallId: "status-failed" }),
    ).rejects.toThrow("githubstatus.com returned HTTP 503");
  });
});
