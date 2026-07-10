import { describeEval } from "vitest-evals";
import { mention, rubric, slackEvals, threadMessage } from "../../src/helpers";

describeEval("Passive Behavior", slackEvals, (it) => {
  const sideConversationThread = {
    id: "thread-passive-side-conversation",
    channel_id: "CPASSIVESIDECONVERSATION",
    thread_ts: "17000000.1201",
  };

  it("when a later question is human-to-human, stay out of the thread", async ({
    run,
  }) => {
    await run({
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
      criteria: rubric({
        pass: [
          "The assistant posts exactly one reply: the initial helpful answer about the deploy.",
        ],
        fail: [
          "Do not answer the later question addressed to @sam about who should take the rollback.",
        ],
      }),
    });
  });

  const directedFollowUpThread = {
    id: "thread-passive-directed-follow-up",
    channel_id: "CPASSIVEDIRECTEDFOLLOWUP",
    thread_ts: "17000000.1202",
  };

  it("when a follow-up is clearly directed at Junior's prior answer, reply without another @mention", async ({
    run,
  }) => {
    await run({
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
          "The assistant posts exactly two replies in order.",
          "The second reply plainly restates that the budget is needed by Friday.",
        ],
      }),
    });
  });

  const casualPronounThread = {
    id: "thread-passive-casual-pronoun",
    channel_id: "CPASSIVECASUALPRONOUN",
    thread_ts: "17000000.1203",
  };

  it("when a casual pronoun question reads like coworker talk, stay out of the thread", async ({
    run,
  }) => {
    await run({
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
      criteria: rubric({
        pass: [
          "The assistant posts exactly one reply: the initial helpful answer about the deploy.",
        ],
        fail: [
          "Do not reply to the later casual question 'Is that the right approach?'",
        ],
      }),
    });
  });

  const domainVocabThread = {
    id: "thread-passive-domain-vocab",
    channel_id: "CPASSIVEDOMAINVOCAB",
    thread_ts: "17000000.1204",
  };

  it("when a later question only shares topic vocabulary, do not treat it as directed at Junior", async ({
    run,
  }) => {
    await run({
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
      criteria: rubric({
        pass: [
          "The assistant posts exactly one reply: the initial answer about the billing worker.",
        ],
        fail: [
          "Do not reply to the later question about the billing worker timeline.",
        ],
      }),
    });
  });

  const canYouThread = {
    id: "thread-passive-can-you",
    channel_id: "CPASSIVECANYOU",
    thread_ts: "17000000.1205",
  };

  it("when 'can you' is directed at a coworker, stay out of the thread", async ({
    run,
  }) => {
    await run({
      overrides: {
        reply_texts: ["Here's the deployment status."],
      },
      initialEvents: [
        mention("Show me the deployment status.", { thread: canYouThread }),
      ],
      events: [
        threadMessage("Can you check on this?", { thread: canYouThread }),
      ],
      criteria: rubric({
        pass: [
          "The assistant posts exactly one reply: the initial answer about deployment status.",
        ],
        fail: ["Do not reply to the later 'Can you check on this?' message."],
      }),
    });
  });

  const genuineFollowUpThread = {
    id: "thread-passive-genuine-follow-up",
    channel_id: "CPASSIVEGENUINEFOLLOWUP",
    thread_ts: "17000000.1206",
  };

  it("when the user explicitly asks Junior to elaborate, post a second reply", async ({
    run,
  }) => {
    await run({
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
          "The assistant posts exactly two replies in order.",
          "The second reply provides more detail about the deploy changes.",
        ],
      }),
    });
  });

  const terseFollowUpThread = {
    id: "thread-passive-terse-follow-up",
    channel_id: "CPASSIVETERSEFOLLOWUP",
    thread_ts: "17000000.1207",
  };

  it("when a terse clarification comes right after Junior's answer, treat it as directed back to Junior", async ({
    run,
  }) => {
    await run({
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
      criteria: rubric({
        pass: [
          "The assistant posts exactly two replies in order.",
          "The second reply clarifies which services changed.",
        ],
      }),
    });
  });

  const humansTookFloorThread = {
    id: "thread-passive-humans-took-floor",
    channel_id: "CPASSIVEHUMANSTOOKFLOOR",
    thread_ts: "17000000.1208",
  };

  it("when humans resume the thread, keep ignoring same-topic questions unless they turn back to Junior", async ({
    run,
  }) => {
    await run({
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
      criteria: rubric({
        pass: [
          "The assistant posts exactly one reply: the initial deploy summary.",
        ],
        fail: ["Do not answer the later billing worker timeline question."],
      }),
    });
  });

  const optOutThread = {
    id: "thread-opt-out",
    channel_id: "COPTOUT",
    thread_ts: "17000000.1209",
  };

  it("when the user says to stop participating, stay quiet until re-mentioned", async ({
    run,
  }) => {
    await run({
      overrides: {
        reply_texts: [
          "I can help in this thread.",
          "I'm back because you mentioned me again.",
        ],
      },
      initialEvents: [
        mention("Can you help in this thread?", { thread: optOutThread }),
      ],
      events: [
        threadMessage("Stop watching or participating in this thread", {
          thread: optOutThread,
          is_mention: true,
        }),
        mention("Actually jump back in.", { thread: optOutThread }),
      ],
      criteria: rubric({
        pass: [
          "The assistant posts exactly three visible replies in order.",
          "The first reply is a normal helpful reply to the initial mention.",
          "The second reply briefly acknowledges that it will stay out of the thread unless mentioned again.",
          "The third reply appears only after the later direct mention.",
        ],
        fail: ["Do not treat the stop message like an ordinary help request."],
      }),
    });
  });
});
