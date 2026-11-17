import { describe, expect } from "vitest";
import { slackMention, reply } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { toolCallsOf, type ToolCall } from "@junior-evals/fixture/results";
import { test } from "@junior-evals/fixture/test";

// Junior compacts agent history above 90% of the context window, at about 4
// characters per token. Checksums are pseudo-random, so a summary cannot
// recreate one.
const SMALL_CONTEXT_WINDOW_TOKENS = 50_000;
const checksum = (build: number, step: number) =>
  (Math.imul(build * 10_000 + step, 2_654_435_761) >>> 0)
    .toString(16)
    .padStart(8, "0");
// Every build log has the same upload steps, with other checksums. One log
// is about 1,400 tokens, so 42 builds are past the window.
const uploadLog = (build: number) =>
  Array.from({ length: 60 }, (_, index) => {
    const step = 1821 + index;
    return `logs/build-${build}.log:2026-03-01T04:${String(index).padStart(2, "0")}:00Z step ${step} upload ok checksum ${checksum(build, step)} region iad1`;
  }).join("\n");
const uploadChecks = (firstBuild: number, count: number) =>
  Array.from({ length: count }, (_, index) => firstBuild + index).flatMap(
    (build) => [
      slackMention(`Pull the upload steps from the build ${build} log.`),
      reply(`Build ${build}: all 60 upload steps passed in iad1.`, {
        toolHistory: [
          {
            name: "bash",
            arguments: { command: `grep -H upload logs/build-${build}.log` },
            result: {
              exit_code: 0,
              stdout: uploadLog(build),
              stderr: "",
              timed_out: false,
            },
          },
        ],
      }),
    ],
  );
// Storage reports of about 3,500 tokens each fill the window. One check in
// the middle read a certificate end date above a long disk listing, so a
// summary keeps no trace of it. No event shares a word with the question
// about it, so only a search by meaning finds it.
const storageReport = (shard: number) =>
  Array.from(
    { length: 300 },
    (_, index) =>
      `${(index % 97) + 1}.${index % 10}G\t/srv/data/shard-${shard}/segment-${String(index).padStart(6, "0")}.parquet`,
  ).join("\n");
const storageChecks = (firstShard: number, count: number) =>
  Array.from({ length: count }, (_, index) => firstShard + index).flatMap(
    (shard) => [
      slackMention(`Do the weekly storage report for shard ${shard}.`),
      reply(`Shard ${shard} storage looks normal.`, {
        toolHistory: [
          {
            name: "bash",
            arguments: { command: `du -ah /srv/data/shard-${shard}` },
            result: {
              exit_code: 0,
              stdout: storageReport(shard),
              stderr: "",
              timed_out: false,
            },
          },
        ],
      }),
    ],
  );
const EDGE_CHECK = [
  slackMention("Do the weekly checks on edge-1."),
  reply("All weekly checks on edge-1 passed.", {
    toolHistory: [
      {
        name: "bash",
        arguments: {
          command:
            "openssl x509 -enddate -noout -in /etc/edge/tls/api.pem && du -ah /srv/edge",
        },
        result: {
          exit_code: 0,
          stdout: `notAfter=Apr  2 00:00:00 2026 GMT\n${storageReport(0).replaceAll("/srv/data/shard-0", "/srv/edge")}`,
          stderr: "",
          timed_out: false,
        },
      },
    ],
  }),
];
const historyReads = (conversation: { toolCalls: ToolCall[] }) =>
  toolCallsOf("searchConversationEvents", conversation).length +
  toolCallsOf("readConversationEvent", conversation).length;
const searchedWithQuery = (conversation: { toolCalls: ToolCall[] }) =>
  toolCallsOf("searchConversationEvents", conversation).some(
    (call) =>
      typeof (call.input as { query?: unknown } | undefined)?.query ===
      "string",
  );
