import { describe, expect } from "vitest";
import {
  slackMention,
  person,
  slackThreadMessage,
  webMessage,
} from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { savedAgentHistory } from "@junior-evals/fixture/saved-history";
import { sendDuringFirstModelRequest } from "@junior-evals/fixture/progress";
import { completedToolCalls } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// A plain reply keeps each turn to one model call. Routing is the behavior
// under test, not the summary.
const INCIDENT_REQUEST =
  "In two sentences, summarize the checkout outage: payments failed for 20 minutes after the 14:05 deploy.";

// A repository that the eval creates, and the AGENTS.md block Junior adds.
const NOTES_REPO = "/vercel/sandbox/repos/notes";
const AGENTS_MD_BLOCK = `# AGENTS.md instructions for ${NOTES_REPO}`;

// With passive routing, Junior can answer a thread message that has no
// mention. Without it, no such message starts a turn, so a check for "no
// turn" cannot fail.
const PASSIVE_ROUTING = { experimental: { "passive-routing": true } };

describe("Slack Turn Steering", () => {
  test("when the same person mentions Junior during a turn, the running turn takes the mention", async ({
    run,
  }) => {
    const conversation = await run(slackMention(INCIDENT_REQUEST), {
      onProgress: sendDuringFirstModelRequest([
        slackMention("include the rollback owner: Dana"),
      ]),
    });
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["A reply says Dana is the rollback owner."],
      }),
    );

    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
    expect(conversation.reactions).toContain("white_check_mark");
    // The transcript shows the steered mention.
    expect(
      conversation.session.events.filter(
        (event) => event.type === "message" && event.role === "user",
      ),
    ).toEqual([
      expect.objectContaining({ content: INCIDENT_REQUEST }),
      expect.objectContaining({
        content: "include the rollback owner: Dana",
      }),
    ]);
  });

  test("when a repository with AGENTS.md appears in the same step as a steered mention, the running turn takes the mention", async ({
    run,
  }) => {
    // The bash step adds a Git worktree with AGENTS.md. Junior adds the
    // AGENTS.md context and the steered mention at the same step boundary,
    // and every later checkpoint of the Turn must accept that order.
    const request = `Run this exact bash command once: \`mkdir -p ${NOTES_REPO} && cd ${NOTES_REPO} && git init -q && printf 'Keep notes short.\\n' > AGENTS.md\`. Then reply in one sentence that the repo exists.`;
    const conversation = await run(slackMention(request), {
      onProgress: sendDuringFirstModelRequest([
        slackMention("also say that Dana owns the rollback"),
      ]),
    });

    expect(completedToolCalls("bash", conversation)).not.toHaveLength(0);
    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
    expect(
      conversation.session.events.filter(
        (event) => event.type === "message" && event.role === "user",
      ),
    ).toEqual([
      expect.objectContaining({ content: request }),
      expect.objectContaining({
        content: "also say that Dana owns the rollback",
      }),
    ]);
    expect(conversation.replies.map((reply) => reply.text).join("\n")).toMatch(
      /Dana/,
    );
    // Saved history: the bash result, AGENTS.md, then the steered mention at
    // the same boundary. Later steps may run before the final reply.
    const history = await savedAgentHistory(conversation.conversationId);
    const agentsAt = history.findIndex(
      (item) =>
        item.type === "user_message" && item.text.startsWith(AGENTS_MD_BLOCK),
    );
    expect(agentsAt).toBeGreaterThan(0);
    expect(history.slice(agentsAt - 1, agentsAt + 2)).toEqual([
      expect.objectContaining({ type: "tool_result", toolName: "bash" }),
      expect.objectContaining({
        type: "user_message",
        text: expect.stringContaining("Keep notes short."),
      }),
      expect.objectContaining({
        type: "user_message",
        text: expect.stringContaining("also say that Dana owns the rollback"),
      }),
    ]);
    expect(history.at(-1)).toEqual(
      expect.objectContaining({
        type: "assistant_message",
        text: expect.stringContaining("Dana"),
      }),
    );
  });

  test("when other people mention Junior during a turn, each person gets a follow-up turn, even with !!", async ({
    run,
  }) => {
    // Only routing is asserted, so the inputs are manufactured and short.
    const shortReply = (word: string) => `Reply with only the word ${word}.`;
    const conversation = await run(
      slackMention(shortReply("ready"), { author: person("U0SAM", "Sam") }),
      {
        onProgress: sendDuringFirstModelRequest([
          slackMention(shortReply("one"), { author: person("U0RIO", "Rio") }),
          slackMention(shortReply("two"), { author: person("U0RIO", "Rio") }),
          slackMention(shortReply("three"), { author: person("U0KAI", "Kai") }),
          slackMention(shortReply("four"), { author: person("U0RIO", "Rio") }),
          slackMention(`!! ${shortReply("go")}`, {
            author: person("U0ALEX", "Alex"),
          }),
        ]),
      },
    );

    // Sam's turn, then Rio, Kai, Rio again, and Alex in arrival order. The
    // running turn uses Sam's credentials, so !! does not let Alex join it.
    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    // Each person whose mention got its own turn joins the conversation.
    expect(conversation.participantSlackUserIds).toEqual(
      expect.arrayContaining(["U0SAM", "U0RIO", "U0KAI", "U0ALEX"]),
    );
  });

  test("when a thread message needs no reply, Junior consumes it without a turn", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const conversation = await run(slackMention(INCIDENT_REQUEST));
    expect(conversation.replies.length).toBeGreaterThan(0);

    const next = await conversation.continue(
      slackThreadMessage("thanks, sounds good"),
    );
    expect(next.turns).toEqual([]);
    expect(next.replies).toEqual([]);
    expect(next.reactions).toEqual([]);
  });

  test("when someone says stop during a turn, Junior stops the turn until a later mention", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const conversation = await run(slackMention(INCIDENT_REQUEST), {
      // The mention waits for a follow-up turn; the stop discards it.
      onProgress: sendDuringFirstModelRequest([
        slackMention("also list the affected regions"),
        slackThreadMessage("stop"),
      ]),
    });

    expect(conversation.turns.map((turn) => turn.status)).toEqual(["no_reply"]);
    expect(conversation.replies.map((reply) => reply.text)).toEqual([
      "Stopped.",
    ]);
    expect(conversation.reactions).not.toContain("white_check_mark");

    // The stop keeps the thread, so a later mention starts a Turn again.
    const next = await conversation.continue(
      slackMention("Reply with only the word ready."),
    );
    expect(next.turns.map((turn) => turn.status)).toEqual(["succeeded"]);
  });
});

