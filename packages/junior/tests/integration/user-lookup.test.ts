import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { upsertIdentity } from "@/chat/identities/sql";
import { parseSlackTeamId } from "@/chat/slack/ids";
import { createUserLookupTool } from "@/chat/tools/user-lookup";
import { juniorIdentities } from "@/db/schema";
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

function lookupTool() {
  const teamId = parseSlackTeamId("T0TEST");
  if (!teamId) throw new Error("invalid test team id");
  return createUserLookupTool(teamId);
}

describe("userLookup", () => {
  describe("provider slack", () => {
    it("returns a rich profile for a known user id", async () => {
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

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "U039RR91S",
      });

      expect(result).toMatchObject({
        provider: "slack",
        query: "U039RR91S",
        count: 1,
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
      await expect(
        getSqlExecutor()
          .db()
          .select({ id: juniorIdentities.providerSubjectId })
          .from(juniorIdentities)
          .where(eq(juniorIdentities.providerSubjectId, "U039RR91S")),
      ).resolves.toEqual([{ id: "U039RR91S" }]);
    });

    it("returns user without custom fields when none are set", async () => {
      queueSlackApiResponse("users.info", {
        body: usersInfoOk({
          userId: "U0BASIC",
          userName: "basic",
          realName: "Basic User",
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "U0BASIC",
      });

      expect(result).toMatchObject({
        provider: "slack",
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

      await expect(
        executeTool(lookupTool(), {
          provider: "slack",
          query: "U0NONEXISTENT",
        }),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: "No Slack user found for the supplied user ID.",
        cause: {
          name: "SlackActionError",
          apiError: "user_not_found",
        },
      });
    });

    it("finds a user by email", async () => {
      queueSlackApiResponse("users.lookupByEmail", {
        body: usersInfoOk({
          userId: "U0EMAIL",
          userName: "emailuser",
          realName: "Email User",
          email: "emailuser@sentry.io",
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "emailuser@sentry.io",
      });

      expect(result).toMatchObject({
        provider: "slack",
        mention: "<@U0EMAIL>",
        user: {
          id: "U0EMAIL",
          name: "emailuser",
          email: "emailuser@sentry.io",
        },
      });

      expect(getCapturedSlackApiCalls("users.lookupByEmail")).toHaveLength(1);
    });

    it("uses a stored identity before asking Slack", async () => {
      await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: "T0TEST",
        providerSubjectId: "U0STORED",
        email: "stored@sentry.io",
        emailVerified: true,
        displayName: "Stored User",
        handle: "stored",
      });

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "stored@sentry.io",
      });

      expect(result).toMatchObject({
        mention: "<@U0STORED>",
        user: { id: "U0STORED", name: "stored" },
      });
      expect(getCapturedSlackApiCalls("users.lookupByEmail")).toHaveLength(0);
    });

    it("throws when several stored identities share an email", async () => {
      await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: "T0TEST",
        providerSubjectId: "U0ONE",
        email: "shared@sentry.io",
        emailVerified: true,
        displayName: "One",
        handle: "one",
      });
      await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: "T0TEST",
        providerSubjectId: "U0TWO",
        email: "shared@sentry.io",
        emailVerified: true,
        displayName: "Two",
        handle: "two",
      });

      await expect(
        executeTool(lookupTool(), {
          provider: "slack",
          query: "shared@sentry.io",
        }),
      ).rejects.toThrow(
        "Multiple Slack users share verified email shared@sentry.io in workspace T0TEST",
      );
      expect(getCapturedSlackApiCalls("users.lookupByEmail")).toHaveLength(0);
    });

    it("returns error when email not found", async () => {
      queueSlackApiError("users.lookupByEmail", {
        error: "users_not_found",
      });

      await expect(
        executeTool(lookupTool(), {
          provider: "slack",
          query: "nobody@example.com",
        }),
      ).rejects.toThrow("No Slack user found");
    });

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

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "markus",
      });

      expect(result).toMatchObject({
        provider: "slack",
        query: "markus",
      });

      expect(result.users.length).toBeGreaterThanOrEqual(1);
      expect(result.users[0]).toMatchObject({
        id: "U3",
        mention: "<@U3>",
      });
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

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "zzzzzz",
      });

      expect(result).toMatchObject({
        provider: "slack",
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

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "junior",
      });

      expect(result).toMatchObject({
        count: 1,
        mention: "<@U2>",
        user: { id: "U2" },
      });
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

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "alice",
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

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "alice",
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

      await expect(
        executeTool(lookupTool(), { provider: "slack", query: "alice" }),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message:
          "User lookup is unavailable because this installation is missing the `users:read` scope.",
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

      await expect(
        executeTool(lookupTool(), { provider: "slack", query: "alice" }),
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

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "user",
      });

      expect(result).toMatchObject({
        count: 1,
        mention: "<@U2>",
        user: { id: "U2" },
      });
    });
  });

  describe("provider github", () => {
    it("returns one mention for an exact GitHub profile field match", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U039RR91S",
              name: "dcramer",
              realName: "David Cramer",
              fields: {
                Xf0123GITHUB: {
                  value: "https://github.com/dcramer",
                  alt: "dcramer",
                  label: "GitHub",
                },
              },
            },
            {
              id: "U0OTHER",
              name: "other",
              realName: "Other Person",
              fields: {
                Xf042GITHUB: {
                  value: "https://github.com/untitaker",
                  label: "GitHub",
                },
              },
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "github",
        query: "@dcramer",
      });

      expect(result).toMatchObject({
        provider: "github",
        query: "dcramer",
        count: 1,
        mention: "<@U039RR91S>",
        user: { id: "U039RR91S", name: "dcramer" },
      });
      expect(result.users).toBeUndefined();
      await expect(
        getSqlExecutor()
          .db()
          .select({ id: juniorIdentities.providerSubjectId })
          .from(juniorIdentities)
          .where(eq(juniorIdentities.providerSubjectId, "U039RR91S")),
      ).resolves.toEqual([{ id: "U039RR91S" }]);
    });

    it("accepts github.com profile URLs", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U0GH",
              name: "untitaker",
              realName: "Markus Unterwaditzer",
              fields: {
                Xf042GITHUB: {
                  value: "https://github.com/untitaker",
                  label: "GitHub",
                },
              },
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "github",
        query: "https://github.com/untitaker",
      });

      expect(result).toMatchObject({
        provider: "github",
        query: "untitaker",
        mention: "<@U0GH>",
        user: { id: "U0GH" },
      });
    });

    it("returns candidates when several people share a GitHub username field", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U1",
              name: "alice",
              realName: "Alice",
              fields: {
                Xf1: {
                  value: "shared-login",
                  label: "GitHub",
                },
              },
            },
            {
              id: "U2",
              name: "bob",
              realName: "Bob",
              fields: {
                Xf2: {
                  value: "https://github.com/shared-login",
                  label: "GitHub",
                },
              },
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "github",
        query: "shared-login",
      });

      expect(result).toMatchObject({
        provider: "github",
        query: "shared-login",
        count: 2,
      });
      expect(result.mention).toBeUndefined();
      expect(result.users).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "U1", mention: "<@U1>" }),
          expect.objectContaining({ id: "U2", mention: "<@U2>" }),
        ]),
      );
    });

    it("returns empty candidates when no GitHub field matches", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U1",
              name: "alice",
              realName: "Alice",
              fields: {
                Xf1: {
                  value: "https://github.com/alice",
                  label: "GitHub",
                },
              },
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "github",
        query: "nobody",
      });

      expect(result).toMatchObject({
        provider: "github",
        query: "nobody",
        count: 0,
        users: [],
      });
    });

    it("skips deleted users", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U1",
              name: "gone",
              realName: "Gone User",
              deleted: true,
              fields: {
                Xf1: {
                  value: "gone-user",
                  label: "GitHub",
                },
              },
            },
            {
              id: "U2",
              name: "active",
              realName: "Active User",
              fields: {
                Xf2: {
                  value: "gone-user",
                  label: "GitHub",
                },
              },
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "github",
        query: "gone-user",
      });

      expect(result).toMatchObject({
        mention: "<@U2>",
        user: { id: "U2" },
      });
    });

    it("rejects invalid GitHub usernames", async () => {
      await expect(
        executeTool(lookupTool(), {
          provider: "github",
          query: "not a login!!",
        }),
      ).rejects.toMatchObject({
        name: "ToolInputError",
        message: expect.stringContaining("Invalid GitHub username"),
      });
      expect(getCapturedSlackApiCalls("users.list")).toHaveLength(0);
    });
  });

  describe("input validation", () => {
    it("requires provider and query in the model-facing schema", async () => {
      const tool = lookupTool();

      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: ["provider", "query"],
        properties: {
          provider: { enum: ["slack", "github"] },
          query: { type: "string" },
        },
      });
      expect(
        Object.keys(tool.inputSchema.properties as Record<string, unknown>),
      ).toEqual(["provider", "query"]);
    });

    it("rejects the previous mode/value fields", async () => {
      await expect(
        executeTool(lookupTool(), { mode: "user_id", value: "U123" }),
      ).rejects.toThrow("Invalid tool arguments");
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

      expect(tools).toHaveProperty("userLookup");
      expect(tools.userLookup.description).toContain("provider");
    });
  });
});
