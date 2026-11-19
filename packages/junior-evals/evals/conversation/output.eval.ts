import { describe, expect } from "vitest";
import { reply, slackMention } from "@junior-evals/fixture/inputs";
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

  test("when a looked-up answer needs a judgment call, give the answer and the reason only", async ({
    agent,
  }) => {
    mockWebSearchResults([
      {
        title: "Node.js Releases",
        url: "https://nodejs.org/en/about/previous-releases",
        excerpt:
          "Node.js 24 is in Active LTS until October 2026, then Maintenance LTS until April 2028. Node.js 26 is the Current release and enters Active LTS in October 2026. Production applications should only use Active LTS or Maintenance LTS releases.",
      },
    ]);
    const { run } = await agent({ modelId: PRODUCTION_MODEL_ID });
    const conversation = await run(
      slackMention(
        "which node version should we pin for the new billing service?",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply recommends an LTS release, such as Node.js 24, and gives a reason.",
        ],
        fail: ["Do not recommend a release that is not LTS without a caveat."],
      }),
    );
    expect(proseWordCount(conversation)).toBeLessThanOrEqual(100);
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
        "I'm writing onboarding docs for new backend engineers. Walk me through how TCP's three-way handshake, flow control, and congestion control work, in detail, with the reasoning behind each.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply explains the three-way handshake, flow control with the receive window, and congestion control, with the reasoning behind each.",
        ],
        fail: [
          "Do not give only a short summary that leaves out the reasoning that was asked for.",
        ],
      }),
    );
    expect(proseWordCount(conversation)).toBeGreaterThanOrEqual(200);
  });
});
