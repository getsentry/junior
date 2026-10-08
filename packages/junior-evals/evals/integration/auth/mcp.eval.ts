import { defineJuniorPlugins } from "@sentry/junior";
import { githubPlugin } from "@sentry/junior-github";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { describe, expect } from "vitest";
import {
  completeAuth,
  githubWebhook,
  person,
  slackCommand,
  slackMention,
  slackThreadMessage,
} from "@junior-evals/fixture/inputs";
import { insertWatch } from "@junior-evals/fixture/insert";
import { sendDuringFirstModelRequest } from "@junior-evals/fixture/progress";
import {
  completedMcpToolCalls,
  toolCallsOf,
} from "@junior-evals/fixture/results";
import {
  test,
  type Conversation,
  type RunAgent,
} from "@junior-evals/fixture/test";

const ALICE = person("UALICE", "Alice");
const BOB = person("UBOB", "Bob");
const BUDGET_ECHO = "mcp__eval-auth__budget-echo";
const HANDBOOK_SEARCH = "mcp__eval-handbook__handbook-search";
const PULL_REQUEST = "getsentry/junior#691";

function turnStates(conversation: Conversation) {
  return conversation.turns.map((turn) => turn.status);
}

/** Alice asks for a budget lookup and authorizes the provider. */
async function connectAlice(run: RunAgent) {
  const paused = await run(
    slackMention("/eval-auth Look up the budget.", { author: ALICE }),
  );
  expect(turnStates(paused)).toEqual(["started"]);

  // The agent says why it connects the provider, and the notice shows it.
  const connect = toolCallsOf("searchMcpTools", paused).find(
    (call) =>
      (call.input as { provider?: unknown } | undefined)?.provider ===
      "eval-auth",
  );
  const intent = (connect?.input as { intent?: unknown } | undefined)?.intent;
  expect(intent).toEqual(expect.any(String));
  expect(paused.replies.map((reply) => reply.text).join("\n")).toContain(
    `*Why:* ${String(intent)}`,
  );

  const resumed = await paused.continue(
    completeAuth("eval-auth", { author: ALICE }),
  );
  expect(turnStates(resumed)).toEqual(["succeeded"]);
  return resumed;
}

