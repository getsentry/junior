import { describe, expect } from "vitest";
import {
  mention,
  person,
  reply,
  threadMessage,
} from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test } from "@junior-evals/fixture/test";

const SAM = person("USAM", "Sam");
const ALEX = person("UALEX", "Alex");

// Junior replies to a thread message without a mention only when passive
// routing is on. Production leaves it off by default.
const PASSIVE_ROUTING = { experimental: { "passive-routing": true } };

// Every case loads the exchange that made Junior a thread participant as
// history, so the replies of a call are the replies Junior posts in the
// scenario itself.
describe("Passive Behavior", () => {
  test("when a later question is human-to-human, stay out of the thread", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const conversation = await run(
      threadMessage("@sam can you take the billing worker rollback?"),
      {
        history: [
          mention(
            "Summarize this deploy in one sentence. It changed the billing worker and the API auth flow.",
          ),
          reply("The deploy changed the billing worker and the API auth flow."),
        ],
      },
    );

    expect(conversation.replies).toHaveLength(0);
  });

  test("when a follow-up is clearly directed at Junior's prior answer, reply without another @mention", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const conversation = await run(
      threadMessage("What did you just say about the budget?"),
      {
        history: [
          mention("I need the budget by Friday."),
          reply("You need the budget by Friday."),
        ],
      },
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply plainly restates that the budget is needed by Friday.",
        ],
      }),
    );

    expect(conversation.replies).toHaveLength(1);
    // A thread message gets the processing reaction only when Junior takes it.
    expect(conversation.reactions).toEqual(["eyes", "white_check_mark"]);
  });

  test("when a casual pronoun question reads like coworker talk, stay out of the thread", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const statement = await run(
      threadMessage("Alex, I plan to roll back the billing worker first.", {
        author: SAM,
      }),
      {
        history: [
          mention(
            "Summarize this deploy in one sentence. It changed the billing worker and the API auth flow.",
          ),
          reply("The deploy changed the billing worker and the API auth flow."),
        ],
      },
    );
    const question = await statement.continue(
      threadMessage("Is that the right approach?", { author: SAM }),
    );

    expect([...statement.replies, ...question.replies]).toHaveLength(0);
  });

  test("when a later question only shares topic vocabulary, do not treat it as directed at Junior", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const statement = await run(
      threadMessage("Sam, I can finish the API rollout tomorrow.", {
        author: ALEX,
      }),
      {
        history: [
          mention("What does the billing worker do?"),
          reply(
            "The billing worker handles invoice processing and payment retries.",
          ),
        ],
      },
    );
    const question = await statement.continue(
      threadMessage("What about the billing worker timeline?", { author: SAM }),
    );

    expect([...statement.replies, ...question.replies]).toHaveLength(0);
  });

  test("when 'can you' is directed at a coworker, stay out of the thread", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const statement = await run(
      threadMessage("Alex, my deployment is still queued.", { author: SAM }),
      {
        history: [
          mention("Show me the deployment status."),
          reply("Here's the deployment status."),
        ],
      },
    );
    const question = await statement.continue(
      threadMessage("Can you check on this?", { author: SAM }),
    );

    expect([...statement.replies, ...question.replies]).toHaveLength(0);
  });

  test("when the user explicitly asks Junior to elaborate, post a second reply", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const conversation = await run(
      threadMessage("Can you explain your last response in more detail?"),
      {
        history: [
          mention(
            "What changed in the last deploy? The API gateway gained request timeouts, the billing worker now backs off failed payment retries, and the auth service refreshes expired sessions.",
          ),
          reply("The deploy changed three services."),
        ],
      },
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply expands the summary using the supplied changes: request timeouts, payment retry backoff, and session refresh. It does not invent other changes.",
        ],
      }),
    );

    expect(conversation.replies).toHaveLength(1);
  });

  test("when a terse clarification comes right after Junior's answer, treat it as directed back to Junior", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const conversation = await run(threadMessage("Which one?"), {
      history: [
        mention("What changed in the deploy?"),
        reply("The deploy changed billing, auth, and the API gateway."),
      ],
    });

    expect(conversation.replies).toHaveLength(1);
  });

  test("when humans resume the thread, keep ignoring same-topic questions unless they turn back to Junior", async ({
    agent,
  }) => {
    const { run } = await agent(PASSIVE_ROUTING);
    const statement = await run(
      threadMessage("Sam, I think auth should roll back first.", {
        author: ALEX,
      }),
      {
        history: [
          mention("What changed in the deploy?"),
          reply("The deploy changed billing, auth, and the API gateway."),
        ],
      },
    );
    const question = await statement.continue(
      threadMessage("What about the billing worker timeline?", { author: SAM }),
    );

    expect([...statement.replies, ...question.replies]).toHaveLength(0);
  });
});
