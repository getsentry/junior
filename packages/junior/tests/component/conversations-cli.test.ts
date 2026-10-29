import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { runConversations } from "@/cli/conversations";
import { CLI_USAGE } from "@/cli/run";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

describe("junior conversations CLI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists every active conversation with its dashboard and location links", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    // The dashboard pages use a base path that the API URL does not have.
    const previousDashboardLinkOptions = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
      basePath: "/dashboard",
    });
    const store = createSqlStore(fixture.sql);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createJuniorApi();
    const requests: URL[] = [];
    vi.stubGlobal("fetch", async (input: URL, init?: RequestInit) => {
      requests.push(input);
      return await app.request(input, init);
    });
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C123:thread",
        destination: { platform: "slack", teamId: "T123", channelId: "C123" },
        nowMs: 100_000,
        sessionSource: {
          kind: "slack",
          visibility: "public",
          teamId: "T123",
          channelId: "C123",
          threadTs: "1700000000.000100",
        },
        source: "slack",
        title: "Slack thread",
        visibility: "public",
      });
      // One more than a page, so the command must follow `nextCursor`.
      for (let index = 0; index < 50; index += 1) {
        await store.recordActivity({
          conversationId: `slack:C456:${String(index).padStart(2, "0")}`,
          destination: { platform: "slack", teamId: "T123", channelId: "C456" },
          nowMs: 1_000 + index,
          source: "slack",
          visibility: "public",
        });
      }

      await expect(
        runConversations([
          "list",
          "--base-url",
          "http://localhost",
          "--token",
          "jr_pat_test",
        ]),
      ).resolves.toBe(0);

      expect(error).not.toHaveBeenCalled();
      expect(requests.map((url) => url.searchParams.has("cursor"))).toEqual([
        false,
        true,
      ]);
      const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(lines).toHaveLength(51);
      expect(new Set(lines.map((line) => line.id)).size).toBe(51);
      expect(lines[0]).toEqual({
        id: "slack:C123:thread",
        title: "Slack thread",
        dashboardUrl:
          "https://junior.example.com/dashboard/conversations/slack%3AC123%3Athread",
        locationUrl:
          "https://example.slack.com/archives/C123/p1700000000000100?thread_ts=1700000000.000100&cid=C123",
      });
      expect(lines.at(-1)).toMatchObject({
        id: "slack:C456:00",
        dashboardUrl:
          "https://junior.example.com/dashboard/conversations/slack%3AC456%3A00",
        locationUrl: null,
      });

      await expect(runConversations(["list"])).resolves.toBe(1);
      expect(error).toHaveBeenLastCalledWith(CLI_USAGE);
    } finally {
      setDashboardConversationLinkOptions(previousDashboardLinkOptions);
      await fixture.close();
    }
  });
});
