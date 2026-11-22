// The harness of the Turn engine integration tests: one Conversation with one
// queued Turn, a BullMQ worker that takes the step messages, and the AI
// emulator for the model requests. Chat config reads the queue provider when
// it loads, so a test file sets the queue env in `vi.hoisted` before this
// module loads. CI runs Redis at REDIS_URL. Locally,
// compose.yaml runs it on port 6382. Each file that starts this worker uses its
// own Redis database, because the topic is fixed. One job at a time keeps
// deliveries in send order, so the marker of `deliveredStepMessages` comes
// last.
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import * as z from "zod";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import { getQueueProvider } from "@/chat/queue/provider";
import type { ModelClient, ModelSettings } from "@/core/model/client";
import type { ToolDefinition } from "@/core/tool";
import { advanceTurn } from "@/core/turn/advance";
import type { InputMessage, UnreadInput } from "@/core/turn/inbox";
import { TURN_STEP_TOPIC, createTurnStepConsumer } from "@/core/turn/queue";
import {
  juniorConversations,
  juniorIdentities,
  juniorTurnInbox,
  juniorTurns,
} from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createJuniorSqlFixture,
  type LocalJuniorSqlFixture,
} from "./sql";
import {
  emulatedModelClient,
  setModelRules,
  type ModelRule,
} from "./ai-emulator";
import { createAssistantMessage } from "./model-stream";

export const CONVERSATION_ID = "slack:C123:1718123456.000000";
export const ACTOR = {
  platform: "slack",
  teamId: "T123",
  userId: "U123",
} as const;
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const MODEL: ModelSettings = {
  id: "anthropic/claude-opus-5.5",
  reasoning: "none",
  privacy: "private",
};

const carriedPayloadSchema = z.looseObject({
  turnId: z.string(),
  marker: z.literal(true).optional(),
});

export type Prepare = Parameters<typeof advanceTurn>[2]["prepare"];

/** How a test prepares a step, and the model client that the step uses. */
export type Step = { prepare: Prepare; client?: ModelClient };

/** The Conversation, its Turn, and the queue worker of one test. */
export type TurnEngine = {
  fixture: LocalJuniorSqlFixture;
  turnId: string;
  /** Runs one step of a Turn, by default the test's Turn. */
  advance: (step: Step, leaseMs?: number, forTurnId?: string) => Promise<void>;
  readTurn: () => Promise<typeof juniorTurns.$inferSelect>;
  /** The Conversation history as the model reads it. */
  loadHistory: () => ReturnType<typeof loadMessages>;
  /** Adds an inbox row for the test's Turn, and returns its id. */
  addTestInput: (text: string) => Promise<string>;
  /**
   * Waits until every step message sent so far is delivered, and counts
   * those of one Turn, by default the test's Turn. Call it once per test.
   */
  deliveredStepMessages: (forTurnId?: string) => Promise<number>;
  close: () => Promise<void>;
};

/** Starts the harness of one test. */
export async function startTurnEngine(): Promise<TurnEngine> {
  const fixture = await createJuniorSqlFixture();
  await fixture.sql.db().insert(juniorIdentities).values({
    createdAt: new Date(),
    id: "identity:actor",
    kind: "user",
    provider: "slack",
    providerSubjectId: "U123",
    providerTenantId: "T123",
    updatedAt: new Date(),
  });
  await fixture.sql
    .db()
    .insert(juniorConversations)
    .values(buildJuniorSqlConversation({ conversationId: CONVERSATION_ID }));
  const turnId: string = randomUUID();
  await fixture.sql.db().insert(juniorTurns).values({
    id: turnId,
    conversationId: CONVERSATION_ID,
    actorIdentityId: "identity:actor",
    state: "queued",
    priority: 0,
    source: "slack",
  });

  // The Turn ids of the step messages, and the marker of a delivery check.
  const stepMessages: string[] = [];
  let markerSeen = false;
  const provider = getQueueProvider();
  if (!provider.startWorker) {
    throw new Error("The BullMQ provider must start workers");
  }
  // The topic is fixed, so a count takes only the messages of one Turn.
  const worker = await provider.startWorker([
    {
      ...createTurnStepConsumer(() => Promise.resolve()).consumer,
      handler: async (payload) => {
        const parsed = carriedPayloadSchema.safeParse(payload);
        if (!parsed.success) {
          return;
        }
        if (!parsed.data.marker) {
          stepMessages.push(parsed.data.turnId);
        } else if (parsed.data.turnId === turnId) {
          markerSeen = true;
        }
      },
    },
  ]);

  async function deliveredStepMessages(forTurnId = turnId): Promise<number> {
    await getQueueProvider().send(TURN_STEP_TOPIC, { turnId, marker: true });
    const deadline = Date.now() + 10_000;
    while (!markerSeen) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for queue delivery");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return stepMessages.filter((id) => id === forTurnId).length;
  }

  async function readTurn() {
    const [turn] = await fixture.sql
      .db()
      .select()
      .from(juniorTurns)
      .where(eq(juniorTurns.id, turnId));
    return turn!;
  }

  async function addTestInput(text: string) {
    const inputId = randomUUID();
    await fixture.sql
      .db()
      .insert(juniorTurnInbox)
      .values({
        id: inputId,
        conversationId: CONVERSATION_ID,
        turnId,
        actorIdentityId: "identity:actor",
        payload: { text },
        idempotencyKey: `slack-event:${inputId}`,
        sentAt: new Date(),
      });
    return inputId;
  }

  function advance(step: Step, leaseMs = LEASE_MS, forTurnId = turnId) {
    return advanceTurn(
      fixture.sql,
      { turnId: forTurnId },
      {
        client: step.client ?? replyingClient([]),
        prepare: step.prepare,
        owner: "worker-a",
        leaseMs,
        maxAttempts: MAX_ATTEMPTS,
      },
    );
  }

  return {
    fixture,
    turnId,
    advance,
    readTurn,
    loadHistory: () => loadMessages(fixture),
    addTestInput,
    deliveredStepMessages,
    close: async () => {
      await worker.close();
      await fixture.close();
    },
  };
}

