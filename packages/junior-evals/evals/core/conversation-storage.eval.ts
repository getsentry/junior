import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  agentSteps,
  conversationMessages,
  mention,
  rubric,
  slackEvals,
  threadMessage,
} from "../../src/helpers";

describeEval("Conversation Storage", slackEvals, (it) => {
  it("when a user asks a simple question, the turn's messages persist to the SQL stores", async ({
    run,
  }) => {
    const userText =
      "What is the capital of France? Answer in one short sentence.";
    const result = await run({
      initialEvents: [mention(userText)],
      requireSandboxReady: false,
      criteria: rubric({
        pass: ["The assistant posts one reply that names Paris."],
      }),
    });

    // (a) The durable step history holds the turn's user and assistant
    // pi_message rows in the current (highest) epoch, in seq order.
    const steps = await agentSteps(result.session);
    const currentEpoch = Math.max(...steps.map((step) => step.contextEpoch));
    const currentPiMessages = steps.filter(
      (step) =>
        step.type === "pi_message" && step.contextEpoch === currentEpoch,
    );

    const firstUser = currentPiMessages.find((step) => step.role === "user");
    const firstAssistant = currentPiMessages.find(
      (step) => step.role === "assistant",
    );
    expect(firstUser).toBeDefined();
    expect(firstAssistant).toBeDefined();
    expect(firstUser!.seq).toBeLessThan(firstAssistant!.seq);
    // seq order is preserved by loadHistory; the filtered slice stays ascending.
    const seqs = currentPiMessages.map((step) => step.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));

    // (b) The visible message transcript holds the user message and the
    // assistant reply with the correct roles.
    const messages = await conversationMessages(result.session);
    const userMessage = messages.find(
      (message) => message.role === "user" && message.text === userText,
    );
    const assistantMessage = messages.find(
      (message) => message.role === "assistant" && message.text.trim() !== "",
    );
    expect(userMessage).toBeDefined();
    expect(assistantMessage).toBeDefined();
  });

  // Regression guard for lost MCP provider-connection facts between turns. A
  // durable `mcp_provider_connected` step recorded on the first turn must be
  // visible to the follow-up turn so an already-connected provider is reused
  // instead of re-authorized. (The concrete bug: a projection reader that
  // skipped the lazy legacy import missed a prior connection and re-prompted.)
  const EVAL_MCP_PROVIDER = "eval-auth";
  const providerReuseThread = {
    id: "thread-mcp-provider-reuse",
    channel_id: "CMCPREUSE",
    thread_ts: "17000000.mcp-reuse",
  };

  // Skipped pending a pre-existing MCP auth-link delivery failure that also
  // breaks the reference MCP-pause case in oauth-workflows.eval.ts on main
  // (verified 2026-07-09 on origin/main: deliverPrivateMessage never posts the
  // ephemeral link and falls through to conversations.open, which the Slack
  // MSW harness rejects). Unskip together with that case once delivery works.
  it.skip("when a follow-up needs the same MCP provider, reuse the stored connection without re-authorizing", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        auto_complete_mcp_oauth: [EVAL_MCP_PROVIDER],
        plugin_dirs: ["fixtures/plugins"],
      },
      initialEvents: [
        threadMessage(
          "<@U_APP> /eval-auth Use the demo MCP connection to check our current budget status.",
          { thread: providerReuseThread, is_mention: true },
        ),
      ],
      events: [
        threadMessage(
          "<@U_APP> /eval-auth Using that same connection, check the budget status one more time.",
          { thread: providerReuseThread, is_mention: true },
        ),
      ],
      criteria: rubric({
        pass: [
          "The first request connects the eval MCP provider and answers.",
          "The second request answers using the already-connected provider.",
          "Because the eval harness auto-completes MCP authorization off-transcript, treat a later same-thread answer that uses the provider as evidence the stored connection was reused.",
        ],
        fail: [
          "The assistant asks the user to authorize, connect, or re-connect the provider on the second turn.",
          "Do not post the authorization URL in the public thread.",
        ],
      }),
    });

    // (1) The durable step history records the provider connection exactly once
    // for the whole conversation. A lost turn-1 fact forces a second connection
    // on turn 2; a duplicated fact signals a re-connect.
    const steps = await agentSteps(result.session);
    const connectedSteps = steps.filter(
      (step) =>
        step.entry.type === "mcp_provider_connected" &&
        step.entry.provider === EVAL_MCP_PROVIDER,
    );
    expect(connectedSteps).toHaveLength(1);

    // (2) No re-authorization after the connection: any `authorization_requested`
    // step ordered after the first connection means the follow-up re-prompted.
    const firstConnectSeq = connectedSteps[0]!.seq;
    const authAfterConnect = steps.filter(
      (step) =>
        step.entry.type === "authorization_requested" &&
        step.seq > firstConnectSeq,
    );
    expect(authAfterConnect).toEqual([]);

    // (3) The follow-up turn completed: its assistant reply landed in the
    // durable visible transcript after the second user message.
    const messages = await conversationMessages(result.session);
    const secondUserIndex = messages.findIndex(
      (message) =>
        message.role === "user" && message.text.includes("one more time"),
    );
    expect(secondUserIndex).toBeGreaterThanOrEqual(0);
    const followUpReply = messages
      .slice(secondUserIndex + 1)
      .find(
        (message) => message.role === "assistant" && message.text.trim() !== "",
      );
    expect(followUpReply).toBeDefined();
  });
});
