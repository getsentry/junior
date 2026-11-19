import { describe, expect } from "vitest";
import {
  person,
  reply,
  slackMention,
  slackThreadMessage,
} from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { test, type Conversation } from "@junior-evals/fixture/test";
import { mockWebSearchResults } from "@junior-evals/fixture/web";

describe("Output Contract", () => {
  test("when asked for a structured overview, avoid hash markdown headings", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Give me a short overview of how OAuth 2.0 authorization code flow works. Cover the authorization request, token exchange, and refresh. Keep it to a few short sections.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant posts one reply that covers the authorization request, token exchange, and refresh.",
          "No section label line starts with `#`, `##`, or `###`.",
        ],
        fail: [
          "Do not use lines beginning with `#`, `##`, or `###` for section labels.",
          "Do not paste a hash-heading line like `# Authorization Request` at the start of a section.",
        ],
      }),
    );
  });

  test("when asked for documentation, link to each official starting page", async ({
    run,
  }) => {
    mockWebSearchResults([
      {
        title: "Using the Slack Web API",
        url: "https://docs.slack.dev/apis/web-api/",
        excerpt:
          "The Web API is a collection of HTTP methods that underpin the majority of Slack app functionality.",
      },
      {
        title: "Bolt for JavaScript",
        url: "https://docs.slack.dev/tools/bolt-js/",
        excerpt:
          "Bolt for JavaScript is a framework for building Slack apps with JavaScript and TypeScript.",
      },
      {
        title: "Block Kit",
        url: "https://docs.slack.dev/block-kit/",
        excerpt:
          "Block Kit is a UI framework for Slack apps, built with blocks, block elements, and composition objects.",
      },
    ]);
    const conversation = await run(
      slackMention(
        "Where can I find the official documentation for the Slack Web API, Slack Bolt JS, and Slack Block Kit? Just point me at the three canonical starting pages.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant posts one reply that names the three documentation starting points.",
          "Each starting point includes a link to the corresponding official Slack documentation. Descriptive labels, URL labels, and bare URLs are all acceptable.",
        ],
        fail: [
          "Do not omit a requested documentation link or substitute an unofficial site.",
        ],
      }),
    );
  });

  test("when asked to compare two options, use a well-formed table or bullets", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "Give me a short comparison of REST and GraphQL across these three dimensions: caching, over-fetching, and tooling maturity. Keep it tight.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant posts one reply that compares REST and GraphQL across caching, over-fetching, and tooling maturity.",
          "The comparison is a Markdown table or bullets with short explanations. A table has one header row, a dashed delimiter row, and one row per dimension, with no blank lines between rows.",
        ],
        fail: [
          "Do not put the table inside a fenced code block.",
          "Do not write a table with more than four columns or with cells longer than one short sentence.",
        ],
      }),
    );
  });
});

// Production runs Opus 5.5, whose default replies run long. These cases pin
// it so they measure what people read in Slack.
const PRODUCTION_MODEL_ID = "anthropic/claude-opus-5.5";

