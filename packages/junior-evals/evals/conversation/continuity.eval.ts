import { describe, expect } from "vitest";
import { slackMention, reply } from "@junior-evals/fixture/inputs";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { keywordSearchEvents } from "@junior-evals/fixture/event-search";
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
// Every host check prints the end date of the host's certificate above a
// disk listing of about 1,400 tokens, so 36 checks are past the window. Each
// host has its own date, so a summary cannot keep them all. Host names are
// opaque. Only the disk listing of the mail host shows its role, through its
// Postfix queue, and no event shares a word with the question about it. So
// only a search by meaning finds it.
const HOSTS = Array.from(
  { length: 40 },
  (_, index) => `node-${String(index + 1).padStart(2, "0")}`,
);
const MAIL_HOST = "node-07";
const MAIL_HOST_END_DATE = "Apr  2 00:00:00 2026 GMT";
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
// Other hosts end on other days, five days apart from January 5, 2026.
const endDate = (host: string) => {
  if (host === MAIL_HOST) return MAIL_HOST_END_DATE;
  const day = new Date(Date.UTC(2026, 0, 5 + HOSTS.indexOf(host) * 5));
  return `${MONTHS[day.getUTCMonth()]} ${String(day.getUTCDate()).padStart(2, " ")} 00:00:00 ${day.getUTCFullYear()} GMT`;
};
const hex = (host: string, index: number) =>
  (Math.imul(HOSTS.indexOf(host) * 1_000 + index + 1, 2_654_435_761) >>> 0)
    .toString(16)
    .toUpperCase()
    .padStart(8, "0");
// Paths of the data that each kind of host keeps, so roles differ by content.
const DATA_PATHS: Array<(host: string, index: number) => string> = [
  (_host, index) => `/var/lib/postgresql/16/main/base/16384/${20_000 + index}`,
  (_host, index) =>
    `/var/lib/kafka/logs/events-${index % 12}/000000000${index}.log`,
  (_host, index) => `/var/lib/redis/appendonly-${index}.aof`,
  (host, index) => `/var/cache/nginx/proxy/${hex(host, index)}`,
  (host, index) =>
    `/var/lib/elasticsearch/nodes/0/indices/${hex(host, index)}/0/index/_${index}.cfs`,
  (host, index) =>
    `/var/lib/prometheus/data/01H${hex(host, index)}/chunks/00000${index}`,
  (host, index) =>
    `/var/lib/registry/docker/registry/v2/blobs/sha256/${hex(host, index).toLowerCase()}/data`,
  (_host, index) => `/var/lib/jenkins/workspace/build-${index}/target/app.jar`,
];
const POSTFIX_QUEUES = ["active", "deferred", "incoming", "hold"];
const dataPath = (host: string, index: number) =>
  host === MAIL_HOST
    ? `/var/spool/postfix/${POSTFIX_QUEUES[index % 4]}/${hex(host, index).slice(0, 1)}/${hex(host, index)}`
    : DATA_PATHS[HOSTS.indexOf(host) % DATA_PATHS.length]!(host, index);
const diskListing = (host: string) =>
  Array.from(
    { length: 120 },
    (_, index) =>
      `${(index % 97) + 1}.${index % 10}M\t${dataPath(host, index)}`,
  ).join("\n");
const hostChecks = (hosts: readonly string[]) =>
  hosts.flatMap((host) => [
    slackMention(`Do the weekly checks on ${host}.`),
    reply(`All weekly checks on ${host} passed.`, {
      toolHistory: [
        {
          name: "bash",
          arguments: {
            command: `openssl x509 -enddate -noout -in /etc/pki/${host}.pem && du -ah /var`,
          },
          result: {
            exit_code: 0,
            stdout: `notAfter=${endDate(host)}\n${diskListing(host)}`,
            stderr: "",
            timed_out: false,
          },
        },
      ],
    }),
  ]);
// Forms of the mail host's end date that a summary could hold.
const holdsMailHostDate = (summaries: readonly string[]) =>
  /\bApr(il)?\.?\s+0?2\b|2026-04-02|\b0?4\/0?2\b/i.test(summaries.join("\n"));
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
      history: hostChecks(HOSTS.slice(0, 37)),
    });
    // The Turn stored the event vectors after it finished.
    const conversation = await first.continue(
      slackMention("When does the certificate on our mail server expire?"),
      { history: hostChecks(HOSTS.slice(37)) },
    );

    expect(first.compactions).toBeGreaterThan(0);
    // The case proves nothing when a summary still holds the answer.
    expect(
      holdsMailHostDate([
        ...first.compactionSummaries,
        ...conversation.compactionSummaries,
      ]),
    ).toBe(false);
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: ["The reply says the certificate expires on April 2, 2026."],
      }),
    );
    const [firstSearch] = toolCallsOf("searchConversationEvents", conversation);
    expect(searchedWithQuery(conversation)).toBe(true);
    // Keyword search alone does not find the mail host for that search.
    const keywordEvents = await keywordSearchEvents(
      conversation.conversationId,
      firstSearch?.input,
    );
    expect(
      keywordEvents.some((event) => JSON.stringify(event).includes(MAIL_HOST)),
    ).toBe(false);
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
