import { githubPlugin } from "@sentry/junior-github";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { closeDb, getSqlExecutor } from "@/chat/db";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import { getPluginTools } from "@/chat/plugins/agent-hooks";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
} from "../../fixtures/conversation-work";

describe("GitHub tool text", () => {
  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
  });

  it("sends no Slack mention syntax to GitHub", async () => {
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const linked = await upsertIdentity(getSqlExecutor(), {
      kind: "user",
      provider: "slack",
      providerTenantId: "T123",
      providerSubjectId: "U123",
      email: "requester@example.com",
      emailVerified: true,
    });
    await upsertLinkedIdentity(getSqlExecutor(), linked.userId!, {
      kind: "user",
      provider: "github",
      providerSubjectId: "gh-requester",
      handle: "Requester",
    });
    await upsertIdentity(getSqlExecutor(), {
      kind: "user",
      provider: "slack",
      providerTenantId: "T123",
      providerSubjectId: "U456",
      displayName: "Ada Lovelace",
    });
    const sent: unknown[] = [];
    const tools = getPluginTools({
      turnTools: turnBehavior({ kind: "root", personInput: true }).tools,
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      egress: {
        fetch: async ({ request }) => {
          sent.push(await request.json());
          return Response.json({
            id: 1,
            html_url: "https://github.com/getsentry/junior/pull/1#c1",
          });
        },
      },
      source: createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "public",
      }),
      workspace: {} as any,
    });

    await tools.github_commentOnPullRequest!.execute!(
      {
        repo: "getsentry/junior",
        number: 1,
        body: "<@U123> and <@U456|ada>: see <#C123|eng>, <https://docs.sentry.io|the docs>. <!here> <!-- keep --> `<@U123>`",
      },
      { toolCallId: "comment" },
    );

    expect(sent).toEqual([
      {
        // Markdown code shows Slack syntax as written.
        body: "@Requester and Ada Lovelace: see #eng, [the docs](https://docs.sentry.io). here <!-- keep --> `<@U123>`",
      },
    ]);
  });
});
