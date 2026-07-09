import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  agentSteps,
  conversationMessages,
  mention,
  rubric,
  slackEvals,
} from "../../src/helpers";

describeEval("Conversation Storage", slackEvals, (it) => {
  it("when a user asks a simple question, the turn's messages persist to the SQL stores", async ({
    run,
  }) => {
    const userText =
      "What is the capital of France? Answer in one short sentence.";
    const result = await run({
      events: [mention(userText)],
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
});