// This CI log is about 51,000 tokens. The answer must come from the summary.
const CI_LOG = Array.from(
  { length: 1_800 },
  (_, index) =>
    `2026-03-02T09:${String(index % 60).padStart(2, "0")}:00Z [integration (postgres)] vitest worker ${index % 8} passed tests/integration/case-${String(index + 1).padStart(4, "0")}.test.ts in ${100 + (index % 900)}ms`,
).join("\n");
const LONG_THREAD = [
  slackMention(
    "CI on getsentry/junior#4821 is red since the queue refactor. Can you find out why?",
  ),
  reply(
    "The `integration (postgres)` job fails in tests/integration/durable-queue.test.ts with `TypeError: Cannot read properties of undefined (reading 'seq')`. It started with commit 9f3c2ab.",
  ),
  slackMention("Paste the full log of that job."),
  reply(`Log of the integration (postgres) job:\n${CI_LOG}`),
  slackMention(
    "ok. when you fix it, also add a regression test for the empty queue case and ping Dana on the PR",
  ),
  reply("Will do. I'll start with the fix for the failing test."),
];

describe("Thread Continuity", () => {
  test("when a follow-up asks about the prior turn, recall the earlier budget context", async ({
    run,
  }) => {
    const conversation = await run(slackMention("what did i just ask?"), {
      history: [
        slackMention("I need the budget by Friday."),
        reply("Got it: budget due Friday."),
      ],
    });
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The reply explicitly references the earlier budget context, including budget and/or Friday.",
        ],
        fail: ["Do not return sandbox setup failure text."],
      }),
    );

    expect(conversation.replies).toHaveLength(1);
  });

  test("when a compacted tool result holds an exact detail, find it with a history search", async ({
    agent,
  }) => {
    const { run } = await agent({
      limits: { contextWindowTokens: SMALL_CONTEXT_WINDOW_TOKENS },
    });
    const first = await run(
      slackMention("That's the first batch. I'll send the rest after lunch."),
      { history: uploadChecks(7401, 42) },
    );
    const conversation = await first.continue(
      slackMention(
        "What was the exact checksum on step 1847 of build 7421? I need to paste it into the release ticket.",
      ),
      { history: uploadChecks(7443, 42) },
    );

    // Two summaries replaced the log, and 83 other logs have a step 1847.
    expect(first.compactions).toBeGreaterThan(0);
    expect(conversation.compactions).toBeGreaterThan(0);
    expect(conversation.replies.map((item) => item.text).join("\n")).toContain(
      checksum(7421, 1847),
    );
    expect(searchedWithQuery(conversation)).toBe(true);
    // Reading the logs one by one takes far more calls.
    expect(historyReads(conversation)).toBeLessThanOrEqual(8);
  });

  test("when no word of a question is in the compacted tool result, find it by meaning", async ({
    agent,
  }) => {
    const { run } = await agent({
      eventEmbeddings: { enabled: true },
      limits: { contextWindowTokens: SMALL_CONTEXT_WINDOW_TOKENS },
    });
    const first = await run(slackMention("Thanks, that's all for this week."), {
      history: [...storageChecks(1, 4), ...EDGE_CHECK, ...storageChecks(5, 10)],
    });
    // The Turn stored the event vectors after it finished.
    const conversation = await first.continue(
      slackMention("When does our HTTPS certificate expire?"),
      { history: storageChecks(15, 14) },
    );

    expect(first.compactions).toBeGreaterThan(0);
    expect(conversation.compactions).toBeGreaterThan(0);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply says the certificate expires on April 2, 2026."],
      }),
    );
    expect(searchedWithQuery(conversation)).toBe(true);
    expect(historyReads(conversation)).toBeLessThanOrEqual(8);
  });

  test.for([
    {
      probe: "In one sentence, what did I ask you to do that is still open?",
      pass: "The reply names the regression test for the empty queue case or pinging Dana on the PR.",
    },
    {
      probe: "In one sentence, which PR are we working on?",
      pass: "The reply names getsentry/junior#4821 or PR 4821.",
    },
    {
      probe: "In one sentence, what failed?",
      pass: "The reply says the integration (postgres) job or durable-queue test fails with a TypeError about reading 'seq'.",
    },
  ])(
    "when a long thread was compacted, answer $probe from the summary",
    async ({ probe, pass }, { agent }) => {
      const { run } = await agent({
        limits: { contextWindowTokens: SMALL_CONTEXT_WINDOW_TOKENS },
      });
      const conversation = await run(slackMention(probe), {
        history: LONG_THREAD,
      });
      await expect(conversation).toSatisfyJudge(
        RubricJudge,
        rubric({ pass: [pass] }),
      );

      expect(conversation.compactions).toBeGreaterThan(0);
      expect(conversation.replies).toHaveLength(1);
    },
  );
});
