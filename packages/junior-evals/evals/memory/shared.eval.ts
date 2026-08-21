import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { mention, rubric, slackEvals } from "../../src/helpers";
import {
  clearMemories,
  expectAssistantMemoryAnswer,
  expectConversationMemorySemantics,
  type MemoryThread,
  memoryPluginOverrides,
  readMemories,
  seedMemory,
  visibleAssistantText,
} from "./helpers";

describeEval("Shared Memory", slackEvals, (it) => {
  const recallRelevanceThread = {
    channel_type: "channel",
    id: "thread-memory-recall-relevance",
    channel_id: "CMEMORYRECALLRELEVANCE",
    thread_ts: "17000000.000000",
  } satisfies MemoryThread;

  it("when retrieved memories share generic engineering vocabulary, recall only the directly useful fact", async ({
    run,
  }) => {
    await clearMemories();
    await seedMemory({
      content: "getsentry/junior CI runs package tests with pnpm.",
      idempotencyKey: "eval-memory-recall-relevant",
      kind: "knowledge",
      subject: "conversation",
      thread: recallRelevanceThread,
    });
    await seedMemory({
      content:
        "getsentry/sentry autofix pull request tests use a dashboard workflow.",
      idempotencyKey: "eval-memory-recall-vocabulary",
      kind: "knowledge",
      subject: "conversation",
      thread: recallRelevanceThread,
    });
    await seedMemory({
      content:
        "Single-tenant repository access is configured in the admin dashboard.",
      idempotencyKey: "eval-memory-recall-unrelated",
      kind: "knowledge",
      subject: "conversation",
      thread: recallRelevanceThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(
          "What do you remember about how CI works in getsentry/junior?",
          {
            thread: recallRelevanceThread,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant says getsentry/junior CI runs package tests with pnpm.",
          "The answer stays scoped to getsentry/junior.",
        ],
        fail: [
          "Do not mention getsentry/sentry autofix, a dashboard workflow, or single-tenant repository access.",
          "Do not blend generic engineering memories into the answer.",
        ],
      }),
    });
  });

  const explicitTaskProcedureThread = {
    channel_type: "channel",
    id: "thread-memory-explicit-task-procedure",
    channel_id: "CMEMORYEXPLICITTASK",
    thread_ts: "17000000.000004",
  } satisfies MemoryThread;

  it("when explicitly asked to remember a shared task procedure, store it as conversation memory", async ({
    run,
  }) => {
    await clearMemories();
    const userText =
      "Please remember that for flaky webhook triage, inspect delivery headers before retrying the job.";
    const result = await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(userText, {
          thread: explicitTaskProcedureThread,
        }),
      ],
      events: [
        mention("How should flaky webhook triage be done?", {
          thread: explicitTaskProcedureThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant stores and uses the shared task procedure from the user's explicit memory request.",
          "The assistant treats the procedure as shared process knowledge, not as the actor's personal preference.",
          "The assistant does not mention hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not answer as if no relevant webhook triage procedure exists.",
          "Do not describe the stored fact as a actor preference.",
        ],
      }),
    });

    const rows = await readMemories(explicitTaskProcedureThread);
    expect(rows).toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        scope: "public",
        subjectType: "conversation",
      }),
    );
    expect(rows).not.toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        scope: "public",
        subjectType: "user",
      }),
    );
    await expectConversationMemorySemantics({
      assistantText: visibleAssistantText(result),
      expectedMeaning:
        "Flaky webhook triage inspects delivery headers before retrying the job.",
      storedMemories: rows,
      userText,
    });
    await expectAssistantMemoryAnswer({
      assistantText: visibleAssistantText(result),
      expectedBehavior:
        "The assistant says flaky webhook triage should inspect delivery headers before retrying the job.",
    });
  });

  const passiveTaskProcedureThread = {
    channel_type: "channel",
    id: "thread-memory-passive-task-procedure",
    channel_id: "CMEMORYPASSIVETASK",
    thread_ts: "17000000.000005",
  } satisfies MemoryThread;

  it("when organic conversation teaches a task procedure, store and recall it as conversation memory", async ({
    run,
  }) => {
    await clearMemories();
    const userText =
      "For sandbox timeout triage, inspect heartbeat gaps before increasing the timeout.";
    const result = await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(userText, {
          thread: passiveTaskProcedureThread,
        }),
      ],
      events: [
        mention("How should sandbox timeout triage be done?", {
          thread: passiveTaskProcedureThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant uses the organic task procedure from the earlier turn when answering the follow-up.",
          "The assistant does not require the user to explicitly say remember before using durable memory.",
          "The assistant does not mention hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not answer as if no relevant sandbox timeout triage procedure exists.",
          "Do not claim passive memory requires an explicit remember command.",
        ],
      }),
    });

    const rows = await readMemories(passiveTaskProcedureThread);
    expect(rows).toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        scope: "public",
        subjectType: "conversation",
      }),
    );
    expect(rows).not.toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        scope: "public",
        subjectType: "user",
      }),
    );
    await expectConversationMemorySemantics({
      assistantText: visibleAssistantText(result),
      expectedMeaning:
        "Sandbox timeout triage inspects heartbeat gaps before increasing the timeout.",
      storedMemories: rows,
      userText,
    });
    await expectAssistantMemoryAnswer({
      assistantText: visibleAssistantText(result),
      expectedBehavior:
        "The assistant says sandbox timeout triage should inspect heartbeat gaps before increasing the timeout.",
    });
  }, 120_000);

  const passiveConversationThread = {
    channel_type: "channel",
    id: "thread-memory-passive-conversation",
    channel_id: "CMEMORYPASSIVECONVERSATION",
    thread_ts: "17000000.000006",
  } satisfies MemoryThread;

  it("when organic conversation reveals operational knowledge, store and recall it as conversation memory", async ({
    run,
  }) => {
    await clearMemories();
    const userText =
      "For this team, branch QA runbooks require risk notes before summary notes. Please acknowledge.";
    const result = await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(userText, {
          thread: passiveConversationThread,
        }),
      ],
      events: [
        mention("What do branch QA runbooks require?", {
          thread: passiveConversationThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant uses the organic operational knowledge from the earlier turn when answering the follow-up.",
          "The assistant does not require an explicit remember command before using durable memory.",
          "The assistant does not mention hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not answer as if no relevant runbook memory exists.",
          "Do not claim passive memory requires an explicit remember command.",
        ],
      }),
    });

    const rows = await readMemories(passiveConversationThread);
    expect(rows).toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        scope: "public",
        subjectType: "conversation",
      }),
    );
    expect(rows).not.toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        scope: "public",
        subjectType: "user",
      }),
    );
    await expectConversationMemorySemantics({
      assistantText: visibleAssistantText(result),
      expectedMeaning:
        "Branch QA runbooks require risk notes before summary notes.",
      storedMemories: rows,
      userText,
    });
    await expectAssistantMemoryAnswer({
      assistantText: visibleAssistantText(result),
      expectedBehavior:
        "The assistant says branch QA runbooks require risk notes before summary notes.",
    });
  });

  const passiveVolatileAnswerThread = {
    channel_type: "channel",
    id: "thread-memory-passive-volatile-answer",
    channel_id: "CMEMORYVOLATILE",
    thread_ts: "17000000.000007",
  } satisfies MemoryThread;

  it("when organic conversation reports a point-in-time analytics answer, store no memory", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention(
          "The analytics query says today's signup conversion rate is 8.4%.",
          {
            thread: passiveVolatileAnswerThread,
          },
        ),
      ],
      criteria: rubric({
        pass: [
          "The assistant treats the analytics value as a point-in-time answer, not durable memory.",
          "The assistant does not claim it saved the conversion rate as memory.",
        ],
        fail: [
          "Do not store the current conversion-rate value as memory.",
          "Do not describe point-in-time analytics answers as durable operational knowledge.",
        ],
      }),
    });

    expect(await readMemories(passiveVolatileAnswerThread)).toEqual([]);
  }, 120_000);

  const thirdPartyRememberThread = {
    id: "thread-memory-third-party-remember",
    channel_id: "CMEMORYTHIRDPARTY",
    thread_ts: "17000000.000008",
  };

  it("when asked to remember another person's personal preference, store nothing", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      initialEvents: [
        mention("Please remember that David prefers terse PR summaries.", {
          thread: thirdPartyRememberThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant does not store David's personal preference as a actor memory.",
          "The assistant does not ask the user for hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not claim David's preference was saved as a memory.",
          "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
        ],
      }),
    });

    expect(await readMemories(thirdPartyRememberThread)).toEqual([]);
  });
});
