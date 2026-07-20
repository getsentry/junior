import { expect } from "vitest";
import { assistantMessages } from "vitest-evals";
import { getDb } from "@/chat/db";
import { completeText, resolveGatewayModel } from "@/chat/pi/client";
import { createMemoryStore, type MemoryDb } from "@sentry/junior-memory";
import { createSlackSource, type PluginModel } from "@sentry/junior-plugin-api";
import {
  juniorMemoryEmbeddings,
  juniorMemoryMemories,
} from "../../../junior-memory/src/db/schema";
import { TEST_USER_ID } from "@junior-tests/fixtures/slack/factories/ids";

export const memoryPluginOverrides = {
  plugin_packages: ["@sentry/junior-memory"],
};
const memoryTeamId = "TEVAL";
const actorUserId = TEST_USER_ID;
const memoryJudgeModelId = resolveGatewayModel("openai/gpt-5.4").id;

export interface MemoryThread {
  channel_type?: "channel" | "group" | "im" | "mpim";
  channel_id: string;
  id: string;
  thread_ts: string;
}

export async function seedMemory(args: {
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

export const evalMemoryModel: PluginModel = {
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

export async function readMemories(thread: MemoryThread) {
  const rows = await memoryDb()
    .select()
    .from(juniorMemoryMemories)
    .orderBy(juniorMemoryMemories.createdAtMs, juniorMemoryMemories.id);
  return rows.filter((memory) => memory.sourceKey === memorySourceKey(thread));
}

export async function clearMemories() {
  await memoryDb().delete(juniorMemoryEmbeddings);
  await memoryDb().delete(juniorMemoryMemories);
}

export function visibleAssistantText(result: {
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

export async function expectActorMemorySemantics(
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

export async function expectConversationMemorySemantics(
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

export async function expectAssistantMemoryAnswer(args: {
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
