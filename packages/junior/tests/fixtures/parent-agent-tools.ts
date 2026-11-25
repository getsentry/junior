import type { StateAdapter } from "chat";
import { bindMessageAgent } from "@/chat/agent-invocations/message";
import { bindSpawnAgent } from "@/chat/agent-invocations/spawn";
import type { AgentRun, SpawnAgentInput } from "@/chat/agent/types";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { slackInvocationInput } from "./agent-invocations";
import { slackParentRun, type Harness } from "./thread-input";

/** The parent's Turn, as the root Turn code binds it to agent tools. */
export function parentRun(turnId = "parent-turn"): AgentRun {
  return slackParentRun({
    credentialContext: {
      actor: { type: "user", userId: slackInvocationInput.actor.userId },
    },
    turnId,
  });
}

/** Spawn a child from the parent's Turn with `startAgent`. */
export async function spawn(
  harness: Harness,
  toolCallId: string,
  input: Partial<SpawnAgentInput> = {},
  state: StateAdapter = harness.state,
  turnId?: string,
) {
  const { childConversationId } = await bindSpawnAgent(parentRun(turnId), {
    conversationStore: harness.conversationStore,
    queue: harness.queue,
    state,
  })!({ task: "Check the deploy.", ...input }, { toolCallId });
  return childConversationId;
}

/** Send a child a message from the parent's Turn with `messageAgent`. */
export async function message(
  harness: Harness,
  to: string,
  toolCallId: string,
  turnId?: string,
) {
  return await bindMessageAgent(parentRun(turnId), {
    queue: harness.queue,
    state: harness.state,
  })!({ text: "Check it again.", to }, { toolCallId });
}

/** Read the texts that wait in one Conversation's mailbox. */
export async function mailboxTexts(harness: Harness, conversationId: string) {
  return (
    (
      await getConversationWorkState({ conversationId, state: harness.state })
    )?.messages.map((entry) => entry.input.text) ?? []
  );
}
