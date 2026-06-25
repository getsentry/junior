import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createSlackUserLookupTool } from "@/chat/tools/slack/user-lookup";
import { usersInfoOk, usersListPage } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
  queueSlackApiError,
} from "../msw/handlers/slack-api";

async function executeTool<TInput>(tool: any, input: TInput) {
  if (typeof tool?.execute !== "function") {
    throw new Error("tool execute function missing");
  }
  return await tool.execute(input, {} as any);
}

describe("slackUserLookup", () => {
  describe("user_id mode", () => {
    it("returns a rich profile for a known user", async () => {
      queueSlackApiResponse("users.info", {
        body: usersInfoOk({
          userId: "U039RR91S",
          userName: "dcramer",
          realName: "David Cramer",
          displayName: "David Cramer",
          title: "Co-founder & CTO",
          email: "david@sentry.io",
          fields: {
            Xf0123GITHUB: {
              value: "https://github.com/dcramer",
              alt: "dcramer",
              label: "GitHub",
            },
          },
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { user_id: "U039RR91S" });

      expect(result).toMatchObject({
        ok: true,
        mode: "user_id",
        user: {
          id: "U039RR91S",
          name: "dcramer",
          real_name: "David Cramer",
          display_name: "David Cramer",
          title: "Co-founder & CTO",
          email: "david@sentry.io",
          is_bot: false,
          is_deleted: false,
        },
      });

      expect(result.user.profile_fields).toHaveLength(1);
      expect(result.user.profile_fields[0]).toMatchObject({
        id: "Xf0123GITHUB",
        label: "GitHub",
        value: "https://github.com/dcramer",
      });

      expect(getCapturedSlackApiCalls("users.info")).toHaveLength(1);
    });

    it("returns user without custom fields when none are set", async () => {
      queueSlackApiResponse("users.info", {
        body: usersInfoOk({
          userId: "U_BASIC",
          userName: "basic",
          realName: "Basic User",
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { user_id: "U_BASIC" });

      expect(result).toMatchObject({
        ok: true,
        mode: "user_id",
        user: {
          id: "U_BASIC",
          name: "basic",
          real_name: "Basic User",
          is_bot: false,
        },
      });
      expect(result.user.profile_fields).toBeUndefined();
    });

    it("handles user not found", async () => {
      queueSlackApiError("users.info", { error: "user_not_found" });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { user_id: "U_NONEXISTENT" });

      expect(result.ok).toBe(false);
      expect(result.slack_error).toBe("user_not_found");
    });
  });

  describe("email mode", () => {
    it("finds a user by email", async () => {
      queueSlackApiResponse("users.lookupByEmail", {
        body: usersInfoOk({
          userId: "U_EMAIL",
          userName: "emailuser",
          realName: "Email User",
          email: "emailuser@sentry.io",
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { email: "emailuser@sentry.io" });

      expect(result).toMatchObject({
        ok: true,
        mode: "email",
        user: {
          id: "U_EMAIL",
          name: "emailuser",
          email: "emailuser@sentry.io",
        },
      });

      expect(getCapturedSlackApiCalls("users.lookupByEmail")).toHaveLength(1);
    });

    it("returns error when email not found", async () => {
      queueSlackApiError("users.lookupByEmail", {
        error: "users_not_found",
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { email: "nobody@example.com" });

      expect(result).toMatchObject({
        ok: false,
        mode: "email",
        error: "No Slack user found with that email address.",
      });
    });
  });

  describe("query mode", () => {
    it("searches and ranks users by name", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            { id: "U1", name: "alice", realName: "Alice Smith" },
            { id: "U2", name: "bob", realName: "Bob Jones" },
            {
              id: "U3",
              name: "untitaker",
              realName: "Markus Unterwaditzer",
              displayName: "Markus",
            },
            { id: "U4", name: "charlie", realName: "Charlie Markus Brown" },
          ],
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { query: "markus" });

      expect(result).toMatchObject({
        ok: true,
        mode: "query",
        query: "markus",
      });

      // Should find Markus matches, ranked by relevance
      expect(result.users.length).toBeGreaterThanOrEqual(1);
      // Display name exact match should come first
      expect(result.users[0].id).toBe("U3");
    });

    it("returns empty results when no match", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            { id: "U1", name: "alice", realName: "Alice Smith" },
            { id: "U2", name: "bob", realName: "Bob Jones" },
          ],
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { query: "zzzzzz" });

      expect(result).toMatchObject({
        ok: true,
        mode: "query",
        count: 0,
        users: [],
      });
    });

    it("skips bots by default", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            { id: "U1", name: "junior", realName: "Junior Bot", isBot: true },
            { id: "U2", name: "junior-human", realName: "Junior Person" },
          ],
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { query: "junior" });

      expect(result.users).toHaveLength(1);
      expect(result.users[0].id).toBe("U2");
    });

    it("includes bots when requested", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            { id: "U1", name: "junior", realName: "Junior Bot", isBot: true },
            { id: "U2", name: "junior-human", realName: "Junior Person" },
          ],
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, {
        query: "junior",
        include_bots: true,
      });

      expect(result.users).toHaveLength(2);
    });

    it("reports truncated when page cap is reached with more data", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [{ id: "U1", name: "alice", realName: "Alice Smith" }],
          nextCursor: "cursor_page2",
        }),
      });
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [{ id: "U2", name: "alice2", realName: "Alice Jones" }],
          nextCursor: "cursor_page3",
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, {
        query: "alice",
        max_pages: 2,
      });

      expect(result).toMatchObject({
        ok: true,
        count: 2,
        searched_pages: 2,
        truncated: true,
      });
    });

    it("reports not truncated when pagination ends naturally", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [{ id: "U1", name: "alice", realName: "Alice Smith" }],
          nextCursor: "cursor_page2",
        }),
      });
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [{ id: "U2", name: "alice2", realName: "Alice Jones" }],
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, {
        query: "alice",
        max_pages: 3,
      });

      expect(result).toMatchObject({
        ok: true,
        count: 2,
        searched_pages: 2,
        truncated: false,
      });
    });

    it("skips deleted users", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U1",
              name: "deleteduser",
              realName: "Deleted User",
              deleted: true,
            },
            { id: "U2", name: "activeuser", realName: "Active User" },
          ],
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { query: "user" });

      expect(result.users).toHaveLength(1);
      expect(result.users[0].id).toBe("U2");
    });
  });

  describe("input validation", () => {
    it("rejects when no input provided", async () => {
      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, {});

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Provide exactly one"),
      });
    });

    it("rejects when multiple inputs provided", async () => {
      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, {
        user_id: "U123",
        query: "alice",
      });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Only one of"),
      });
    });
  });

  describe("registration", () => {
    it("is registered in createTools", async () => {
      const { createTools } = await import("@/chat/tools/index");
      const tools = createTools(
        [],
        {},
        {
          source: createSlackSource({
            teamId: "T_TEST",
            channelId: "C_TEST",
            channelType: "channel",
          }),
          destination: {
            platform: "slack",
            teamId: "T_TEST",
            channelId: "C_TEST",
          },
          sandbox: {} as any,
        },
      );

      expect(tools).toHaveProperty("slackUserLookup");
      expect(tools.slackUserLookup.description).toContain("Slack user");
    });
  });

  describe("custom profile fields", () => {
    it("returns custom profile fields as-is", async () => {
      queueSlackApiResponse("users.info", {
        body: usersInfoOk({
          userId: "U_GH",
          userName: "untitaker",
          realName: "Markus Unterwaditzer",
          fields: {
            Xf042GITHUB: {
              value: "https://github.com/untitaker",
              alt: "untitaker",
              label: "GitHub",
            },
          },
        }),
      });

      const tool = createSlackUserLookupTool();
      const result = await executeTool(tool, { user_id: "U_GH" });

      expect(result.user.profile_fields).toHaveLength(1);
      expect(result.user.profile_fields[0]).toMatchObject({
        id: "Xf042GITHUB",
        label: "GitHub",
        value: "https://github.com/untitaker",
      });
    });
  });
});