async function loadMessages(fixture: LocalJuniorSqlFixture) {
  const events = await createSqlConversationEventStore(
    fixture.sql,
  ).loadCurrentHistory(CONVERSATION_ID);
  return projectConversationEvents(events).messages;
}

/** Formats an input as an instruction of the test Actor with its text. */
function inputMessage(input: UnreadInput): InputMessage {
  return {
    inputId: input.inputId,
    message: {
      role: "user",
      content: [{ type: "text", text: String(input.payload["text"]) }],
      timestamp: input.sentAt.getTime(),
    },
    provenance: instructionProvenanceFor(ACTOR),
  };
}

/**
 * The emulator rule that answers with the text and tool calls of a reply.
 * Tool calls keep their ids.
 */
function replyRule(reply: AssistantMessage): ModelRule {
  if (reply.stopReason !== "stop" && reply.stopReason !== "toolUse") {
    throw new Error(`The emulator cannot end a reply with ${reply.stopReason}`);
  }
  return {
    reply: reply.content.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text };
      }
      if (part.type === "toolCall") {
        return {
          type: "tool_call",
          name: part.name,
          arguments: part.arguments,
          id: part.id,
        };
      }
      throw new Error(`The emulator cannot reply with ${part.type}`);
    }),
  };
}

/**
 * A model client whose requests the emulator answers with the replies in
 * order, one per request. A reply is a model reply or an emulator rule, such
 * as a fault.
 */
function replyingClient(
  replies: Array<AssistantMessage | ModelRule>,
): ModelClient {
  const client = emulatedModelClient();
  const rules = replies.map((reply) =>
    "role" in reply ? replyRule(reply) : reply,
  );
  return {
    complete: async (request, signal) => {
      const rule = rules.shift();
      if (!rule) {
        throw new Error("No model reply is left for this request");
      }
      await setModelRules([{ ...rule, times: 1 }]);
      return client.complete(request, signal);
    },
  };
}

/**
 * Matches the stored form of a reply that the emulator gave. The stored
 * reply also has the usage and ids of the emulator's response.
 */
export function storedReply(reply: AssistantMessage) {
  return expect.objectContaining({
    role: "assistant",
    content: reply.content,
    stopReason: reply.stopReason,
  });
}

/** Matches the stored form of an input with its text. */
export function userText(text: string) {
  return expect.objectContaining({
    role: "user",
    content: [{ type: "text", text }],
  });
}

/** A step whose model gives the replies in order. */
export function prepareWith(
  replies: Array<AssistantMessage | ModelRule>,
  tools: ToolDefinition[] = [],
): Required<Step> {
  return {
    prepare: (_turn, inputs) =>
      Promise.resolve({
        systemPrompt: "You are Junior.",
        tools,
        model: MODEL,
        inputs: inputs.map(inputMessage),
      }),
    client: replyingClient(replies),
  };
}

/** A tool that must not run twice, which records each call it runs. */
export function sendTool(executed: string[]): ToolDefinition {
  return {
    name: "send",
    description: "Sends a message.",
    parameters: { type: "object", properties: {} },
    replay: "never",
    execute: (_args, { callId }) => {
      executed.push(callId);
      return Promise.resolve({ content: [{ type: "text", text: "sent" }] });
    },
  };
}

/** A reply that calls `send` once, as `call-1`. */
export function sendCallReply(): AssistantMessage {
  return createAssistantMessage({
    type: "toolCalls",
    calls: [{ name: "send", arguments: {}, id: "call-1" }],
  });
}
