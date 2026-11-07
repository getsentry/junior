import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { mcpAutomationSchema } from "@/api/mcp/automation";
import type { JuniorApiEnv } from "@/api/route";
import { runAutomations } from "@/cli/automations";
import { CLI_USAGE } from "@/cli/run";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { seedMcpAutomation } from "../fixtures/mcp-tools";
import { createConfiguredJuniorSqlFixture } from "../fixtures/sql";

const OWNER = "automation-owner@example.com";

describe("junior automations CLI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists every Automation of the token owner in the MCP shape across pages", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    const previousDashboardLinkOptions = setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
      basePath: "/dashboard",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const requests: URL[] = [];
    try {
      await migrateSchema(fixture.sql);
      // One more than a page, so the command must read a second page.
      for (let index = 0; index < 101; index += 1) {
        await seedMcpAutomation({
          email: OWNER,
          id: `sched_export_${String(index).padStart(3, "0")}`,
          instruction: `Post digest ${index}.`,
          slackUserId: "U123",
          title: `Digest ${index}`,
          visibility: "public",
        });
      }
      // A public Automation of another person is not part of the export.
      await seedMcpAutomation({
        email: "automation-other@example.com",
        id: "sched_other_digest",
        instruction: "Post another digest.",
        slackUserId: "U456",
        title: "Other digest",
        visibility: "public",
      });
      const viewer = await resolveViewerUser(OWNER);
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

      await expect(
        runAutomations([
          "list",
          "--base-url",
          "http://localhost",
          "--token",
          "jr_pat_test",
        ]),
      ).resolves.toBe(0);

      expect(error).not.toHaveBeenCalled();
      // A page past the end returns the last page again, so the command must
      // stop after the page that reaches `total`.
      expect(requests.map((url) => url.searchParams.get("page"))).toEqual([
        "1",
        "2",
      ]);
      const lines = log.mock.calls.map(([line]) =>
        mcpAutomationSchema.parse(JSON.parse(String(line))),
      );
      expect(lines).toHaveLength(101);
      expect(new Set(lines.map((line) => line.id)).size).toBe(101);
      expect(lines.map((line) => line.id)).not.toContain("sched_other_digest");
      expect(
        lines.find((line) => line.id === "sched_export_000"),
      ).toMatchObject({
        title: "Digest 0",
        instruction: "Post digest 0.",
        ownedByYou: true,
        url: "https://junior.example.com/dashboard/automations/sched_export_000",
      });

      await expect(runAutomations(["list"])).resolves.toBe(1);
      expect(error).toHaveBeenLastCalledWith(CLI_USAGE);
    } finally {
      setDashboardConversationLinkOptions(previousDashboardLinkOptions);
      await fixture.close();
    }
  });
});
