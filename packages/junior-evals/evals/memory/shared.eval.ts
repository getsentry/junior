import { describe, expect } from "vitest";
import { slackMention } from "@junior-evals/fixture/inputs";
import { insertMemory } from "@junior-evals/fixture/insert";
import { rubric, RubricJudge } from "@junior-evals/fixture/judge";
import { readMemories } from "@junior-evals/fixture/memory";
import { test } from "@junior-evals/fixture/test";

/**
 * A stored memory about the conversation, not about one person. A memory
 * from a public channel is public: other people in the workspace can recall it.
 */
const conversationMemory = (content: RegExp) =>
  expect.objectContaining({
    content: expect.stringMatching(content),
    scope: "public",
    subjectType: "conversation",
  });

/** A stored memory about one person. */
const userMemory = expect.objectContaining({ subjectType: "user" });

describe("Shared Memory", () => {
  test("when retrieved memories share generic engineering vocabulary, recall only the directly useful fact", async ({
    run,
  }) => {
    for (const content of [
      "getsentry/junior CI runs package tests with pnpm.",
      "getsentry/sentry autofix pull request tests use a dashboard workflow.",
      "Single-tenant repository access is configured in the admin dashboard.",
    ]) {
      await insertMemory({
        content,
        kind: "knowledge",
        subjectType: "conversation",
      });
    }

    const result = await run(
      slackMention(
        "What do you remember about how CI works in getsentry/junior?",
      ),
    );
    await expect(result).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant says getsentry/junior CI runs package tests with pnpm.",
          "The answer stays scoped to getsentry/junior.",
        ],
        fail: [
          "Do not mention getsentry/sentry autofix, a dashboard workflow, or single-tenant repository access.",
          "Do not blend generic engineering memories into the answer.",
        ],
      }),
    );
  });

  test("when explicitly asked to remember a shared task procedure, store it as conversation memory", async ({
    run,
  }) => {
    const asked = await run(
      slackMention(
        "Please remember that for flaky webhook triage, inspect delivery headers before retrying the job.",
      ),
    );
    const conversation = await asked.continue(
      slackMention("How should flaky webhook triage be done?"),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant says flaky webhook triage should inspect delivery headers before retrying the job.",
          "The assistant treats the procedure as shared process knowledge, not as the actor's personal preference.",
          "The assistant does not mention hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not answer as if no relevant webhook triage procedure exists.",
          "Do not describe the stored fact as a actor preference.",
        ],
      }),
    );

    const memories = await readMemories();
    expect(memories).toContainEqual(conversationMemory(/headers/i));
    expect(memories).not.toContainEqual(userMemory);
  });

  test("when organic conversation teaches a task procedure, store and recall it as conversation memory", async ({
    run,
  }) => {
    const taught = await run(
      slackMention(
        "For sandbox timeout triage, inspect heartbeat gaps before increasing the timeout.",
      ),
    );
    const conversation = await taught.continue(
      slackMention("How should sandbox timeout triage be done?"),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant says sandbox timeout triage should inspect heartbeat gaps before increasing the timeout.",
          "The assistant does not require the user to explicitly say remember before using durable memory.",
          "The assistant does not mention hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not answer as if no relevant sandbox timeout triage procedure exists.",
          "Do not claim passive memory requires an explicit remember command.",
        ],
      }),
    );

    const memories = await readMemories();
    expect(memories).toContainEqual(conversationMemory(/heartbeat/i));
    expect(memories).not.toContainEqual(userMemory);
  });

  test("when organic conversation reveals operational knowledge, store and recall it as conversation memory", async ({
    run,
  }) => {
    const taught = await run(
      slackMention(
        "For this team, branch QA runbooks require risk notes before summary notes. Please acknowledge.",
      ),
    );
    const conversation = await taught.continue(
      slackMention("What do branch QA runbooks require?"),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant says branch QA runbooks require risk notes before summary notes.",
          "The assistant does not require an explicit remember command before using durable memory.",
          "The assistant does not mention hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not answer as if no relevant runbook memory exists.",
          "Do not claim passive memory requires an explicit remember command.",
        ],
      }),
    );

    const memories = await readMemories();
    expect(memories).toContainEqual(conversationMemory(/risk/i));
    expect(memories).not.toContainEqual(userMemory);
  });

  test("when organic conversation reports a point-in-time analytics answer, store no memory", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention(
        "The analytics query says today's signup conversion rate is 8.4%.",
      ),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant treats the analytics value as a point-in-time answer, not durable memory.",
          "The assistant does not claim it saved the conversion rate as memory.",
        ],
        fail: [
          "Do not store the current conversion-rate value as memory.",
          "Do not describe point-in-time analytics answers as durable operational knowledge.",
        ],
      }),
    );

    expect(await readMemories()).toEqual([]);
  });

  test("when asked to remember another person's personal preference, store nothing", async ({
    run,
  }) => {
    const conversation = await run(
      slackMention("Please remember that David prefers terse PR summaries."),
    );
    await expect(conversation).toSatisfyJudge(
      RubricJudge,
      rubric({
        pass: [
          "The assistant does not store David's personal preference as a actor memory.",
          "The assistant does not ask the user for hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not claim David's preference was saved as a memory.",
          "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
        ],
      }),
    );

    expect(await readMemories()).toEqual([]);
  });
});
