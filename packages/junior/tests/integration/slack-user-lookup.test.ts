import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { upsertIdentity } from "@/chat/identities/sql";
import { parseSlackTeamId } from "@/chat/slack/ids";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { createSlackUserLookupTool } from "@/chat/slack/tools/user-lookup";
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
  const prepared = tool.prepareArguments?.(input) ?? input;
  return await tool.execute(prepared, {} as any);
}

function slackToolContext(): SlackToolContext {
  const teamId = parseSlackTeamId("T123");
  if (!teamId) throw new Error("invalid test team id");
  return {
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId: "C12345",
    },
    source: createSlackSource({
      teamId: "T123",
      channelId: "C12345",
      visibility: "public",
    }),
    destinationChannelId: "C12345" as any,
    sourceChannelId: "C12345" as any,
    teamId,
  };
}

function lookupTool() {
  return createSlackUserLookupTool(slackToolContext());
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

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "user_id",
        value: "U039RR91S",
      });

      expect(result).toMatchObject({
        mode: "user_id",
        mention: "<@U039RR91S>",
        user: {
          id: "U039RR91S",
          name: "dcramer",
          real_name: "David Cramer",
          display_name: "David Cramer",
          title: "Co-founder & CTO",
          email: "david@sentry.io",
          is_bot: false,
          is_deleted: false,
          mention: "<@U039RR91S>",
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
          userId: "U0BASIC",
          userName: "basic",
          realName: "Basic User",
        }),
      });

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "user_id",
        value: "U0BASIC",
      });

      expect(result).toMatchObject({
        mode: "user_id",
        user: {
          id: "U0BASIC",
          name: "basic",
          real_name: "Basic User",
          status_text: "",
          status_emoji: "",
          is_bot: false,
        },
      });
      expect(result.user.profile_fields).toBeUndefined();
    });

    it("handles user not found", async () => {
      queueSlackApiError("users.info", { error: "user_not_found" });

      const tool = lookupTool();
      await expect(
        executeTool(tool, {
          mode: "user_id",
          value: "U0NONEXISTENT",
        }),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: "No Slack user found for the supplied user ID.",
      });
    });
  });

  describe("email mode", () => {
    it("finds a user by email", async () => {
      queueSlackApiResponse("users.lookupByEmail", {
        body: usersInfoOk({
          userId: "U0EMAIL",
          userName: "emailuser",
          realName: "Email User",
          email: "emailuser@sentry.io",
        }),
      });

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "email",
        value: "emailuser@sentry.io",
      });

      expect(result).toMatchObject({
        mode: "email",
        mention: "<@U0EMAIL>",
        user: {
          id: "U0EMAIL",
          name: "emailuser",
          email: "emailuser@sentry.io",
          mention: "<@U0EMAIL>",
        },
      });

      expect(getCapturedSlackApiCalls("users.lookupByEmail")).toHaveLength(1);
    });

    it("returns error when email not found", async () => {
      queueSlackApiError("users.lookupByEmail", {
        error: "users_not_found",
      });

      const tool = lookupTool();
      await expect(
        executeTool(tool, {
          mode: "email",
          value: "nobody@example.com",
        }),
      ).rejects.toThrow("No Slack user found");
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

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "query",
        value: "markus",
      });

      expect(result).toMatchObject({
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

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "query",
        value: "zzzzzz",
      });

      expect(result).toMatchObject({
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

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "query",
        value: "junior",
      });

      expect(result.users).toHaveLength(1);
      expect(result.users[0].id).toBe("U2");
    });

    it("reports truncated when the default page cap is reached", async () => {
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
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [{ id: "U3", name: "alice3", realName: "Alice Brown" }],
          nextCursor: "cursor_page4",
        }),
      });

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "query",
        value: "alice",
      });

      expect(result).toMatchObject({
        count: 3,
        searched_pages: 3,
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

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "query",
        value: "alice",
      });

      expect(result).toMatchObject({
        count: 2,
        searched_pages: 2,
        truncated: false,
      });
    });

    it("reports a missing user scope with repair guidance", async () => {
      queueSlackApiError("users.list", {
        error: "missing_scope",
        needed: "users:read",
        provided: "chat:write",
      });

      const tool = lookupTool();
      await expect(
        executeTool(tool, { mode: "query", value: "alice" }),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message:
          "Slack user lookup is unavailable because this installation is missing the `users:read` scope.",
        cause: {
          name: "SlackActionError",
          code: "missing_scope",
          needed: "users:read",
          provided: "chat:write",
        },
      });
    });

    it("leaves internal Slack failures unexpected", async () => {
      queueSlackApiError("users.list", { error: "fatal_error" });

      const tool = lookupTool();
      await expect(
        executeTool(tool, { mode: "query", value: "alice" }),
      ).rejects.toMatchObject({
        name: "SlackActionError",
        code: "internal_error",
        apiError: "fatal_error",
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

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "query",
        value: "user",
      });

      expect(result.users).toHaveLength(1);
      expect(result.users[0].id).toBe("U2");
    });
  });

  describe("input validation", () => {
    it("requires mode and value in the model-facing schema", async () => {
      const tool = lookupTool();

      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["mode", "value"],
        properties: {
          mode: { enum: ["user_id", "email", "query", "github"] },
          value: { type: "string" },
        },
      });
      expect(
        Object.keys(tool.inputSchema.properties as Record<string, unknown>),
      ).toEqual(["mode", "value"]);
    });

    it("rejects the previous identifier fields", async () => {
      const tool = lookupTool();
      await expect(executeTool(tool, { user_id: "U123" })).rejects.toThrow(
        "Invalid tool arguments",
      );
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
            teamId: "T0TEST",
            channelId: "C0TEST",

            visibility: "private",
          }),
          destination: {
            platform: "slack",
            teamId: "T0TEST",
            channelId: "C0TEST",
          },
          egress: {
            async fetch() {
              return new Response("ok");
            },
          },
          workspace: {} as any,
        },
      );

      expect(tools).toHaveProperty("slackUserLookup");
      expect(tools.slackUserLookup.description).toContain("Slack user");
    });
  });

  describe("identity-backed lookup", () => {
    it("resolves stored email without a live Slack email lookup", async () => {
      const sql = getSqlExecutor();
      await upsertIdentity(sql, {
        kind: "user",
        provider: "slack",
        providerTenantId: "T123",
        providerSubjectId: "U039RR91S",
        email: "david@sentry.io",
        emailVerified: true,
        displayName: "David Cramer",
        handle: "dcramer",
      });

      queueSlackApiResponse("users.info", {
        body: usersInfoOk({
          userId: "U039RR91S",
          userName: "dcramer",
          realName: "David Cramer",
          email: "david@sentry.io",
        }),
      });

      const result = await executeTool(lookupTool(), {
        mode: "email",
        value: "david@sentry.io",
      });

      expect(result).toMatchObject({
        mode: "email",
        mention: "<@U039RR91S>",
        user: { id: "U039RR91S", mention: "<@U039RR91S>" },
      });
      expect(getCapturedSlackApiCalls("users.lookupByEmail")).toHaveLength(0);
    });

    it("resolves GitHub usernames through linked identities", async () => {
      const sql = getSqlExecutor();
      await upsertIdentity(sql, {
        kind: "user",
        provider: "slack",
        providerTenantId: "T123",
        providerSubjectId: "U039RR91S",
        email: "david@sentry.io",
        emailVerified: true,
        displayName: "David Cramer",
        handle: "dcramer",
      });
      await upsertIdentity(sql, {
        kind: "user",
        provider: "github",
        providerSubjectId: "dcramer",
        handle: "dcramer",
        email: "david@sentry.io",
        emailVerified: true,
      });

      queueSlackApiResponse("users.info", {
        body: usersInfoOk({
          userId: "U039RR91S",
          userName: "dcramer",
          realName: "David Cramer",
        }),
      });

      const result = await executeTool(lookupTool(), {
        mode: "github",
        value: "dcramer",
      });

      expect(result).toMatchObject({
        mode: "github",
        mention: "<@U039RR91S>",
        github_username: "dcramer",
        user: { id: "U039RR91S", mention: "<@U039RR91S>" },
      });
    });

    it("returns multi-match query results with mention tokens", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U111AAA",
              name: "alex",
              realName: "Alex One",
              displayName: "Alex",
            },
            {
              id: "U222BBB",
              name: "alex2",
              realName: "Alex Two",
              displayName: "Alex",
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        mode: "query",
        value: "Alex",
      });

      expect(result).toMatchObject({
        mode: "query",
        count: 2,
      });
      expect(result.users).toHaveLength(2);
      expect(
        result.users.map((user: { id: string }) => user.id).sort(),
      ).toEqual(["U111AAA", "U222BBB"]);
      expect(
        result.users.every((user: { mention?: string }) => user.mention),
      ).toBe(true);
    });
  });

  describe("custom profile fields", () => {
    it("returns custom profile fields as-is", async () => {
      queueSlackApiResponse("users.info", {
        body: usersInfoOk({
          userId: "U0GH",
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

      const tool = lookupTool();
      const result = await executeTool(tool, {
        mode: "user_id",
        value: "U0GH",
      });

      expect(result.user.profile_fields).toHaveLength(1);
      expect(result.user.profile_fields[0]).toMatchObject({
        id: "Xf042GITHUB",
        label: "GitHub",
        value: "https://github.com/untitaker",
      });
    });
  });
});
