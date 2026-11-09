import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopConversation } from "@/chat/conversations/stop";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createModelAgentRunnerForRun } from "../../fixtures/agent-runner";
import {
  createConversationWorkSlackHarness,
  SLACK_BOT_USER_ID,
  type ConversationWorkSlackHarness,
} from "../../fixtures/conversation-work";
import { approveMcpAuthorizationLink } from "../../fixtures/mcp-oauth-callback-harness";
import { createModelStream } from "../../fixtures/model-stream";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../../fixtures/plugin-app";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import {
  EVAL_MCP_AUTH_PROVIDER,
  issueNoEvalMcpRefreshTokens,
  requireEvalMcpWriteScope,
  revokeEvalMcpGrant,
} from "../../msw/handlers/eval-mcp-auth";

const EVAL_AUTH_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../../fixtures/plugins/eval-auth",
);
const ANSWER = "The budget is ready.";

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

/** The person asks in a thread. Each agent run connects Eval Auth, then answers. */
async function askForBudget(thread: {
  user: string;
  ts: string;
}): Promise<ConversationWorkSlackHarness> {
  const harness = await createConversationWorkSlackHarness({
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
  await harness.send({
    ...thread,
    text: `<@${SLACK_BOT_USER_ID}> look up the budget`,
  });
  await harness.drain();
  return harness;
}

async function approve(harness: ConversationWorkSlackHarness, link: string) {
  await approveMcpAuthorizationLink({
    link,
    provider: EVAL_MCP_AUTH_PROVIDER,
    conversationWorkQueue: harness.wakes,
  });
}

/**
 * The provider rejected the first sign-in, so Junior sends a new link instead
 * of answering. After the person approves it, the thread gets the answer.
 * Returns the new link.
 */
async function expectNewLinkThenAnswer(
  harness: ConversationWorkSlackHarness,
  user: string,
): Promise<string> {
  const links = slackApiOutbox.authorizationLinks(user);
  expect({
    links: links.length,
    answered: harness.replies().includes(ANSWER),
  }).toEqual({ links: 2, answered: false });
  expect(links[1]).not.toBe(links[0]);

  await approve(harness, links[1]!);
  await harness.drain();
  expect(slackApiOutbox.authorizationLinks(user)).toHaveLength(2);
  // One sign-in prompt for each link, then the answer. No error reply.
  expect(harness.replies()).toEqual([
    expect.any(String),
    expect.any(String),
    ANSWER,
  ]);
  return links[1]!;
}

describe("Slack MCP authorization", () => {
  it("sends a new link when the provider revokes the grant after sign-in", async () => {
    const user = "UREVOKED";
    const harness = await askForBudget({ user, ts: "1712345.2001" });
    const [firstLink] = slackApiOutbox.authorizationLinks(user);

    await approve(harness, firstLink!);
    // Injected fault: the provider revokes the grant before the Turn resumes.
    revokeEvalMcpGrant();
    await harness.drain();

    await expectNewLinkThenAnswer(harness, user);
  });

  it("sends a new link that asks for the scope the provider requires", async () => {
    const user = "USTEPUP";
    // Injected fault: the MCP server needs a scope the first sign-in lacks.
    requireEvalMcpWriteScope();
    // Injected fault: Junior cannot refresh, so it must ask again.
    issueNoEvalMcpRefreshTokens();
    const harness = await askForBudget({ user, ts: "1712345.3001" });
    const [firstLink] = slackApiOutbox.authorizationLinks(user);

    await approve(harness, firstLink!);
    await harness.drain();

    const newLink = await expectNewLinkThenAnswer(harness, user);
    expect(new URL(newLink).searchParams.get("scope")?.split(" ")).toContain(
      "mcp:write",
    );
  });

  it.each([
    {
      name: "the `stop` keyword",
      stop: async (harness: ConversationWorkSlackHarness, threadTs: string) =>
        await harness.send({
          threadTs,
          ts: "1712345.4101",
          text: `<@${SLACK_BOT_USER_ID}> stop`,
        }),
    },
    {
      name: "Slack's native stop button",
      stop: async (harness: ConversationWorkSlackHarness, threadTs: string) =>
        await harness.sendSessionStop({ eventTs: "1712345.4101", threadTs }),
    },
    {
      name: "a dashboard stop",
      stop: async (harness: ConversationWorkSlackHarness, threadTs: string) =>
        await stopConversation({
          conversationId: `slack:C123:${threadTs}`,
          queue: harness.wakes,
          state: harness.state,
        }),
    },
  ])(
    "drops a request that waits for sign-in when the person stops it with $name",
    async ({ stop }) => {
      const user = "USTOP";
      const threadTs = "1712345.4001";
      const harness = await askForBudget({ user, ts: threadTs });
      const [link] = slackApiOutbox.authorizationLinks(user);

      await stop(harness, threadTs);
      await harness.drain();
      // The stop ended the request, so its link shows "Authorization expired".
      await expect(approve(harness, link!)).rejects.toThrow(
        "The MCP OAuth callback returned 400",
      );
      await harness.drain();

      expect(harness.replies()).not.toContain(ANSWER);
    },
  );
});
