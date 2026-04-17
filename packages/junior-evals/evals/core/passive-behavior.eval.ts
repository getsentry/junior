import { describe } from "vitest";
import { mention, rubric, slackEval, threadMessage } from "../helpers";

describe("Passive Behavior", () => {
  const sideConversationThread = {
    id: "thread-passive-side-conversation",
    channel_id: "C-passive-side-conversation",
    thread_ts: "17000000.passive-side-conversation",
  };

  slackEval("when a later question is human-to-human, stay out of the thread", {
    overrides: {
      reply_texts: [
        "The deploy changed the billing worker and the API auth flow.",
      ],
    },
    events: [
      mention(
        "Summarize this deploy in one sentence. It changed the billing worker and the API auth flow.",
        {
          thread: sideConversationThread,
        },
      ),
      threadMessage("@sam can you take the billing worker rollback?", {
        thread: sideConversationThread,
      }),
    ],
    criteria: rubric({
      contract:
        "A later human-to-human question is ignored even when it is phrased like something Junior could answer.",
      pass: [
        "The assistant posts exactly one reply: the initial helpful answer about the deploy.",
      ],
      fail: [
        "Do not answer the later question addressed to @sam about who should take the rollback.",
      ],
    }),
  });

  const directedFollowUpThread = {
    id: "thread-passive-directed-follow-up",
    channel_id: "C-passive-directed-follow-up",
    thread_ts: "17000000.passive-directed-follow-up",
  };

  slackEval(
    "when a follow-up is clearly directed at Junior's prior answer, reply without another @mention",
    {
      overrides: {
        reply_texts: ["You need the budget by Friday."],
      },
      events: [
        mention("I need the budget by Friday.", {
          thread: directedFollowUpThread,
        }),
        threadMessage("What did you just say about the budget?", {
          thread: directedFollowUpThread,
        }),
      ],
      criteria: rubric({
        contract:
          "A follow-up that clearly refers to Junior's prior answer gets a reply even without another @mention.",
        pass: [
          "The assistant posts exactly two replies in order.",
          "The second reply plainly restates that the budget is needed by Friday.",
        ],
      }),
    },
  );

  const casualPronounThread = {
    id: "thread-passive-casual-pronoun",
    channel_id: "C-passive-casual-pronoun",
    thread_ts: "17000000.passive-casual-pronoun",
  };

  slackEval(
    "when a casual pronoun question reads like coworker talk, stay out of the thread",
    {
      overrides: {
        reply_texts: [
          "The deploy changed the billing worker and the API auth flow.",
        ],
      },
      events: [
        mention(
          "Summarize this deploy in one sentence. It changed the billing worker and the API auth flow.",
          { thread: casualPronounThread },
        ),
        threadMessage("Is that the right approach?", {
          thread: casualPronounThread,
        }),
      ],
      criteria: rubric({
        contract:
          "A casual pronoun-based question stays ignored when it reads like human-to-human discussion rather than a turn back to Junior.",
        pass: [
          "The assistant posts exactly one reply: the initial helpful answer about the deploy.",
        ],
        fail: [
          "Do not reply to the later casual question 'Is that the right approach?'",
        ],
      }),
    },
  );

  const domainVocabThread = {
    id: "thread-passive-domain-vocab",
    channel_id: "C-passive-domain-vocab",
    thread_ts: "17000000.passive-domain-vocab",
  };

  slackEval(
    "when a later question only shares topic vocabulary, do not treat it as directed at Junior",
    {
      overrides: {
        reply_texts: [
          "The billing worker handles invoice processing and payment retries.",
        ],
      },
      events: [
        mention("What does the billing worker do?", {
          thread: domainVocabThread,
        }),
        threadMessage("What about the billing worker timeline?", {
          thread: domainVocabThread,
        }),
      ],
      criteria: rubric({
        contract:
          "Shared domain vocabulary alone does not make a later human discussion message directed at Junior.",
        pass: [
          "The assistant posts exactly one reply: the initial answer about the billing worker.",
        ],
        fail: [
          "Do not reply to the later question about the billing worker timeline.",
        ],
      }),
    },
  );

  const canYouThread = {
    id: "thread-passive-can-you",
    channel_id: "C-passive-can-you",
    thread_ts: "17000000.passive-can-you",
  };

  slackEval(
    "when 'can you' is directed at a coworker, stay out of the thread",
    {
      overrides: {
        reply_texts: ["Here's the deployment status."],
      },
      events: [
        mention("Show me the deployment status.", { thread: canYouThread }),
        threadMessage("Can you check on this?", { thread: canYouThread }),
      ],
      criteria: rubric({
        contract:
          "A casual 'can you' request is ignored when it is directed at a coworker, not at Junior.",
        pass: [
          "The assistant posts exactly one reply: the initial answer about deployment status.",
        ],
        fail: ["Do not reply to the later 'Can you check on this?' message."],
      }),
    },
  );

  const genuineFollowUpThread = {
    id: "thread-passive-genuine-follow-up",
    channel_id: "C-passive-genuine-follow-up",
    thread_ts: "17000000.passive-genuine-follow-up",
  };

  slackEval(
    "when the user explicitly asks Junior to elaborate, post a second reply",
    {
      overrides: {
        reply_texts: ["The deploy changed three services."],
      },
      events: [
        mention(
          "What changed in the last deploy? It updated the API gateway, billing worker, and auth service.",
          {
            thread: genuineFollowUpThread,
          },
        ),
        threadMessage("Can you explain your last response in more detail?", {
          thread: genuineFollowUpThread,
        }),
      ],
      criteria: rubric({
        contract:
          "An explicit request to expand Junior's prior answer gets a second reply.",
        pass: [
          "The assistant posts exactly two replies in order.",
          "The second reply provides more detail about the deploy changes.",
        ],
      }),
    },
  );

  const terseFollowUpThread = {
    id: "thread-passive-terse-follow-up",
    channel_id: "C-passive-terse-follow-up",
    thread_ts: "17000000.passive-terse-follow-up",
  };

  slackEval(
    "when a terse clarification comes right after Junior's answer, treat it as directed back to Junior",
    {
      overrides: {
        reply_texts: [
          "The deploy changed billing, auth, and the API gateway.",
          "The three services were billing, auth, and the API gateway.",
        ],
      },
      events: [
        mention("What changed in the deploy?", {
          thread: terseFollowUpThread,
        }),
        threadMessage("Which one?", {
          thread: terseFollowUpThread,
        }),
      ],
      criteria: rubric({
        contract:
          "A terse clarification right after Junior's reply is treated as directed back to Junior.",
        pass: [
          "The assistant posts exactly two replies in order.",
          "The second reply clarifies which services changed.",
        ],
      }),
    },
  );

  const humansTookFloorThread = {
    id: "thread-passive-humans-took-floor",
    channel_id: "C-passive-humans-took-floor",
    thread_ts: "17000000.passive-humans-took-floor",
  };

  slackEval(
    "when humans resume the thread, keep ignoring same-topic questions unless they turn back to Junior",
    {
      overrides: {
        reply_texts: ["The deploy changed billing, auth, and the API gateway."],
      },
      events: [
        mention("What changed in the deploy?", {
          thread: humansTookFloorThread,
        }),
        threadMessage("I think auth should roll back first.", {
          thread: humansTookFloorThread,
        }),
        threadMessage("What about the billing worker timeline?", {
          thread: humansTookFloorThread,
        }),
      ],
      criteria: rubric({
        contract:
          "Once humans resume the conversation, a later same-topic question stays ignored unless it clearly turns back to Junior.",
        pass: [
          "The assistant posts exactly one reply: the initial deploy summary.",
        ],
        fail: ["Do not answer the later billing worker timeline question."],
      }),
    },
  );

  const optOutThread = {
    id: "thread-opt-out",
    channel_id: "C-opt-out",
    thread_ts: "17000000.optout",
  };

  slackEval(
    "when the user says to stop participating, stay quiet until re-mentioned",
    {
      overrides: {
        reply_texts: [
          "I can help in this thread.",
          "I'm back because you mentioned me again.",
        ],
      },
      events: [
        mention("Can you help in this thread?", { thread: optOutThread }),
        threadMessage(
          "<@U_APP> stop watching or participating in this thread",
          {
            thread: optOutThread,
            is_mention: true,
          },
        ),
        mention("Actually jump back in.", { thread: optOutThread }),
      ],
      criteria: rubric({
        contract:
          "An explicit stop request pauses thread participation until the assistant is mentioned again.",
        pass: [
          "The assistant posts exactly three visible replies in order.",
          "The first reply is a normal helpful reply to the initial mention.",
          "The second reply briefly acknowledges that it will stay out of the thread unless mentioned again.",
          "The third reply appears only after the later direct mention.",
        ],
        fail: ["Do not treat the stop message like an ordinary help request."],
      }),
    },
  );
});
