import { expect } from "vitest";
import { assistantMessages, describeEval } from "vitest-evals";
import { getDb } from "@/chat/db";
import { completeText, resolveGatewayModel } from "@/chat/pi/client";
import { createMemoryStore, type MemoryDb } from "@sentry/junior-memory";
import { createSlackSource, type PluginModel } from "@sentry/junior-plugin-api";
import {
  juniorMemoryEmbeddings,
  juniorMemoryMemories,
} from "../../../junior-memory/src/db/schema";
import { createMemoryAgent } from "../../../junior-memory/src/agent";
import { mention, rubric, slackEvals } from "../../src/helpers";

const memoryPluginOverrides = {
  plugin_packages: ["@sentry/junior-memory"],
};
const memoryTeamId = "TEVAL";
const actorUserId = "U-test";
const memoryJudgeModelId = resolveGatewayModel("openai/gpt-5.4").id;

interface MemoryThread {
  channel_type?: "channel" | "group" | "im" | "mpim";
  channel_id: string;
  id: string;
  thread_ts: string;
}

async function seedMemory(args: {
  content: string;
  idempotencyKey: string;
  kind?: "knowledge" | "preference" | "procedure";
  scope?: "conversation" | "personal";
  thread: MemoryThread;
}) {
  const store = createMemoryStore(memoryDb(), {
    conversationId: `slack:${args.thread.channel_id}:${args.thread.thread_ts}`,
    actor: {
      platform: "slack",
      teamId: memoryTeamId,
      userId: actorUserId,
    },
    source: createSlackSource({
      channelId: args.thread.channel_id,
      messageTs: args.thread.thread_ts,
      teamId: memoryTeamId,
      threadTs: args.thread.thread_ts,

      type: "priv",
    }),
  });
  const input = {
    content: args.content,
    idempotencyKey: args.idempotencyKey,
    kind: args.kind ?? "preference",
  };
  if (args.scope === "conversation") {
    await store.createConversationMemory(input);
    return;
  }
  await store.createMemory(input);
}

function memoryDb(): MemoryDb {
  return getDb() as unknown as MemoryDb;
}

const evalMemoryModel: PluginModel = {
  async completeObject(input) {
    const { text } = await completeText({
      maxTokens: input.maxTokens,
      modelId: memoryJudgeModelId,
      system: input.system,
      messages: [
        {
          role: "user",
          content: [
            input.prompt,
            "",
            "Return only raw JSON in exactly one of these shapes:",
            '{"decision":"supersedes_old","supersededIds":["existing-memory-id"]}',
            '{"decision":"distinct"}',
            '{"decision":"uncertain"}',
            'Use camelCase keys exactly, including "supersededIds". Do not wrap it in markdown.',
          ].join("\n"),
          timestamp: Date.now(),
        },
      ],
      temperature: 0,
    });
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "superseded_ids" in parsed &&
      !("supersededIds" in parsed)
    ) {
      (parsed as Record<string, unknown>).supersededIds = (
        parsed as Record<string, unknown>
      ).superseded_ids;
      delete (parsed as Record<string, unknown>).superseded_ids;
    }
    return { object: input.schema.parse(parsed) };
  },
};

function memorySourceKey(thread: MemoryThread): string {
  return `slack:${memoryTeamId}:${thread.channel_id}:${thread.thread_ts}`;
}

async function readMemories(thread: MemoryThread) {
  const rows = await memoryDb()
    .select()
    .from(juniorMemoryMemories)
    .orderBy(juniorMemoryMemories.createdAtMs, juniorMemoryMemories.id);
  return rows.filter((memory) => memory.sourceKey === memorySourceKey(thread));
}

async function clearMemories() {
  await memoryDb().delete(juniorMemoryEmbeddings);
  await memoryDb().delete(juniorMemoryMemories);
}

function visibleAssistantText(result: {
  session: Parameters<typeof assistantMessages>[0];
}): string {
  return assistantMessages(result.session)
    .map((message) =>
      typeof message.content === "string" ? message.content : "",
    )
    .join("\n");
}

