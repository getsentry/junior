/**
 * The child edge of the agent test fixture: a Thread of a Lead that ends a
 * Turn with a result.
 *
 * The child's model is the only fake. The fixture stores the Thread as a
 * spawn does and records its Turn with the turn lifecycle that a real Turn
 * uses. The Turn saves its task and its final text to agent history, as a
 * real Turn does, so a Turn that reads the Thread later sees them. From the
 * end of that Turn, the product delivers the result to the Lead and runs the
 * Lead's Turn.
 */
import type { WebActor } from "@/chat/actor";
import { getSpawnedChildConversationId } from "@/chat/child-agents/ids";
import {
  commitMessages,
  loadConversationProjection,
} from "@/chat/conversations/projection";
import {
  agentInstructionProvenance,
  contextProvenance,
} from "@/chat/conversations/provenance";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { getConversationEventStore, getConversationStore } from "@/chat/db";
import { renderParentAgentTask } from "@/chat/input-tags";
import { buildDeterministicTurnId } from "@/chat/state/turn-id";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { assistantPiMessage } from "./history";
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
  // Agent history commits take the full history. Each Turn's task is the
  // Thread's title, the only brief that the fixture has.
  const history = await loadConversationProjection({
    conversationId: threadId,
  });
  await commitMessages({
    conversationId: threadId,
    messages: [
      ...history.messages,
      {
        role: "user",
        content: [{ type: "text", text: renderParentAgentTask([input.title]) }],
        timestamp: nowMs,
      },
      assistantPiMessage([{ type: "text", text: input.text }], nowMs + 1),
    ],
    provenance: [
      ...history.provenance,
      agentInstructionProvenance,
      contextProvenance,
    ],
  });
  // A child's Turn that posts no reply answers with its final text.
  await lifecycle.complete({
    answer: { kind: "final_text", text: input.text },
    conversationId: threadId,
    createdAtMs: nowMs + 2,
    outcome: "no_reply",
    reportAs: args.actor,
    turnId,
  });
}
