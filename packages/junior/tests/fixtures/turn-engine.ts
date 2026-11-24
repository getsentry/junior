// The harness of the Turn engine integration tests: one Conversation with one
// queued Turn, an in-process queue that holds the messages core sends, and
// the AI emulator for the model requests. Each test gets its own queue, so
// tests read its messages instead of a worker's.
import { randomUUID } from "node:crypto";
import type { Destination } from "@sentry/junior-plugin-api";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import * as z from "zod";
import { instructionProvenanceFor } from "@/chat/conversations/provenance";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import type { EngineContext } from "@/core/engine-context";
import type { ModelClient, ModelSettings } from "@/core/model/client";
import {
  definePromptLayout,
  inputs,
  type Fragment,
  type FragmentMessage,
  type InputPrompt,
  type PromptLayout,
} from "@/core/prompt/layout";
import type { ToolDefinition } from "@/core/tool";
import { advanceTurn } from "@/core/turn/advance";
import type { UnreadInput } from "@/core/turn/inbox";
import { TURN_STEP_TOPIC } from "@/core/turn/topic";
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
  replyRule,
  setModelRules,
  type ModelRule,
} from "./ai-emulator";
import { createInProcessQueue, type InProcessQueue } from "./in-process-queue";
import { createAssistantMessage } from "./model-stream";
import { ACTOR } from "./turn-harness";

export const CONVERSATION_ID = "slack:C123:1718123456.000000";
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
export const MODEL: ModelSettings = {
  id: "anthropic/claude-opus-5.5",
  reasoning: "none",
  privacy: "private",
};

/**
 * What a test step runs with: the model client, the prompt layout picker, the
 * model settings and the tools. Each one that a test leaves out has a
 * default: no model reply, `testPrompt()` for every Turn, `MODEL` and no
 * tools.
 */
export type Step = Partial<
  Omit<Parameters<typeof advanceTurn>[2], "maxAttempts">
>;

/** The Conversation, its Turn, and the queue of one test. */
export type TurnEngine = {
  fixture: LocalJuniorSqlFixture;
  /** The queue that core sends to. Nothing is delivered until a test asks. */
  queue: InProcessQueue;
  /** The context that core runs with: the test database and its queue. */
  engineCtx: EngineContext;
  turnId: string;
  /** Runs one step of a Turn, by default the test's Turn. */
  advance: (step: Step, leaseMs?: number, forTurnId?: string) => Promise<void>;
  readTurn: () => Promise<typeof juniorTurns.$inferSelect>;
  /** The Conversation history as the model reads it. */
  loadHistory: () => ReturnType<typeof loadMessages>;
  /** Adds an inbox row for the test's Turn, and returns its id. */
  /** Adds an input to the test's Turn. Its answer goes to `destination`. */
  addTestInput: (
    text: string,
    destination?: Destination | null,
  ) => Promise<string>;
  /** Counts the step messages sent for a Turn, by default the test's Turn. */
  sentStepMessages: (forTurnId?: string) => number;
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
  });

  const queue = createInProcessQueue();
  const engineCtx: EngineContext = {
    executor: fixture.sql,
    queue,
    owner: "worker-a",
    leaseMs: LEASE_MS,
  };

  // No consumer takes step messages, so each one that was sent is pending.
  function sentStepMessages(forTurnId = turnId): number {
    return queue
      .pending(TURN_STEP_TOPIC)
      .filter((message) => messageTurnId(message.payload) === forTurnId).length;
  }

  async function readTurn() {
    const [turn] = await fixture.sql
      .db()
      .select()
      .from(juniorTurns)
      .where(eq(juniorTurns.id, turnId));
    return turn!;
  }

  async function addTestInput(
    text: string,
    destination: Destination | null = null,
  ) {
    const inputId = randomUUID();
    await fixture.sql
      .db()
      .insert(juniorTurnInbox)
      .values({
        id: inputId,
        conversationId: CONVERSATION_ID,
        turnId,
        actorIdentityId: "identity:actor",
        source: {
          kind: "slack",
          teamId: "T123",
          channelId: "C123",
          visibility: "public",
        },
        destination,
        payload: { text },
        idempotencyKey: `slack-event:${inputId}`,
        sentAt: new Date(),
      });
    return inputId;
  }

  function advance(step: Step, leaseMs = LEASE_MS, forTurnId = turnId) {
    return advanceTurn(
      { ...engineCtx, leaseMs },
      { turnId: forTurnId },
      {
        client: step.client ?? replyingClient([]),
        prompt: step.prompt ?? promptForEveryTurn(testPrompt()),
        modelSettings: step.modelSettings ?? (() => Promise.resolve(MODEL)),
        tools: step.tools ?? [],
        maxAttempts: MAX_ATTEMPTS,
      },
    );
  }

  return {
    fixture,
    queue,
    engineCtx,
    turnId,
    advance,
    readTurn,
    loadHistory: () => loadMessages(fixture),
    addTestInput,
    sentStepMessages,
    close: () => fixture.close(),
  };
}

const carriedTurnIdSchema = z.looseObject({ turnId: z.string() });

/** The Turn id that a step or delivery message carries. */
export function messageTurnId(payload: unknown): string | undefined {
  const parsed = carriedTurnIdSchema.safeParse(payload);
  return parsed.success ? parsed.data.turnId : undefined;
}

async function loadMessages(fixture: LocalJuniorSqlFixture) {
  const events = await createSqlConversationEventStore(
    fixture.sql,
  ).loadCurrentHistory(CONVERSATION_ID);
  return projectConversationEvents(events).messages;
}

/** Formats an input as an instruction of the test Actor with its text. */
function inputMessage(input: UnreadInput): InputPrompt {
  return {
    message: {
      role: "user",
      content: [{ type: "text", text: String(input.payload["text"]) }],
    },
    provenance: instructionProvenanceFor(ACTOR),
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

/** The test inputs fragment: each input as the test Actor's text. */
export function testInputs() {
  return inputs({ format: inputMessage });
}

/** The test layout: a short system prompt, and `messages` after the history. */
export function testPrompt(
  messages: Fragment<FragmentMessage | FragmentMessage[]>[] = [testInputs()],
): PromptLayout {
  return definePromptLayout({
    systemPrompt: [{ name: "identity", text: "You are Junior." }],
    messages,
  });
}

/** A prompt layout picker that gives `layout` for every Turn. */
export function promptForEveryTurn(
  layout: PromptLayout,
): () => Promise<PromptLayout> {
  return () => Promise.resolve(layout);
}

/** A step whose model gives the replies in order, with `tools`. */
export function stepWith(
  replies: Array<AssistantMessage | ModelRule>,
  tools: ToolDefinition[] = [],
): { client: ModelClient; tools: ToolDefinition[] } {
  return { client: replyingClient(replies), tools };
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
