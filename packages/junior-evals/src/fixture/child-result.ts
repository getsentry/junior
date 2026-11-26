/**
 * The child edge of the agent test fixture: a Thread of a Lead that ends a
 * Turn with a result.
 *
 * The child's model is the only fake. The fixture stores the Thread as a
 * spawn does and records its Turn with the turn lifecycle that a real Turn
 * uses, with the result as the Turn's final text. From the end of that Turn,
 * the product delivers the result to the Lead and runs the Lead's Turn.
 */
import type { WebActor } from "@/chat/actor";
import { getSpawnedChildConversationId } from "@/chat/child-agents/ids";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { fixtureId } from "./ids";
import type { ChildResultInput } from "./inputs";

/**
 * Send one result of a Thread of the Lead. The first result with a title
 * starts that Thread. `actor` is the member whose Turn started the Thread, so
 * the Lead's Turn for the result runs as that member, as after its own
 * `startAgent` call.
 */
export async function sendChildResult(args: {
  actor: WebActor;
  input: ChildResultInput;
  leadConversationId: string;
  queue: ConversationWorkQueue;
  /** Thread ids of the Lead by title, for later results of the same Thread. */
  threads: Map<string, string>;
}): Promise<void> {
  const { input, leadConversationId } = args;
  let threadId = args.threads.get(input.title);
  if (!threadId) {
    threadId = getSpawnedChildConversationId(
      leadConversationId,
      fixtureId("child-thread", 32),
    );
    // A Lead's child stores an agent config, so the Lead can list and
    // message it.
    await getConversationStore().createChild({
      childConversationId: threadId,
      kind: "thread",
      parentConversationId: leadConversationId,
      source: "internal",
      title: input.title,
    });
    args.threads.set(input.title, threadId);
  }
  const lifecycle = new ConversationTurnLifecycleService(
    getConversationEventStore(),
    { watchQueue: () => args.queue },
  );
  const inputMessageId = `child-result:${fixtureId("child-result", 24)}`;
  const turnId = buildDeterministicTurnId(inputMessageId);
  const nowMs = Date.now();
  await lifecycle.start({
    conversationId: threadId,
    createdAtMs: nowMs,
    inputMessageIds: [inputMessageId],
    surface: "internal",
    turnId,
  });
  // A child's Turn that posts no reply answers with its final text.
  await lifecycle.complete({
    answer: { kind: "final_text", text: input.text },
    conversationId: threadId,
    createdAtMs: nowMs + 1,
    outcome: "no_reply",
    reportAs: args.actor,
    turnId,
  });
}