describe("MCP Authorization", () => {
  test("when one person connected a provider, another person authorizes only when they use that provider", async ({
    run,
  }) => {
    const connected = await connectAlice(run);

    // Bob uses a provider that needs no authorization. The connection of
    // Alice in the thread history is not a reason to ask Bob.
    const handbook = await connected.continue(
      slackMention(
        "Use eval-handbook to tell me what the handbook says about US holidays.",
        { author: BOB },
      ),
    );
    expect(turnStates(handbook)).toEqual(["succeeded"]);
    expect(completedMcpToolCalls(HANDBOOK_SEARCH, handbook)).not.toHaveLength(
      0,
    );

    // Bob uses the provider of Alice. He needs his own authorization.
    const paused = await handbook.continue(
      slackMention("/eval-auth Look up the budget for me.", { author: BOB }),
    );
    expect(turnStates(paused)).toEqual(["started"]);
    expect(completedMcpToolCalls(BUDGET_ECHO, paused)).toEqual([]);

    const resumed = await paused.continue(
      completeAuth("eval-auth", { author: BOB }),
    );
    expect(turnStates(resumed)).toEqual(["succeeded"]);
    expect(completedMcpToolCalls(BUDGET_ECHO, resumed)).toHaveLength(1);
  });

  test("when the person moves on without authorizing, answer the new request and ignore a late authorization", async ({
    run,
  }) => {
    const paused = await run(slackMention("/eval-auth Look up the budget."));
    expect(turnStates(paused)).toEqual(["started"]);

    const next = await paused.continue(
      slackMention("Never mind the budget. What is 17 + 25?"),
    );
    expect(turnStates(next).at(-1)).toBe("succeeded");
    expect(next.replies).toHaveLength(1);
    expect(next.replies[0]?.text).toContain("42");

    // The old link still works, but its turn is gone.
    const late = await next.continue(completeAuth("eval-auth"));
    expect(late.replies).toEqual([]);
    expect(late.toolCalls).toEqual([]);
  });

  test("when the person says stop while Junior waits for authorization, ignore a late authorization", async ({
    run,
  }) => {
    const paused = await run(slackMention("/eval-auth Look up the budget."));
    expect(turnStates(paused)).toEqual(["started"]);

    await paused.continue(slackThreadMessage("stop"));

    const late = await paused.continue(completeAuth("eval-auth"));
    expect(late.replies).toEqual([]);
    expect(late.toolCalls).toEqual([]);
  });

  test("when another person talks in the thread while the person authorizes, the authorization still resumes the turn", async ({
    run,
  }) => {
    const paused = await run(
      slackMention("/eval-auth Look up the budget.", { author: ALICE }),
    );
    expect(turnStates(paused)).toEqual(["started"]);

    const aside = await paused.continue(
      slackThreadMessage(
        `<@${ALICE.userId}> while you wait, the record id is 99.`,
        { author: BOB },
      ),
    );
    expect(aside.turns).toEqual([]);
    expect(aside.replies).toEqual([]);

    const resumed = await aside.continue(
      completeAuth("eval-auth", { author: ALICE }),
    );
    expect(turnStates(resumed)).toEqual(["succeeded"]);
    expect(completedMcpToolCalls(BUDGET_ECHO, resumed)).toHaveLength(1);
  });

  test("when another Slack app asks for a provider that needs authorization, answer without waiting for an authorization", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("/eval-auth Look up the budget.", { fromApp: true }),
    );

    // An app cannot open an authorization link, so the turn does not wait.
    expect(turnStates(conversation)).toEqual(["succeeded"]);
    expect(conversation.replies).toHaveLength(1);
    expect(completedMcpToolCalls(BUDGET_ECHO, conversation)).toEqual([]);
  });

  test("when the person unlinks the provider, the next use asks them to authorize again", async ({
    run,
  }) => {
    const connected = await connectAlice(run);

    const unlinked = await connected.continue(
      slackCommand("unlink eval-auth", { author: ALICE }),
    );
    expect(unlinked.turns).toEqual([]);

    // The turn connects the providers of the person before the agent runs,
    // so Junior asks before any tool call.
    const paused = await unlinked.continue(
      slackMention("/eval-auth Look up the budget again.", { author: ALICE }),
    );
    expect(turnStates(paused)).toEqual(["started"]);
    expect(paused.toolCalls).toEqual([]);

    const resumed = await paused.continue(
      completeAuth("eval-auth", { author: ALICE }),
    );
    expect(turnStates(resumed)).toEqual(["succeeded"]);
    expect(completedMcpToolCalls(BUDGET_ECHO, resumed)).toHaveLength(1);
  });

  test("when the person authorizes during another turn, the paused turn resumes after that turn", async ({
    agent,
  }) => {
    // A watch delivery is a turn that does not replace the paused turn.
    const { run } = await agent({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "eval-auth",
            displayName: "Eval Auth",
            description: "Eval-only MCP auth resume fixture",
            mcp: {
              transport: "http",
              url: "https://eval-auth.example.test/mcp",
              allowedTools: ["budget-echo"],
            },
          },
        }),
        githubPlugin(),
      ]),
    });
    const paused = await run(slackMention("/eval-auth Look up the budget."));
    expect(turnStates(paused)).toEqual(["started"]);
    await insertWatch({
      conversation: paused,
      events: ["pull_request.checks.failed"],
      identifier: PULL_REQUEST,
      intent: `Tell this thread when the checks of ${PULL_REQUEST} fail. Only report the failure.`,
      label: `GitHub PR ${PULL_REQUEST}`,
      resourceType: "pull_request",
    });

    const repository = {
      full_name: "getsentry/junior",
      id: 1,
      name: "junior",
      owner: { login: "getsentry" },
    };
    const repositoryRef = {
      id: repository.id,
      name: repository.name,
      url: "https://api.github.com/repos/getsentry/junior",
    };
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    const both = await paused.continue(
      githubWebhook("check_suite", {
        action: "completed",
        check_suite: {
          app: { name: "GitHub Actions" },
          conclusion: "failure",
          head_branch: "fix/cache-refresh",
          head_sha: headSha,
          id: 42,
          pull_requests: [
            {
              base: { ref: "main", repo: repositoryRef },
              head: {
                ref: "fix/cache-refresh",
                repo: repositoryRef,
                sha: headSha,
              },
              number: 691,
            },
          ],
        },
        repository,
      }),
      { onProgress: sendDuringFirstModelRequest([completeAuth("eval-auth")]) },
    );

    // The watch delivery finishes, then the paused turn does its lookup.
    expect(turnStates(both)).toEqual(["succeeded", "succeeded"]);
    expect(completedMcpToolCalls(BUDGET_ECHO, both)).toHaveLength(1);
  });
});
