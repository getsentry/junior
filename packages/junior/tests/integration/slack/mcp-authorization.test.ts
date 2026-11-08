import path from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConversationEventStore } from "@/chat/db";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createModelAgentRunnerForRun } from "../../fixtures/agent-runner";
import {
  createConversationWorkSlackHarness,
  SLACK_BOT_USER_ID,
  type ConversationWorkSlackHarness,
} from "../../fixtures/conversation-work";
import { runMcpOauthCallbackRoute } from "../../fixtures/mcp-oauth-callback-harness";
import { createModelStream } from "../../fixtures/model-stream";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../../fixtures/plugin-app";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import {
  EVAL_MCP_AUTH_ORIGIN,
  EVAL_MCP_AUTH_PROVIDER,
  EVAL_MCP_SERVER_URL,
  withholdEvalMcpRefreshTokens,
} from "../../msw/handlers/eval-mcp-auth";
import { mswServer } from "../../msw/server";

const EVAL_AUTH_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../../fixtures/plugins/eval-auth",
);
const ANSWER = "The budget is ready.";
const AUTH_NOTICE = expect.stringContaining("I sent you a private link.");

let pluginApp: PluginAppFixture | undefined;
let previousBaseUrl: string | undefined;

beforeEach(async () => {
  previousBaseUrl = process.env.JUNIOR_BASE_URL;
  process.env.JUNIOR_BASE_URL = "https://junior.example.com";
  pluginApp = await createPluginAppFixture([EVAL_AUTH_PLUGIN_ROOT]);
});

afterEach(async () => {
  await disconnectStateAdapter();
  await pluginApp?.cleanup();
  if (previousBaseUrl === undefined) delete process.env.JUNIOR_BASE_URL;
  else process.env.JUNIOR_BASE_URL = previousBaseUrl;
});

/** Each agent run connects Eval Auth, then answers. */
async function budgetHarness(): Promise<ConversationWorkSlackHarness> {
  return await createConversationWorkSlackHarness({
    agentRunner: createModelAgentRunnerForRun(() =>
      createModelStream([
        {
          type: "toolCall",
          name: "searchMcpTools",
          arguments: { provider: EVAL_MCP_AUTH_PROVIDER, query: "budget" },
        },
        { type: "text", text: ANSWER },
      ]),
    ),
  });
}

/** The private sign-in links that Junior sent to the person. */
function privateLinks(user: string): string[] {
  return slackApiOutbox
    .calls("chat.postEphemeral")
    .filter((call) => call.params.user === user)
    .map(
      (call) =>
        (call.params.blocks as Array<{ accessory?: { url?: string } }>)[0]
          ?.accessory?.url ?? "",
    );
}

/** The person opens a link, approves, and the callback resumes the Turn. */
async function signIn(harness: ConversationWorkSlackHarness, link: string) {
  const approval = await fetch(link, { redirect: "manual" });
  const callback = new URL(approval.headers.get("location")!);
  const response = await runMcpOauthCallbackRoute({
    provider: EVAL_MCP_AUTH_PROVIDER,
    state: callback.searchParams.get("state")!,
    code: callback.searchParams.get("code")!,
    conversationWorkQueue: harness.wakes,
  });
  expect(response.status).toBe(200);
  await harness.drain();
}

/** The provider answers the first request that uses a token with `response`. */
function rejectFirstTokenUse(response: () => Response) {
  let rejected = false;
  mswServer.use(
    http.post(EVAL_MCP_SERVER_URL, ({ request }) => {
      if (rejected || !request.headers.has("authorization")) return undefined;
      rejected = true;
      return response();
    }),
  );
}

async function turnEvents(conversationId: string): Promise<string[]> {
  return (await getConversationEventStore().loadHistory(conversationId))
    .map((event) => event.data.type)
    .filter((type) => type === "turn_completed" || type === "turn_failed");
}

describe("Slack MCP authorization", () => {
  async function expectNewLinkAfterRejectedSignIn(args: {
    user: string;
    ts: string;
  }) {
    const conversationId = `slack:C123:${args.ts}`;
    const harness = await budgetHarness();
    await harness.send({
      user: args.user,
      ts: args.ts,
      text: `<@${SLACK_BOT_USER_ID}> look up the budget`,
    });
    await harness.drain();
    const [firstLink] = privateLinks(args.user);
    expect(firstLink).toBeDefined();

    // The provider rejects the new sign-in, so Junior asks again.
    await signIn(harness, firstLink!);
    const links = privateLinks(args.user);
    expect({ links: links.length, replies: harness.replies() }).toEqual({
      links: 2,
      replies: [AUTH_NOTICE, AUTH_NOTICE],
    });
    expect(links[1]).not.toBe(firstLink);

    await signIn(harness, links[1]!);
    expect(privateLinks(args.user)).toHaveLength(2);
    expect(harness.replies()).toEqual([AUTH_NOTICE, AUTH_NOTICE, ANSWER]);
    expect(await turnEvents(conversationId)).toEqual(["turn_completed"]);
  }

  it("sends a new private link when the provider rejects the new token and refresh fails", async () => {
    rejectFirstTokenUse(
      () =>
        new HttpResponse(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
        }),
    );
    // Injected fault: the provider also rejects the refresh token.
    mswServer.use(
      http.post(`${EVAL_MCP_AUTH_ORIGIN}/oauth/token`, async ({ request }) => {
        const body = new URLSearchParams(await request.clone().text());
        if (body.get("grant_type") !== "refresh_token") return undefined;
        return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
      }),
    );

    await expectNewLinkAfterRejectedSignIn({
      user: "UREJECTED",
      ts: "1712345.2001",
    });
  });

  it("sends a new private link when the provider asks for more scope after sign-in", async () => {
    withholdEvalMcpRefreshTokens();
    rejectFirstTokenUse(
      () =>
        new HttpResponse(null, {
          status: 403,
          headers: {
            "WWW-Authenticate":
              'Bearer error="insufficient_scope", scope="mcp:read mcp:write"',
          },
        }),
    );

    await expectNewLinkAfterRejectedSignIn({
      user: "USTEPUP",
      ts: "1712345.3001",
    });
  });
});
