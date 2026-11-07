import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { mcpConversationSchema } from "@/api/mcp/conversation-summary";
import type { JuniorApiEnv } from "@/api/route";
import { runConversations } from "@/cli/conversations";
import { CLI_USAGE } from "@/cli/run";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants } from "@/db/schema";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const LIST_ARGS = [
  "list",
  "--base-url",
  "http://localhost",
  "--token",
  "jr_pat_test",
];

describe("junior conversations CLI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists roots and their Threads in the MCP shape across pages", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    // The dashboard pages use a base path that the API URL does not have.
    const previousDashboardLinkOptions = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
      basePath: "/dashboard",
    });
    const store = createSqlStore(fixture.sql);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const requests: URL[] = [];
    try {
      await migrateSchema(fixture.sql);
      const viewer = await resolveViewerUser("exporter@example.com");
      if (!viewer) throw new Error("missing viewer");
      // The token resolves to this viewer in production.
      const app = new Hono<JuniorApiEnv>();
      app.use("*", async (context, next) => {
        context.set("viewer", viewer);
        await next();
      });
      app.route("/", createJuniorApi());
      vi.stubGlobal("fetch", async (input: URL, init?: RequestInit) => {
        requests.push(input);
        return await app.request(input, init);
      });
      const join = async (conversationId: string, archivedAt?: Date) =>
        await getDb()
          .insert(juniorConversationParticipants)
          .values({
            archivedAt,
            lastMessageAt: new Date(1_000),
            rootConversationId: conversationId,
            userId: viewer.id,
          });

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
      await join("slack:C123:thread");
      await store.createChild({
        childConversationId: "agent:export-thread",
        kind: "thread",
        nowMs: 100_001,
        parentConversationId: "slack:C123:thread",
      });
      // One more root than a page, so the command must follow `nextCursor`.
      for (let index = 0; index < 50; index += 1) {
        const conversationId = `slack:C456:${String(index).padStart(2, "0")}`;
        await store.recordActivity({
          conversationId,
          destination: { platform: "slack", teamId: "T123", channelId: "C456" },
          nowMs: 1_000 + index,
          source: "slack",
          visibility: "public",
        });
        await join(conversationId);
      }
      await store.recordActivity({
        conversationId: "slack:C789:archived",
        destination: { platform: "slack", teamId: "T123", channelId: "C789" },
        nowMs: 500,
        source: "slack",
        title: "Archived thread",
        visibility: "public",
      });
      await join("slack:C789:archived", new Date(600));

      await expect(runConversations(LIST_ARGS)).resolves.toBe(0);

      expect(error).not.toHaveBeenCalled();
      expect(requests.map((url) => url.searchParams.has("cursor"))).toEqual([
        false,
        true,
      ]);
      const lines = log.mock.calls.map(([line]) =>
        mcpConversationSchema.parse(JSON.parse(String(line))),
      );
      expect(lines).toHaveLength(52);
      expect(new Set(lines.map((line) => line.conversationId)).size).toBe(52);
      expect(lines[0]).toMatchObject({
        conversationId: "slack:C123:thread",
        title: "Slack thread",
        kind: "root",
        url: "https://junior.example.com/dashboard/conversations/slack%3AC123%3Athread",
        locationUrl:
          "https://example.slack.com/archives/C123/p1700000000000100?thread_ts=1700000000.000100&cid=C123",
      });
      expect(lines[1]).toMatchObject({
        conversationId: "agent:export-thread",
        kind: "thread",
        parentConversationId: "slack:C123:thread",
      });
      expect(lines.at(-1)).toMatchObject({
        conversationId: "slack:C456:00",
        url: "https://junior.example.com/dashboard/conversations/slack%3AC456%3A00",
      });
      expect(lines.at(-1)).not.toHaveProperty("locationUrl");

      log.mockClear();
      await expect(
        runConversations([...LIST_ARGS, "--status", "archived"]),
      ).resolves.toBe(0);
      expect(
        log.mock.calls.map(([line]) => JSON.parse(String(line)).conversationId),
      ).toEqual(["slack:C789:archived"]);

      await expect(
        runConversations([...LIST_ARGS, "--status", "all"]),
      ).resolves.toBe(1);
      expect(error).toHaveBeenLastCalledWith(
        "--status must be active or archived",
      );
      await expect(runConversations(["list"])).resolves.toBe(1);
      expect(error).toHaveBeenLastCalledWith(CLI_USAGE);
    } finally {
      setDashboardConversationLinkOptions(previousDashboardLinkOptions);
      await fixture.close();
    }
  });
});