/** Words that people read in the replies of a call, without code blocks. */
function proseWordCount(conversation: Conversation): number {
  return conversation.replies
    .map((item) => item.text.replace(/```[\s\S]*?```/g, " "))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Lines of the replies that start with a bold label, such as `**Why:**`. */
function boldLabelLines(conversation: Conversation): string[] {
  return conversation.replies
    .flatMap((item) => item.text.split("\n"))
    .filter((line) => /^\s*(?:[-*]\s+)?\*\*[^*]+\*\*/.test(line));
}

// None of these requests asks for a length. The reply length must come from
// Junior's defaults, the way a teammate answers in Slack.
describe("Reply Length", () => {
  test("when asked a simple question, answer in a few sentences", async ({
    agent,
  }) => {
    const { run } = await agent({ modelId: PRODUCTION_MODEL_ID });
    const conversation = await run(
      slackMention("what's the difference between git fetch and git pull?"),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says that fetch downloads remote changes without changing the working branch, and that pull also merges or rebases them into it.",
        ],
        fail: ["Do not give a wrong description of either command."],
      }),
    );
    expect(proseWordCount(conversation)).toBeLessThanOrEqual(80);
    expect(boldLabelLines(conversation)).toEqual([]);
  });

  test("when asked a yes-or-no follow-up, answer it in one or two sentences", async ({
    agent,
  }) => {
    const { run } = await agent({ modelId: PRODUCTION_MODEL_ID });
    const conversation = await run(
      slackMention("so is that the same as no-store?"),
      {
        history: [
          slackMention("what does `Cache-Control: no-cache` do?"),
          reply(
            "It lets a cache store the response, but the cache must revalidate it with the origin before each reuse.",
          ),
        ],
      },
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says no, and that no-store forbids storing the response at all.",
        ],
        fail: ["Do not say that no-cache and no-store are the same."],
      }),
    );
    expect(proseWordCount(conversation)).toBeLessThanOrEqual(50);
    expect(boldLabelLines(conversation)).toEqual([]);
  });

  test("when a request leaves a small choice open, deliver without a report around it", async ({
    agent,
  }) => {
    const { run } = await agent({ modelId: PRODUCTION_MODEL_ID });
    const conversation = await run(
      slackMention(
        "need a regex that matches a semver version string for a CI check",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply gives one regular expression that matches versions such as 1.2.3.",
        ],
        fail: [
          "Do not ask which semver variant the person wants before giving a regex.",
        ],
      }),
    );
    expect(proseWordCount(conversation)).toBeLessThanOrEqual(80);
    expect(boldLabelLines(conversation)).toEqual([]);
  });

  test("when asked for a recommendation, give it and the main reason", async ({
    agent,
  }) => {
    const { run } = await agent({ modelId: PRODUCTION_MODEL_ID });
    const conversation = await run(
      slackMention(
        "for the new billing tables, should we use uuidv7 or bigint ids?",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply recommends one of the two options and gives a reason.",
        ],
        fail: ["Do not avoid a recommendation."],
      }),
    );
    expect(proseWordCount(conversation)).toBeLessThanOrEqual(100);
    expect(boldLabelLines(conversation)).toEqual([]);
  });

  test("when a long debugging thread reaches the fix, answer the last question without recapping the thread", async ({
    agent,
  }) => {
    const alice = person("U0ALICE", "Alice");
    const bob = person("U0BOB", "Bob");
    const { run } = await agent({ modelId: PRODUCTION_MODEL_ID });
    const conversation = await run(
      slackMention("cool, what do I need to change to unblock the deploy?", {
        author: alice,
      }),
      {
        history: [
          slackMention(
            "the payments-api deploy to prod failed at the canary step again, can you look at why?",
            { author: alice },
          ),
          reply(
            "The canary pods crash on startup, so the health check on :8080 never passes. The log shows `Error: missing required env var STRIPE_WEBHOOK_SECRET` right before each exit.",
            {
              toolHistory: [
                {
                  name: "bash",
                  arguments: {
                    command: "tail -n 40 deploys/payments-api/7742/canary.log",
                  },
                  result: {
                    exit_code: 0,
                    stdout: [
                      "2026-10-12T15:41:02Z deploy payments-api build=7742 stage=canary replicas=2",
                      "2026-10-12T15:41:09Z pod payments-api-canary-0 starting",
                      "2026-10-12T15:41:10Z payments-api-canary-0 Error: missing required env var STRIPE_WEBHOOK_SECRET",
                      "2026-10-12T15:41:10Z payments-api-canary-0 exited with code 1",
                      "2026-10-12T15:41:21Z payments-api-canary-1 Error: missing required env var STRIPE_WEBHOOK_SECRET",
                      "2026-10-12T15:41:21Z payments-api-canary-1 exited with code 1",
                      "2026-10-12T15:46:10Z health check GET :8080/healthz failed: connection refused (30/30)",
                      "2026-10-12T15:46:10Z stage=canary result=failed rollback=started",
                    ].join("\n"),
                    stderr: "",
                    timed_out: false,
                  },
                },
              ],
            },
          ),
          slackThreadMessage(
            "fwiw we renamed that var to STRIPE_WEBHOOK_SIGNING_SECRET in the webhook refactor last week",
            { author: bob },
          ),
          slackMention(
            "ok so the helm chart probably still has the old name?",
            { author: alice },
          ),
          reply(
            "Yes. `charts/payments-api/values-prod.yaml` still sets `STRIPE_WEBHOOK_SECRET`, and the app now reads `STRIPE_WEBHOOK_SIGNING_SECRET`, so the new build finds nothing. Staging works because `values-staging.yaml` was updated in the refactor.",
            {
              toolHistory: [
                {
                  name: "bash",
                  arguments: {
                    command:
                      "grep -rn STRIPE_WEBHOOK charts/payments-api/ src/config/",
                  },
                  result: {
                    exit_code: 0,
                    stdout: [
                      "charts/payments-api/values-prod.yaml:48:    STRIPE_WEBHOOK_SECRET: secretRef:stripe-webhook",
                      "charts/payments-api/values-staging.yaml:48:    STRIPE_WEBHOOK_SIGNING_SECRET: secretRef:stripe-webhook",
                      'src/config/env.ts:22:  stripeWebhookSigningSecret: required("STRIPE_WEBHOOK_SIGNING_SECRET"),',
                    ].join("\n"),
                    stderr: "",
                    timed_out: false,
                  },
                },
              ],
            },
          ),
        ],
      },
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply says to rename STRIPE_WEBHOOK_SECRET to STRIPE_WEBHOOK_SIGNING_SECRET in the prod values file and deploy again.",
        ],
        fail: [
          "Do not retell the earlier investigation, such as the crash log or how staging differs.",
        ],
      }),
    );
    expect(proseWordCount(conversation)).toBeLessThanOrEqual(80);
    expect(boldLabelLines(conversation)).toEqual([]);
  });

  test("when thanked, reply in a few words or not at all", async ({
    agent,
  }) => {
    const { run } = await agent({ modelId: PRODUCTION_MODEL_ID });
    const conversation = await run(
      slackMention("perfect, that worked. thanks!"),
      {
        history: [
          slackMention(
            "how do I undo my last git commit but keep the changes?",
          ),
          reply("Run `git reset --soft HEAD~1`. The changes stay staged."),
        ],
      },
    );
    expect(proseWordCount(conversation)).toBeLessThanOrEqual(15);
  });

  test("when asked for depth, give a thorough answer", async ({ agent }) => {
    const { run } = await agent({ modelId: PRODUCTION_MODEL_ID });
    const conversation = await run(
      slackMention(
        "I'm writing onboarding docs for new backend engineers. Explain how TCP slow start works and why it was designed that way, with enough detail for a few paragraphs of the doc.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply explains how slow start grows the congestion window and why TCP starts slowly.",
        ],
        fail: [
          "Do not give only a short summary that leaves out the reasoning that was asked for.",
        ],
      }),
    );
    expect(proseWordCount(conversation)).toBeGreaterThanOrEqual(120);
  });
});
