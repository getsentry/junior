import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  allowEvalMcpWriteScope,
  challengeEvalMcpWithoutScope,
  denyEvalMcpWriteScope,
  EVAL_MCP_AUTH_PROVIDER,
  preRegisterEvalMcpClient,
  publishNoEvalMcpResourceMetadata,
  requireEvalMcpWriteScope,
  revokeEvalMcpGrant,
} from "../../msw/handlers/eval-mcp-auth";

const EVAL_AUTH_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../../fixtures/plugins/eval-auth",
);
/** The same Eval Auth plugin, with a pre-registered client that asks only for `mcp:read`. */
const EVAL_AUTH_PREREGISTERED_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../../fixtures/plugins/eval-auth-preregistered",
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
  vi.unstubAllEnvs();
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

/**
 * The person's account cannot get the scope the MCP server needs. Junior asks
 * once for that scope, and the Turn ends with a reply instead of a third link.
 */
async function askWithoutScopeAccess(thread: {
  user: string;
  ts: string;
}): Promise<ConversationWorkSlackHarness> {
  // Injected fault: the MCP server needs a scope the first sign-in lacks.
  requireEvalMcpWriteScope();
  // Injected fault: the person's account cannot get that scope.
  denyEvalMcpWriteScope();
  const harness = await askForBudget(thread);
  const [firstLink] = slackApiOutbox.authorizationLinks(thread.user);

  await approve(harness, firstLink!);
  await harness.drain();

  await expectNewLinkThenAnswer(harness, thread.user);
  return harness;
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
    await askWithoutScopeAccess({ user: "UDENIED", ts: "1712345.7001" });
  });

  it("stops sending links when the MCP server publishes no resource metadata", async () => {
    // Injected fault: each sign-in looks for the missing metadata and gets a 404.
    publishNoEvalMcpResourceMetadata();
    await askWithoutScopeAccess({ user: "UNOMETADATA", ts: "1712345.6001" });
  });

  it("stops sending links when the plugin's OAuth client asks for less than the server requires", async () => {
    await pluginApp?.cleanup();
    pluginApp = await createPluginAppFixture([
      EVAL_AUTH_PREREGISTERED_PLUGIN_ROOT,
    ]);
    vi.stubEnv("EVAL_AUTH_CLIENT_ID", "eval-auth-client-id");
    vi.stubEnv("EVAL_AUTH_CLIENT_SECRET", "eval-auth-client-secret");
    preRegisterEvalMcpClient();
    // Injected fault: the MCP server needs `mcp:write`, and every link asks
    // only for the client's `mcp:read`.
    requireEvalMcpWriteScope();
    const user = "UNARROW";
    const harness = await askForBudget({ user, ts: "1712345.8001" });
    const [firstLink] = slackApiOutbox.authorizationLinks(user);

    await approve(harness, firstLink!);
    await harness.drain();

    await expectNewLinkThenAnswer(harness, user);
  });

  it("sends a new link when the scope challenge names no scope", async () => {
    const user = "UNOSCOPE";
    // Injected fault: the MCP server needs a scope the first sign-in lacks,
    // and its challenge does not say which.
    requireEvalMcpWriteScope();
    challengeEvalMcpWithoutScope();
    const harness = await askForBudget({ user, ts: "1712345.9001" });
    const [firstLink] = slackApiOutbox.authorizationLinks(user);

    await approve(harness, firstLink!);
    await harness.drain();

    await expectNewLinkThenAnswer(harness, user);
  });

  it("offers a link again on the next message once access is granted", async () => {
    const user = "UGRANTED";
    const thread = { user, ts: "1712345.5001" };
    const harness = await askWithoutScopeAccess(thread);
    // An admin gives the person's account the scope.
    allowEvalMcpWriteScope();

    await harness.send({
      user,
      threadTs: thread.ts,
      ts: "1712345.5002",
      text: `<@${SLACK_BOT_USER_ID}> try again`,
    });
    await harness.drain();
    const links = slackApiOutbox.authorizationLinks(user);
    expect(links).toHaveLength(3);
    expect(harness.replies().at(-1)).not.toBe(ANSWER);

    await approve(harness, links[2]!);
    await harness.drain();
    expect(slackApiOutbox.authorizationLinks(user)).toHaveLength(3);
    expect(harness.replies().at(-1)).toBe(ANSWER);
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
      // A sign-in after the stop saves the credential but does not resume
      // the stopped request.
      await approve(harness, link!);
      await harness.drain();
      expect(harness.replies()).not.toContain(ANSWER);

      // A later request uses the saved credential without a new link.
      await harness.send({
        user,
        ts: "1712345.4201",
        text: `<@${SLACK_BOT_USER_ID}> look up the budget`,
      });
      await harness.drain();
      expect({
        answered: harness.replies().includes(ANSWER),
        links: slackApiOutbox.authorizationLinks(user).length,
      }).toEqual({ answered: true, links: 1 });
    },
  );
});
