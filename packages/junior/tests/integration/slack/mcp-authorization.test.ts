import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  denyEvalMcpWriteScope,
  EVAL_MCP_AUTH_PROVIDER,
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
 * The provider rejected the first sign-in, so Junior sends one new link
 * instead of answering. After the person approves it, Junior stops asking and
 * the thread gets the agent's reply. Returns the new link.
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

// Each case runs the Turn up to three times with two sign-ins in between. The
// first case in the file also pays the cold start.
describe("Slack MCP authorization", { timeout: 20_000 }, () => {
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
    // The provider issues refresh tokens, but a refresh keeps the old scope.
    requireEvalMcpWriteScope();
    const harness = await askForBudget({ user, ts: "1712345.3001" });
    const [firstLink] = slackApiOutbox.authorizationLinks(user);

    await approve(harness, firstLink!);
    await harness.drain();

    const newLink = await expectNewLinkThenAnswer(harness, user);
    expect(new URL(newLink).searchParams.get("scope")?.split(" ")).toContain(
      "mcp:write",
    );
  });

  it("stops sending links when the person cannot get the required scope", async () => {
    const user = "UDENIED";
    // Injected fault: the MCP server needs a scope the first sign-in lacks.
    requireEvalMcpWriteScope();
    // Injected fault: the person's account cannot get that scope.
    denyEvalMcpWriteScope();
    const harness = await askForBudget({ user, ts: "1712345.4001" });
    const [firstLink] = slackApiOutbox.authorizationLinks(user);

    await approve(harness, firstLink!);
    await harness.drain();

    await expectNewLinkThenAnswer(harness, user);
  });
});
