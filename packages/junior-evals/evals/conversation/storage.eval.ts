import { describeEval, toolCalls } from "vitest-evals";
import { expect } from "vitest";
import { mention, rubric, slackEvals } from "../../src/helpers";

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
            source: "conversations",
          }),
        }),
        expect.objectContaining({
          name: "searchConversationMessages",
        }),
      ]),
    );
  });
});
