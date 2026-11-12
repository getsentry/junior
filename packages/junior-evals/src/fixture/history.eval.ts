/**
 * Loaded history must look like the rows a real turn writes, so a test that
 * starts from history exercises the same stored state as production.
 */
import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { describe, expect } from "vitest";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { NO_REPLY_TOOL_NAME } from "@/chat/no-reply";
import { slackMention, reply, webMessage, type MessageInput } from "./inputs";
import { isRecordedConversation } from "./recorded";
import {
  test,
  type Conversation,
  type RunAgent,
  type TurnStatus,
} from "./test";

// Ids, timestamps, and model usage differ between any two turns.
const VOLATILE_KEYS = new Set([
  "authorIdentityId",
  "cacheWrite1h",
  "id",
  "idempotencyKey",
  "inputMessageIds",
  "messageId",
  "rawStopReason",
  "responseId",
  "slackTs",
  "timestamp",
  "toolCallId",
  "turnId",
  "usage",
]);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter(
        (part) =>
          !(
            part &&
            typeof part === "object" &&
            "type" in part &&
            part.type === "thinking" &&
            "thinking" in part &&
            part.thinking === ""
          ),
      )
      .map(stripVolatile);
  }
  if (typeof value === "string") {
    return value.replace(/ slack_ts="[^"]*"/g, "");
  }
  if (!value || typeof value !== "object") return value;
  // The model may give `noReply` a note, which loaded history cannot know.
  // A person's Turn keeps only the call, so its input and output are free
  // text, like a reply.
  const noReplyKeys =
    "name" in value && value.name === NO_REPLY_TOOL_NAME
      ? ["arguments"]
      : "toolName" in value && value.toolName === NO_REPLY_TOOL_NAME
        ? ["content", "details"]
        : [];
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_KEYS.has(key) && !noReplyKeys.includes(key))
      .map(([key, entry]) => [key, stripVolatile(entry)]),
  );
}

/**
 * Stored rows without volatile fields. A message update folds into its
 * message. Runtime context belongs to the run, not the history. Model cost
 * events record what a call spent, such as the title, and loaded history
 * spent nothing.
 */
async function comparableRows(conversationId: string): Promise<unknown[]> {
  const rows = await getConversationEventStore().loadHistory(conversationId);
  const messages = new Map<string, Record<string, unknown>>();
  const result: unknown[] = [];
  for (const row of rows) {
    const data = row.data as Record<string, unknown>;
    if (
      data.type === "user_message" &&
      (data.provenance as { authority?: string } | undefined)?.authority ===
        "context"
    ) {
      continue;
    }
    if (
      data.type === "structured_event" &&
      typeof (data.content as { costUsd?: unknown } | undefined)?.costUsd ===
        "number"
    ) {
      continue;
    }
    if (data.type === "message_updated") {
      Object.assign(messages.get(String(data.messageId)) ?? {}, {
        ...data,
        type: "message",
      });
      continue;
    }
    const copy = { ...data };
    if (data.type === "message") messages.set(String(data.messageId), copy);
    result.push(copy);
  }
  return result.map(stripVolatile);
}

async function compareWithRealTurn(
  run: RunAgent,
  input: MessageInput,
  rest: MessageInput,
  status: TurnStatus = "succeeded",
): Promise<void> {
  const real: Conversation = await run(input);
  // Any other real turn leaves nothing valid to compare against.
  expect(real.turns.map((turn) => turn.status)).toEqual([status]);
  const replies = real.turns[0]!.replies.map((realReply) =>
    reply(realReply.text),
  );
  const loaded = await run(rest, { history: [input, ...replies] });
  const realRows = await comparableRows(real.conversationId);
  const loadedRows = await comparableRows(loaded.conversationId);
  const loadedPrefix = loadedRows.slice(0, realRows.length);
  // The eval reporter truncates the deep-equal diff, so the message names the
  // first row that differs in full.
  const differing = realRows.findIndex(
    (row, index) => !isDeepStrictEqual(loadedPrefix[index], row),
  );
  expect(
    loadedPrefix,
    differing === -1
      ? undefined
      : `row ${differing}\nreal: ${JSON.stringify(realRows[differing])}\nloaded: ${JSON.stringify(loadedPrefix[differing])}`,
  ).toEqual(realRows);
  const store = getConversationStore();
  expect(
    (await store.get({ conversationId: loaded.conversationId }))?.visibility,
  ).toBe(
    (await store.get({ conversationId: real.conversationId }))?.visibility,
  );
}

describe("loaded history", () => {
  test("matches the rows of a real web turn", async ({ run }) => {
    await compareWithRealTurn(
      run,
      webMessage("Reply with exactly: noted"),
      webMessage("thanks"),
    );
  });

  test("matches the rows of a real Slack turn", async ({ run }) => {
    await compareWithRealTurn(
      run,
      slackMention("Reply with exactly: noted"),
      slackMention("thanks"),
    );
  });

  test("matches the rows of a real Slack turn without a reply", async ({
    run,
  }) => {
    // Slack ingress escapes markdown, such as the brackets and underscore.
    await compareWithRealTurn(
      run,
      slackMention(
        "Note for the thread: the [draft] is in launch_notes.md. Do not reply to this and do not react.",
      ),
      slackMention("thanks"),
      "no_reply",
    );
  });

  test("matches the rows of a real Slack direct message turn", async ({
    run,
  }) => {
    await compareWithRealTurn(
      run,
      slackMention("Reply with exactly: noted", { channelType: "im" }),
      slackMention("thanks", { channelType: "im" }),
    );
  });
});

const RECORDINGS_DIR = new URL("./recordings/", import.meta.url);

describe("recorded conversations", () => {
  for (const file of readdirSync(RECORDINGS_DIR).filter((name) =>
    name.endsWith(".json"),
  )) {
    test(`continues ${file}`, async ({ run }) => {
      const recording: unknown = JSON.parse(
        readFileSync(new URL(file, RECORDINGS_DIR), "utf8"),
      );
      if (!isRecordedConversation(recording)) {
        throw new Error(`${file} is not a recorded conversation`);
      }
      const question = "In one sentence, what did we decide so far?";
      const conversation = await run(
        recording.surface === "slack"
          ? slackMention(question)
          : webMessage(question),
        { history: recording },
      );

      expect(conversation.turns.map((turn) => turn.status)).toEqual([
        "succeeded",
      ]);
      expect(conversation.replies).toHaveLength(1);
    });
  }
});
