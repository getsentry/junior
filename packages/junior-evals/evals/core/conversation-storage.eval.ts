import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import {
  conversationEvents,
  conversationMessages,
  mention,
  rubric,
  slackEvals,
  threadMessage,
} from "../../src/helpers";

describeEval("Conversation Storage", slackEvals, (it) => {
  it("when asked about an earlier public thread in the same workspace, search stored conversation history", async ({
    run,
  }) => {
    const priorThread = {
      id: "thread-conversation-search-prior",
      channel_id: "CCONVERSATIONSEARCHPRIOR",
      channel_type: "channel" as const,
      thread_ts: "17000000.688001",
    };
    const currentThread = {
      id: "thread-conversation-search-current",
      channel_id: "CCONVERSATIONSEARCHCURRENT",
      channel_type: "channel" as const,
      thread_ts: "17000000.688002",
    };
    const result = await run({
      initialEvents: [
        mention(
          "Record this decision for our launch: the rollback owner is Priya.",
          { thread: priorThread },
        ),
      ],
      events: [
        mention(
          "Who did we name as the rollback owner in the earlier thread?",
          {
            thread: currentThread,
          },
        ),
      ],
      requireSandboxReady: false,
      criteria: rubric({
        pass: [
          "The assistant answers that Priya was named as the rollback owner.",
          "The answer is based on a search of the earlier public Junior conversation in the same Slack workspace.",
        ],
        fail: [
          "Do not claim the earlier decision is unavailable.",
          "Do not ask the user to paste the earlier thread.",
        ],
      }),
    });

    expect(toolCalls(result.session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "searchTools",
          arguments: expect.objectContaining({
            source: "conversation-history",
          }),
        }),
        expect.objectContaining({
          name: "searchConversationHistory",
        }),
      ]),
    );
  });

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

    // (a) The durable event history holds the turn's user and assistant
    // Message events in the current (highest) epoch, in seq order.
    const events = await conversationEvents(result.session);
    const currentEpoch = Math.max(...events.map((event) => event.contextEpoch));
    const currentMessages = events.filter(
      (event) =>
        event.data.type === "message" && event.contextEpoch === currentEpoch,
    );

    const firstUser = currentMessages.find(
      (event) =>
        event.data.type === "message" && event.data.message.role === "user",
    );
    const firstAssistant = currentMessages.find(
      (event) =>
        event.data.type === "message" &&
        event.data.message.role === "assistant",
    );
    expect(firstUser).toBeDefined();
    expect(firstAssistant).toBeDefined();
    expect(firstUser!.seq).toBeLessThan(firstAssistant!.seq);
    // seq order is preserved by loadHistory; the filtered slice stays ascending.
    const seqs = currentMessages.map((event) => event.seq);
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
  // durable `mcp_provider_connected` event recorded on the first turn must be
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

    // (1) The durable event history records the provider connection exactly once
    // for the whole conversation. A lost turn-1 fact forces a second connection
    // on turn 2; a duplicated fact signals a re-connect.
    const events = await conversationEvents(result.session);
    const connectedEvents = events.filter(
      (event) =>
        event.data.type === "mcp_provider_connected" &&
        event.data.provider === EVAL_MCP_PROVIDER,
    );
    expect(connectedEvents).toHaveLength(1);

    // (2) No re-authorization after the connection: any `authorization_requested`
    // event ordered after the first connection means the follow-up re-prompted.
    const firstConnectSeq = connectedEvents[0]!.seq;
    const authAfterConnect = events.filter(
      (event) =>
        event.data.type === "authorization_requested" &&
        event.seq > firstConnectSeq,
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
