import { describeEval } from "vitest-evals";
import { expect } from "vitest";
import {
  mention,
  rubric,
  slackEvals,
  threadMessage,
  visibleThreadReplies,
} from "../../src/helpers";

describeEval("Passive Behavior", slackEvals, (it) => {
  const sideConversationThread = {
    id: "thread-passive-side-conversation",
    channel_id: "CPASSIVESIDECONVERSATION",
    thread_ts: "17000000.1201",
  };

  it("when a later question is human-to-human, stay out of the thread", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: [
          "The deploy changed the billing worker and the API auth flow.",
        ],
      },
      initialEvents: [
        mention(
          "Summarize this deploy in one sentence. It changed the billing worker and the API auth flow.",
          {
            thread: sideConversationThread,
          },
        ),
      ],
      events: [
        threadMessage("@sam can you take the billing worker rollback?", {
          thread: sideConversationThread,
        }),
      ],
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  const directedFollowUpThread = {
    id: "thread-passive-directed-follow-up",
    channel_id: "CPASSIVEDIRECTEDFOLLOWUP",
    thread_ts: "17000000.1202",
  };

  it("when a follow-up is clearly directed at Junior's prior answer, reply without another @mention", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: ["You need the budget by Friday."],
      },
      initialEvents: [
        mention("I need the budget by Friday.", {
          thread: directedFollowUpThread,
        }),
      ],
      events: [
        threadMessage("What did you just say about the budget?", {
          thread: directedFollowUpThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The second reply plainly restates that the budget is needed by Friday.",
        ],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(2);
  });

  const casualPronounThread = {
    id: "thread-passive-casual-pronoun",
    channel_id: "CPASSIVECASUALPRONOUN",
    thread_ts: "17000000.1203",
  };

  it("when a casual pronoun question reads like coworker talk, stay out of the thread", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: [
          "The deploy changed the billing worker and the API auth flow.",
        ],
      },
      initialEvents: [
        mention(
          "Summarize this deploy in one sentence. It changed the billing worker and the API auth flow.",
          { thread: casualPronounThread },
        ),
      ],
      events: [
        threadMessage("Is that the right approach?", {
          thread: casualPronounThread,
        }),
      ],
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  const domainVocabThread = {
    id: "thread-passive-domain-vocab",
    channel_id: "CPASSIVEDOMAINVOCAB",
    thread_ts: "17000000.1204",
  };

  it("when a later question only shares topic vocabulary, do not treat it as directed at Junior", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: [
          "The billing worker handles invoice processing and payment retries.",
        ],
      },
      initialEvents: [
        mention("What does the billing worker do?", {
          thread: domainVocabThread,
        }),
      ],
      events: [
        threadMessage("What about the billing worker timeline?", {
          thread: domainVocabThread,
        }),
      ],
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  const canYouThread = {
    id: "thread-passive-can-you",
    channel_id: "CPASSIVECANYOU",
    thread_ts: "17000000.1205",
  };

  it("when 'can you' is directed at a coworker, stay out of the thread", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: ["Here's the deployment status."],
      },
      initialEvents: [
        mention("Show me the deployment status.", { thread: canYouThread }),
      ],
      events: [
        threadMessage("Can you check on this?", { thread: canYouThread }),
      ],
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });

  const genuineFollowUpThread = {
    id: "thread-passive-genuine-follow-up",
    channel_id: "CPASSIVEGENUINEFOLLOWUP",
    thread_ts: "17000000.1206",
  };

  it("when the user explicitly asks Junior to elaborate, post a second reply", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: ["The deploy changed three services."],
      },
      initialEvents: [
        mention(
          "What changed in the last deploy? It updated the API gateway, billing worker, and auth service.",
          {
            thread: genuineFollowUpThread,
          },
        ),
      ],
      events: [
        threadMessage("Can you explain your last response in more detail?", {
          thread: genuineFollowUpThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The second reply provides more detail about the deploy changes.",
        ],
      }),
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(2);
  });

  const terseFollowUpThread = {
    id: "thread-passive-terse-follow-up",
    channel_id: "CPASSIVETERSEFOLLOWUP",
    thread_ts: "17000000.1207",
  };

  it("when a terse clarification comes right after Junior's answer, treat it as directed back to Junior", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: [
          "The deploy changed billing, auth, and the API gateway.",
          "The three services were billing, auth, and the API gateway.",
        ],
      },
      initialEvents: [
        mention("What changed in the deploy?", {
          thread: terseFollowUpThread,
        }),
      ],
      events: [
        threadMessage("Which one?", {
          thread: terseFollowUpThread,
        }),
      ],
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(2);
  });

  const humansTookFloorThread = {
    id: "thread-passive-humans-took-floor",
    channel_id: "CPASSIVEHUMANSTOOKFLOOR",
    thread_ts: "17000000.1208",
  };

  it("when humans resume the thread, keep ignoring same-topic questions unless they turn back to Junior", async ({
    run,
  }) => {
    const result = await run({
      overrides: {
        reply_texts: ["The deploy changed billing, auth, and the API gateway."],
      },
      initialEvents: [
        mention("What changed in the deploy?", {
          thread: humansTookFloorThread,
        }),
      ],
      events: [
        threadMessage("I think auth should roll back first.", {
          thread: humansTookFloorThread,
        }),
        threadMessage("What about the billing worker timeline?", {
          thread: humansTookFloorThread,
        }),
      ],
    });

    expect(visibleThreadReplies(result.session)).toHaveLength(1);
  });
});