describe("Dashboard Turn Steering", () => {
  test("when the author steers a queued dashboard message, the running turn takes it", async ({
    run,
  }) => {
    const conversation = await run(webMessage(INCIDENT_REQUEST), {
      onProgress: sendDuringFirstModelRequest([
        webMessage("include the rollback owner: Dana", { steer: true }),
      ]),
    });
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The summary names Dana as the rollback owner."],
      }),
    );

    // Without the steer, the queued message would wait for its own turn.
    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
    ]);
    expect(
      conversation.session.events.filter(
        (event) => event.type === "message" && event.role === "user",
      ),
    ).toEqual([
      expect.objectContaining({ content: INCIDENT_REQUEST }),
      expect.objectContaining({
        content: "include the rollback owner: Dana",
      }),
    ]);
  });

  test("when the author sends dashboard messages during a turn, one follow-up turn takes them and the transcript keeps each", async ({
    run,
  }) => {
    // Only batching is asserted, so the inputs are short.
    const conversation = await run(
      webMessage("Reply with only the word ready."),
      {
        onProgress: sendDuringFirstModelRequest([
          webMessage("Reply with only the word one."),
          webMessage("Reply with only the word two."),
        ]),
      },
    );

    // Both queued messages wait for the same follow-up turn.
    expect(conversation.turns.map((turn) => turn.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    // That turn gets both messages, but each stays its own user message.
    expect(
      conversation.session.events.filter(
        (event) => event.type === "message" && event.role === "user",
      ),
    ).toEqual([
      expect.objectContaining({ content: "Reply with only the word ready." }),
      expect.objectContaining({ content: "Reply with only the word one." }),
      expect.objectContaining({ content: "Reply with only the word two." }),
    ]);
  });
});
