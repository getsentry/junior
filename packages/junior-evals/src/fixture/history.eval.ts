/**
 * Loaded history must look like the rows a real turn writes, so a test that
 * starts from history exercises the same stored state as production.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect } from "vitest";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { mention, reply, webMessage, type Input } from "./inputs";
import { isRecordedConversation } from "./recorded";
import { test, type Conversation, type RunAgent } from "./test";

// Ids, timestamps, and model usage differ between any two turns.
const VOLATILE_KEYS = new Set([
  "authorIdentityId",
  "cacheWrite1h",
  "idempotencyKey",
  "inputMessageIds",
  "messageId",
  "rawStopReason",
  "responseId",
  "slackTs",
  "timestamp",
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
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_KEYS.has(key))
      .map(([key, entry]) => [key, stripVolatile(entry)]),
  );
}

/**
 * Stored rows without volatile fields. A message update folds into its
 * message. Routing and runtime context belong to the run, not the history.
 */
async function comparableRows(conversationId: string): Promise<unknown[]> {
  const rows = await getConversationEventStore().loadHistory(conversationId);
  const messages = new Map<string, Record<string, unknown>>();
  const result: unknown[] = [];
  for (const row of rows) {
    const data = row.data as Record<string, unknown>;
    if (data.type === "turn_routed") continue;
    if (
      data.type === "user_message" &&
      (data.provenance as { authority?: string } | undefined)?.authority ===
        "context"
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
  input: Input,
  rest: Input,
): Promise<void> {
  const real: Conversation = await run(input);
  // A failed real turn leaves nothing valid to compare against.
  expect(real.turns.map((turn) => turn.status)).toEqual(["succeeded"]);
  const replyText = real.turns[0]?.replies[0]?.text;
  expect(replyText).toBeDefined();
  const loaded = await run(rest, {
    history: [input, reply(replyText!)],
  });
  const realRows = await comparableRows(real.conversationId);
  const loadedRows = await comparableRows(loaded.conversationId);
  expect(loadedRows.slice(0, realRows.length)).toEqual(realRows);
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
      mention("Reply with exactly: noted"),
      mention("thanks"),
    );
  });

  test("matches the rows of a real Slack direct message turn", async ({
    run,
  }) => {
    await compareWithRealTurn(
      run,
      mention("Reply with exactly: noted", { channelType: "im" }),
      mention("thanks", { channelType: "im" }),
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
          ? mention(question)
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
