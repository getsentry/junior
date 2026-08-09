import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { upsertIdentity } from "@/chat/identities/sql";
import { resolvePersonForSlackMention } from "@/chat/identities/resolve";
import { createResolvePersonTool } from "@/chat/slack/tools/resolve-person";
import type { SlackToolContext } from "@/chat/slack/tools/context";
import { parseSlackTeamId, parseSlackUserId } from "@/chat/slack/ids";
import { usersInfoOk, usersListPage } from "../fixtures/slack/factories/api";
import { createLocalJuniorSqlFixture } from "../fixtures/sql";
import {
  getCapturedSlackApiCalls,
  queueSlackApiError,
  queueSlackApiResponse,
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

describe("resolvePerson", () => {
  it("resolves a Slack user id to a mention token and stores the identity", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      queueSlackApiResponse("users.info", {
        body: usersInfoOk({
          userId: "U039RR91S",
          userName: "dcramer",
          realName: "David Cramer",
          displayName: "David Cramer",
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

      const teamId = parseSlackTeamId("T123");
      if (!teamId) throw new Error("invalid team id");
      const result = await resolvePersonForSlackMention({
        teamId,
        mode: "slack_user_id",
        value: "U039RR91S",
        sqlDb: fixture.sql,
      });

      expect(result).toMatchObject({
        status: "resolved",
        person: {
          mention: "<@U039RR91S>",
          slack_user_id: "U039RR91S",
          handle: "dcramer",
          display_name: "David Cramer",
          github_username: "dcramer",
          match: "exact",
        },
      });
      expect(getCapturedSlackApiCalls("users.info")).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("resolves by stored email without guessing on ambiguity", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      await upsertIdentity(fixture.sql, {
        kind: "user",
        provider: "slack",
        providerTenantId: "T123",
        providerSubjectId: "U039RR91S",
        email: "david@sentry.io",
        emailVerified: true,
        displayName: "David Cramer",
        handle: "dcramer",
      });

      const teamId = parseSlackTeamId("T123");
      if (!teamId) throw new Error("invalid team id");
      const result = await resolvePersonForSlackMention({
        teamId,
        mode: "email",
        value: "david@sentry.io",
        sqlDb: fixture.sql,
      });

      expect(result).toMatchObject({
        status: "resolved",
        person: {
          mention: "<@U039RR91S>",
          slack_user_id: "U039RR91S",
          email: "david@sentry.io",
        },
      });
      expect(getCapturedSlackApiCalls("users.lookupByEmail")).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("resolves GitHub usernames through linked identities", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const slack = await upsertIdentity(fixture.sql, {
        kind: "user",
        provider: "slack",
        providerTenantId: "T123",
        providerSubjectId: "U039RR91S",
        email: "david@sentry.io",
        emailVerified: true,
        displayName: "David Cramer",
        handle: "dcramer",
      });
      expect(slack.userId).toBeTruthy();
      await upsertIdentity(fixture.sql, {
        kind: "user",
        provider: "github",
        providerSubjectId: "dcramer",
        handle: "dcramer",
        email: "david@sentry.io",
        emailVerified: true,
      });

      const teamId = parseSlackTeamId("T123");
      if (!teamId) throw new Error("invalid team id");
      const result = await resolvePersonForSlackMention({
        teamId,
        mode: "github",
        value: "dcramer",
        sqlDb: fixture.sql,
      });

      expect(result).toMatchObject({
        status: "resolved",
        person: {
          mention: "<@U039RR91S>",
          github_username: "dcramer",
        },
      });
    } finally {
      await fixture.close();
    }
  });

  it("returns ambiguous candidates for non-unique name search", async () => {
    const fixture = await createLocalJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
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

      const teamId = parseSlackTeamId("T123");
      if (!teamId) throw new Error("invalid team id");
      const result = await resolvePersonForSlackMention({
        teamId,
        mode: "query",
        value: "Alex",
        sqlDb: fixture.sql,
      });

      expect(result.status).toBe("ambiguous");
      if (result.status !== "ambiguous") return;
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.slack_user_id).sort()).toEqual([
        "U111AAA",
        "U222BBB",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("surfaces tool errors for missing people", async () => {
    queueSlackApiError("users.info", { error: "user_not_found" });
    const tool = createResolvePersonTool(slackToolContext());
    await expect(
      executeTool(tool, { mode: "slack_user_id", value: "U0MISSING" }),
    ).rejects.toMatchObject({
      name: "ToolInputError",
    });
  });

  it("parses mention-ready slack ids", () => {
    expect(parseSlackUserId("U039RR91S")).toBe("U039RR91S");
    expect(parseSlackUserId("not-a-user")).toBeUndefined();
  });
});