interface MemorySemanticJudgmentInput {
  assistantText: string;
  expectedMeaning: string;
  storedMemories: Awaited<ReturnType<typeof readMemories>>;
  userText: string;
}

function parseMemoryJudgeResult(text: string): {
  passed: boolean;
  rationale: string;
} {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Memory judge returned non-object JSON: ${text}`);
  }
  const passed = (parsed as Record<string, unknown>).passed;
  const rationale = (parsed as Record<string, unknown>).rationale;
  if (typeof passed !== "boolean" || typeof rationale !== "string") {
    throw new Error(`Memory judge returned invalid JSON: ${text}`);
  }
  return { passed, rationale };
}

async function expectActorMemorySemantics(
  input: MemorySemanticJudgmentInput,
): Promise<void> {
  const storedMemoryProjection = input.storedMemories.map((memory) => ({
    archivedAtMs: memory.archivedAtMs,
    content: memory.content,
    scope: memory.scope,
    subjectType: memory.subjectType,
  }));
  const { text } = await completeText({
    modelId: memoryJudgeModelId,
    system:
      'You judge Junior memory eval results. Return only raw JSON matching {"passed":boolean,"rationale":"..."}.',
    messages: [
      {
        role: "user",
        content: [
          "<memory-eval>",
          "<user-text>",
          input.userText,
          "</user-text>",
          "<expected-meaning>",
          input.expectedMeaning,
          "</expected-meaning>",
          "<stored-memories-json>",
          JSON.stringify(storedMemoryProjection),
          "</stored-memories-json>",
          "<assistant-text>",
          input.assistantText,
          "</assistant-text>",
          "<criteria>",
          "Pass only if exactly one active personal/user memory is stored and its content is semantically equivalent to the expected meaning.",
          "The stored content must be canonical memory text: no actor display name, no 'the actor', no 'the user', no first-person wording, and no thread/channel/source wording.",
          "The assistant text must not claim the memory failed because the user's first-person request was rewritten in third person.",
          "Fail if no memory was stored, if the stored memory is about someone other than the actor, if the content is a vague paraphrase, or if the content preserves source/user labels.",
          "</criteria>",
          "</memory-eval>",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
    temperature: 0,
  });
  const judgment = parseMemoryJudgeResult(text);
  expect(
    judgment,
    `${judgment.rationale}\nStored memories: ${JSON.stringify(storedMemoryProjection)}`,
  ).toEqual(expect.objectContaining({ passed: true }));
}

async function expectConversationMemorySemantics(
  input: MemorySemanticJudgmentInput,
): Promise<void> {
  const storedMemoryProjection = input.storedMemories.map((memory) => ({
    archivedAtMs: memory.archivedAtMs,
    content: memory.content,
    scope: memory.scope,
    subjectType: memory.subjectType,
  }));
  const { text } = await completeText({
    modelId: memoryJudgeModelId,
    system:
      'You judge Junior memory eval results. Return only raw JSON matching {"passed":boolean,"rationale":"..."}.',
    messages: [
      {
        role: "user",
        content: [
          "<memory-eval>",
          "<user-text>",
          input.userText,
          "</user-text>",
          "<expected-meaning>",
          input.expectedMeaning,
          "</expected-meaning>",
          "<stored-memories-json>",
          JSON.stringify(storedMemoryProjection),
          "</stored-memories-json>",
          "<assistant-text>",
          input.assistantText,
          "</assistant-text>",
          "<criteria>",
          "Pass only if exactly one active conversation memory is stored and its content is semantically equivalent to the expected meaning.",
          "The stored content must be canonical memory text: no actor display name, no 'the actor', no 'the user', no first-person wording, and no thread/channel/source wording.",
          "Fail if the memory is stored as personal/user memory, if no memory was stored, if the content is a vague paraphrase, or if the content preserves source/user labels.",
          "</criteria>",
          "</memory-eval>",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
    temperature: 0,
  });
  const judgment = parseMemoryJudgeResult(text);
  expect(
    judgment,
    `${judgment.rationale}\nStored memories: ${JSON.stringify(storedMemoryProjection)}`,
  ).toEqual(expect.objectContaining({ passed: true }));
}

async function expectAssistantMemoryAnswer(args: {
  assistantText: string;
  expectedBehavior: string;
}): Promise<void> {
  const { text } = await completeText({
    modelId: memoryJudgeModelId,
    system:
      'You judge Junior memory eval replies. Return only raw JSON matching {"passed":boolean,"rationale":"..."}.',
    messages: [
      {
        role: "user",
        content: [
          "<assistant-text>",
          args.assistantText,
          "</assistant-text>",
          "<expected-behavior>",
          args.expectedBehavior,
          "</expected-behavior>",
          "<criteria>",
          "Pass only if the assistant text satisfies the expected behavior.",
          "Fail if the assistant asks the user to restate the remembered fact, claims no relevant memory exists, or exposes hidden storage fields such as scope keys or Slack ids.",
          "Use expected-behavior as the authority for whether the scenario requested a memory id. Memory ids or id prefixes are allowed when expected-behavior says an id was requested.",
          "</criteria>",
        ].join("\n"),
        timestamp: Date.now(),
      },
    ],
    temperature: 0,
  });
  const judgment = parseMemoryJudgeResult(text);
  expect(judgment, judgment.rationale).toEqual(
    expect.objectContaining({ passed: true }),
  );
}

describeEval("Memory Workflows", slackEvals, (it) => {
  const explicitRememberThread = {
    id: "thread-memory-explicit-remember",
    channel_id: "CMEMORYEXPLICIT",
    thread_ts: "17000000.memory-explicit",
  };

  it("when explicitly asked to remember a public first-person preference, store one personal memory", async ({
    run,
  }) => {
    await clearMemories();
    const result = await run({
      overrides: memoryPluginOverrides,
      events: [
        mention("Please remember that I prefer terse PR summaries.", {
          thread: explicitRememberThread,
        }),
        mention("List the exact stored memory content for that preference.", {
          thread: explicitRememberThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "Treat createMemory arguments as candidate input, not stored content.",
          "The assistant uses the exact canonical stored memory content. Good: 'Prefers terse PR summaries'. Bad: 'The actor prefers terse PR summaries'. Bad: 'I prefer terse PR summaries'.",
          "The assistant does not ask the user to provide hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not fail only because the createMemory candidate uses natural first-person or display-name phrasing; the stored/listed memory content is the contract.",
          "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
          "Do not present actor names, display names, 'the actor', 'the user', 'I', 'my', thread labels, channel labels, or source labels as the stored memory content.",
          "Do not say the memory failed to save.",
        ],
      }),
    });

    const rows = await readMemories(explicitRememberThread);
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        scope: "personal",
        subjectType: "user",
      }),
    ]);
    await expectActorMemorySemantics({
      assistantText: visibleAssistantText(result),
      expectedMeaning: "The actor prefers terse pull request summaries.",
      storedMemories: rows,
      userText: "Please remember that I prefer terse PR summaries.",
    });
  });

  const firstPersonRewrittenThread = {
    id: "thread-memory-first-person-rewritten",
    channel_id: "CMEMORYFIRSTPERSON",
    thread_ts: "17000000.memory-first-person",
  };

  it("when the actor states a first-person opinion, store it even if candidate wording is rewritten", async ({
    run,
  }) => {
    await clearMemories();
    const userText = "ok remember that i think types in python are bad";
    const result = await run({
      overrides: memoryPluginOverrides,
      events: [
        mention(userText, {
          thread: firstPersonRewrittenThread,
        }),
        mention("What exact memory did you store about Python types?", {
          thread: firstPersonRewrittenThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant treats the user's first-person request as actor-authored source evidence.",
          "The assistant stores and later reports a canonical actor memory matching the user's opinion about Python types.",
          "The assistant does not ask the user for hidden scope, actor, Slack, or subject identifiers.",
        ],
        fail: [
          "Do not refuse the memory because a candidate or reply uses the actor's name, 'the actor', or third-person wording.",
          "Do not ask the user to rephrase the already first-person memory request.",
          "Do not store a memory about a third party.",
        ],
      }),
    });

    const rows = await readMemories(firstPersonRewrittenThread);
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        scope: "personal",
        subjectType: "user",
      }),
    ]);
    await expectActorMemorySemantics({
      assistantText: visibleAssistantText(result),
      expectedMeaning:
        "The actor thinks types in Python are bad or dislikes Python typing/type annotations.",
      storedMemories: rows,
      userText,
    });
  });

  it("when adjudicating preference supersession, distinguish replacement from additive preferences", async () => {
    const agent = createMemoryAgent(evalMemoryModel);
    const runtimeContext = {
      conversationId: "slack:CMEMORYSUPERSESSION:17000000.memory-supersession",
      actor: {
        platform: "slack" as const,
        teamId: memoryTeamId,
        userId: actorUserId,
      },
      source: createSlackSource({
        channelId: "CMEMORYSUPERSESSION",
        messageTs: "17000000.memory-supersession",
        teamId: memoryTeamId,
        threadTs: "17000000.memory-supersession",

        type: "priv",
      }),
    };

    const replacement = await agent.adjudicateSupersession({
      candidate: {
        content: "Prefers TypeScript for automation scripts.",
        kind: "preference",
      },
      existingMemories: [
        {
          content: "Prefers Python for automation scripts.",
          id: "memory-old-language",
        },
      ],
      runtimeContext,
    });
    expect(replacement).toEqual({
      decision: "supersedes_old",
      supersededIds: ["memory-old-language"],
    });

    const additive = await agent.adjudicateSupersession({
      candidate: {
        content: "Prefers Slack updates in the morning.",
        kind: "preference",
      },
      existingMemories: [
        {
          content: "Prefers terse PR summaries.",
          id: "memory-old-summary-style",
        },
      ],
      runtimeContext,
    });
    expect(additive.decision).not.toBe("supersedes_old");
  }, 120_000);

  const explicitTaskProcedureThread = {
    channel_type: "channel",
    id: "thread-memory-explicit-task-procedure",
    channel_id: "CMEMORYEXPLICITTASK",
    thread_ts: "17000000.memory-explicit-task",
  } satisfies MemoryThread;

  it("when explicitly asked to remember a shared task procedure, store it as conversation memory", async ({
    run,
  }) => {
    await clearMemories();
    const userText =
      "Please remember that for flaky webhook triage, inspect delivery headers before retrying the job.";
    const result = await run({
      overrides: memoryPluginOverrides,
      events: [
        mention(userText, {
          thread: explicitTaskProcedureThread,
        }),
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
        scope: "conversation",
        subjectType: "conversation",
      }),
    );
    expect(rows).not.toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        scope: "personal",
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
    thread_ts: "17000000.memory-passive-task",
  } satisfies MemoryThread;

  it("when organic conversation teaches a task procedure, store and recall it as conversation memory", async ({
    run,
  }) => {
    await clearMemories();
    const userText =
      "For sandbox timeout triage, inspect heartbeat gaps before increasing the timeout.";
    const result = await run({
      overrides: memoryPluginOverrides,
      events: [
        mention(userText, {
          thread: passiveTaskProcedureThread,
        }),
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
        scope: "conversation",
        subjectType: "conversation",
      }),
    );
    expect(rows).not.toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        scope: "personal",
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
    thread_ts: "17000000.memory-passive-conversation",
  } satisfies MemoryThread;

  it("when organic conversation reveals operational knowledge, store and recall it as conversation memory", async ({
    run,
  }) => {
    await clearMemories();
    const userText =
      "Branch QA runbooks require risk notes before summary notes.";
    const result = await run({
      overrides: memoryPluginOverrides,
      events: [
        mention(userText, {
          thread: passiveConversationThread,
        }),
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
        scope: "conversation",
        subjectType: "conversation",
      }),
    );
    expect(rows).not.toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        scope: "personal",
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
    thread_ts: "17000000.memory-volatile-answer",
  } satisfies MemoryThread;

  it("when organic conversation reports a point-in-time analytics answer, store no memory", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      events: [
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
    thread_ts: "17000000.memory-third-party",
  };

  it("when asked to remember another person's personal preference, store nothing", async ({
    run,
  }) => {
    await clearMemories();
    await run({
      overrides: memoryPluginOverrides,
      events: [
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

  const autoRecallThread = {
    id: "thread-memory-auto-recall",
    channel_id: "CMEMORYAUTORECALL",
    thread_ts: "17000000.memory-auto-recall",
  };

  it("automatically injects relevant memories without requiring a recall tool", async ({
    run,
  }) => {
    await clearMemories();
    await seedMemory({
      content: "Prefers PR summaries with risks first.",
      idempotencyKey: "eval-memory-auto-recall",
      thread: autoRecallThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      events: [
        mention("How should I structure my next PR summary?", {
          thread: autoRecallThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant uses memory to say the user prefers PR summaries with risks first.",
          "The assistant does not ask the user to restate the preference.",
        ],
        fail: [
          "Do not answer as if no relevant preference exists.",
          "Do not mention hidden storage fields, scope keys, or Slack ids.",
        ],
      }),
    });

    const rows = await readMemories(autoRecallThread);
    expect(rows).toContainEqual(
      expect.objectContaining({
        archivedAtMs: null,
        content: "Prefers PR summaries with risks first.",
        scope: "personal",
      }),
    );
  });

  const passiveDedupeThread = {
    id: "thread-memory-passive-dedupe",
    channel_id: "CMEMORYPASSIVEDEDUPE",
    thread_ts: "17000000.memory-passive-dedupe",
  };

  it("does not passively duplicate an existing semantic memory", async ({
    run,
  }) => {
    await clearMemories();
    await seedMemory({
      content: "Prefers PR summaries with risks first.",
      idempotencyKey: "eval-memory-passive-dedupe",
      thread: passiveDedupeThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      events: [
        mention("For PR summaries, I still want risk notes first.", {
          thread: passiveDedupeThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant acknowledges the preference naturally without creating a second remembered copy.",
          "The assistant does not mention hidden storage fields, scope keys, or Slack ids.",
        ],
        fail: [
          "Do not claim a new duplicate memory was saved.",
          "Do not ask the user for Slack ids, actor ids, scope names, or subject ids.",
        ],
      }),
    });

    const rows = await readMemories(passiveDedupeThread);
    expect(rows).toEqual([
      expect.objectContaining({
        archivedAtMs: null,
        content: "Prefers PR summaries with risks first.",
        scope: "personal",
      }),
    ]);
  });

  const removeThread = {
    id: "thread-memory-remove",
    channel_id: "CMEMORYREMOVE",
    thread_ts: "17000000.memory-remove",
  };

  it("when asked to forget a remembered preference, archive the matching memory", async ({
    run,
  }) => {
    await clearMemories();
    await seedMemory({
      content: "Prefers terse PR summaries.",
      idempotencyKey: "eval-memory-remove",
      thread: removeThread,
    });

    await run({
      overrides: memoryPluginOverrides,
      events: [
        mention("Please forget that I prefer terse PR summaries.", {
          thread: removeThread,
        }),
      ],
      criteria: rubric({
        pass: [
          "The assistant understands the forget request and removes the matching remembered preference.",
          "The assistant does not ask the user for hidden ids or scope fields.",
        ],
        fail: [
          "Do not claim the memory was removed if the assistant cannot identify the matching remembered preference.",
          "Do not ask the user for Slack ids, scope keys, or subject ids.",
        ],
      }),
    });

    const memories = await readMemories(removeThread);
    expect(memories).toEqual([
      expect.objectContaining({
        archivedAtMs: expect.any(Number),
        content: "Prefers terse PR summaries.",
      }),
    ]);
    expect(
      memories.filter(
        (memory) =>
          memory.content === "Prefers terse PR summaries." &&
          memory.archivedAtMs === null,
      ),
    ).toEqual([]);
  });
});
