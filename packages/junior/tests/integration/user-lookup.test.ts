import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import {
  upsertIdentity,
  upsertLinkedIdentity,
} from "@/chat/identities/sql";
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
  return createUserLookupTool(teamId, ["slack", "github"]);
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
      ).resolves.toEqual([]);
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

    it("prefers a full workspace member over an external display-name match", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U_EXTERNAL_COLIN",
              name: "colin.curtin",
              realName: "Colin Curtin",
              displayName: "Colin Curtin (Square)",
              isStranger: true,
            },
            {
              id: "U_MEMBER_COLIN",
              name: "colin.kawai",
              realName: "Colin Kawai",
              displayName: "Colin Kawai",
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "colin",
      });

      // Ambiguous first-name hits stay multi-match; ranking prefers the member.
      expect(result).toMatchObject({
        provider: "slack",
        query: "colin",
        count: 2,
      });
      expect(result.mention).toBeUndefined();
      expect(result.users.map((user: { id: string }) => user.id)).toEqual([
        "U_MEMBER_COLIN",
        "U_EXTERNAL_COLIN",
      ]);
      expect(result.users[0]).toMatchObject({
        is_external: false,
        mention: "<@U_MEMBER_COLIN>",
      });
      expect(result.users[1]).toMatchObject({
        is_external: true,
        mention: "<@U_EXTERNAL_COLIN>",
      });
    });

    it("ranks a multi-token name above another first-name match", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U_OTHER_COLIN",
              name: "colin.curtin",
              realName: "Colin Curtin",
              displayName: "Colin Curtin",
            },
            {
              id: "U_FULL_COLIN",
              name: "colin.kawai",
              realName: "Colin Kawai",
              displayName: "Colin Kawai",
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "colin kawai",
      });

      expect(result).toMatchObject({
        count: 1,
        mention: "<@U_FULL_COLIN>",
        user: { id: "U_FULL_COLIN" },
      });
    });

    it("keeps accented last-name tokens intact", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U_GARCIA",
              name: "maria.garcia",
              realName: "Maria García",
              displayName: "Maria García",
            },
            {
              id: "U_OTHER",
              name: "maria.other",
              realName: "Maria Other",
              displayName: "Maria Other",
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "garcía",
      });

      expect(result).toMatchObject({
        count: 1,
        mention: "<@U_GARCIA>",
        user: { id: "U_GARCIA" },
      });
    });

    it("does not let external demotion invert a stronger exact match", async () => {
      queueSlackApiResponse("users.list", {
        body: usersListPage({
          members: [
            {
              id: "U_GUEST_ALEX",
              name: "alex",
              realName: "Alex",
              displayName: "Alex",
              isStranger: true,
            },
            {
              id: "U_MEMBER_ALEXANDRA",
              name: "alexandra",
              realName: "Alexandra",
              displayName: "Alexandra",
            },
          ],
        }),
      });

      const result = await executeTool(lookupTool(), {
        provider: "slack",
        query: "alex",
      });

      expect(result.users.map((user: { id: string }) => user.id)).toEqual([
        "U_GUEST_ALEX",
        "U_MEMBER_ALEXANDRA",
      ]);
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
    async function seedLinkedIdentities(input: {
      githubId: string;
      githubHandle: string;
      slackUserId: string;
      slackHandle: string;
    }) {
      const slackIdentity = await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: "T0TEST",
        providerSubjectId: input.slackUserId,
        email: `${input.slackHandle}@sentry.io`,
        emailVerified: true,
        displayName: input.slackHandle,
        handle: input.slackHandle,
      });
      if (!slackIdentity.userId) throw new Error("missing linked user");
      await upsertLinkedIdentity(getSqlExecutor(), slackIdentity.userId, {
        kind: "user",
        provider: "github",
        providerSubjectId: input.githubId,
        handle: input.githubHandle,
      });
    }

    it("returns the linked Slack mention for a provider handle", async () => {
      await seedLinkedIdentities({
        githubId: "12345",
        githubHandle: "dcramer",
        slackUserId: "U039RR91S",
        slackHandle: "dcramer",
      });

      const result = await executeTool(lookupTool(), {
        provider: "github",
        query: "dcramer",
      });

      expect(result).toMatchObject({
        provider: "github",
        query: "dcramer",
        count: 1,
        mention: "<@U039RR91S>",
        user: { id: "U039RR91S", name: "dcramer" },
      });
      expect(result.user).not.toHaveProperty("email");
      expect(getCapturedSlackApiCalls("users.list")).toHaveLength(0);
    });

    it("uses the latest trusted provider handle", async () => {
      const slackIdentity = await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "slack",
        providerTenantId: "T0TEST",
        providerSubjectId: "U039RR91S",
        email: "dcramer@sentry.io",
        emailVerified: true,
        handle: "dcramer",
      });
      if (!slackIdentity.userId) throw new Error("missing linked user");
      await upsertLinkedIdentity(getSqlExecutor(), slackIdentity.userId, {
        kind: "user",
        provider: "github",
        providerSubjectId: "12345",
        handle: "old-login",
      });
      await upsertLinkedIdentity(getSqlExecutor(), slackIdentity.userId, {
        kind: "user",
        provider: "github",
        providerSubjectId: "12345",
        handle: "new-login",
      });

      await expect(
        executeTool(lookupTool(), { provider: "github", query: "old-login" }),
      ).resolves.toMatchObject({ count: 0, users: [] });
      await expect(
        executeTool(lookupTool(), { provider: "github", query: "new-login" }),
      ).resolves.toMatchObject({
        count: 1,
        mention: "<@U039RR91S>",
      });
    });

    it("accepts the provider subject id", async () => {
      await seedLinkedIdentities({
        githubId: "12345",
        githubHandle: "dcramer",
        slackUserId: "U039RR91S",
        slackHandle: "dcramer",
      });

      const result = await executeTool(lookupTool(), {
        provider: "github",
        query: "12345",
      });

      expect(result).toMatchObject({
        mention: "<@U039RR91S>",
        user: { id: "U039RR91S" },
      });
    });

    it("returns candidates when several provider identities share a handle", async () => {
      await seedLinkedIdentities({
        githubId: "1",
        githubHandle: "shared-login",
        slackUserId: "U1",
        slackHandle: "alice",
      });
      await seedLinkedIdentities({
        githubId: "2",
        githubHandle: "shared-login",
        slackUserId: "U2",
        slackHandle: "bob",
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

    it("returns empty candidates when no stored provider identity matches", async () => {
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

    it("treats SQL pattern characters as literal provider handles", async () => {
      await seedLinkedIdentities({
        githubId: "12345",
        githubHandle: "dcramer",
        slackUserId: "U039RR91S",
        slackHandle: "dcramer",
      });

      for (const query of ["%", "_"]) {
        await expect(
          executeTool(lookupTool(), { provider: "github", query }),
        ).resolves.toMatchObject({ count: 0, users: [] });
      }
    });

    it("does not return provider identities without a linked Slack identity", async () => {
      await upsertIdentity(getSqlExecutor(), {
        kind: "user",
        provider: "github",
        providerSubjectId: "orphan",
        handle: "orphan",
      });

      const result = await executeTool(lookupTool(), {
        provider: "github",
        query: "orphan",
      });

      expect(result).toMatchObject({ count: 0, users: [] });
    });
  });

  describe("input validation", () => {
    it("requires provider and query in the model-facing schema", async () => {
      const tool = lookupTool();

      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
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
