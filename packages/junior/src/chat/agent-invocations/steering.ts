/**
 * Input of one agent invocation as its child Run reads it, and the steering
 * drain that gives queued parent tasks to a running Run.
 */
import { isDeepStrictEqual } from "node:util";
import * as z from "zod";
import {
  buildSteeringPiMessage,
  withoutSavedSteeringMessages,
} from "@/chat/agent/prompt";
import type { AgentSteeringMessage } from "@/chat/agent/types";
import {
  agentInstructionProvenance,
  contextProvenance,
  sameActorIdentity,
} from "@/chat/conversations/provenance";
import { escapeClosingTags, renderTag } from "@/chat/input-tags";
import { getTurnRecord } from "@/chat/task-execution/checkpoint";
import type { ConversationWorkerContext } from "@/chat/task-execution/worker";
import { agentTypeInstructions } from "./agent-types";
import { getAgentInvocationTurnId } from "./ids";
import { finishAgentInvocation } from "./finish";
import { recordSubagentEnded } from "./markers";
import {
  appendAgentInvocationReport,
  getAgentInvocation,
  isParentTask,
  isTerminalAgentInvocation,
} from "./store";
import type { AgentInvocation } from "./types";

/** Mailbox metadata of child work that references one agent invocation. */
export const agentInvocationMailboxMetadataSchema = z
  .object({
    agentInvocationId: z.string().min(1),
    kind: z.literal("agent_invocation"),
  })
  .strict();

/**
 * Text that the child agent model reads for one agent invocation. A parent
 * agent task or message becomes one `<parent-agent-task>`. Results of the
 * child's own child agents already have their own tag.
 */
export function agentInvocationInputText(
  invocation: Pick<AgentInvocation, "agentType" | "input" | "parentToolCallId">,
): string {
  if (!isParentTask(invocation)) {
    return invocation.input;
  }
  const typeInstructions = agentTypeInstructions(invocation.agentType);
  return renderTag("parent-agent-task", {}, [
    ...(typeInstructions ? [escapeClosingTags(typeInstructions), ""] : []),
    escapeClosingTags(invocation.input),
  ]);
}

/**
 * A parent agent task or message is the child's instruction. Another input,
 * such as a result of the child's own child agent or an Event, is context.
 */
export function agentInvocationProvenance(
  invocation: Pick<AgentInvocation, "parentToolCallId">,
) {
  return isParentTask(invocation)
    ? agentInstructionProvenance
    : contextProvenance;
}

/**
 * Give queued parent messages to the running agent invocation of a child as
 * steering messages. A message joins only with the Actor and credentials of
 * the running Turn. The first message that does not match stops the scan, so
 * it and every later message wait for the current work. Each message that
 * joins ends as `steered`, and the running agent invocation reports for it.
 * It also marks the running agent invocation's reports, so later reports
 * answer the new task.
 */
export function createAgentMessageSteeringDrain(
  context: ConversationWorkerContext,
  running: AgentInvocation,
) {
  const turnId = getAgentInvocationTurnId(running.invocationId);
  return async (
    accept: (messages: AgentSteeringMessage[]) => Promise<void>,
  ): Promise<AgentSteeringMessage[]> => {
    const accepted: AgentSteeringMessage[] = [];
    await context.attempt.drain(
      async (pending) => {
        const readIds: string[] = [];
        const joining: AgentInvocation[] = [];
        for (const message of pending) {
          const metadata = agentInvocationMailboxMetadataSchema.safeParse(
            message.input.metadata,
          );
          if (!metadata.success) {
            continue;
          }
          const candidate = await getAgentInvocation(
            metadata.data.agentInvocationId,
          );
          // Only a parent task or message steers. A grandchild result or a
          // watch event starts its own agent invocation.
          if (
            !candidate ||
            !isParentTask(candidate) ||
            candidate.invocationId === running.invocationId
          ) {
            continue;
          }
          if (isTerminalAgentInvocation(candidate)) {
            // An earlier drain ended this task but did not acknowledge its
            // message, and may have failed before the parent saw the end.
            await recordSubagentEnded(candidate);
            readIds.push(message.inboundMessageId);
            continue;
          }
          if (
            !sameActorIdentity(candidate.actor, running.actor) ||
            !isDeepStrictEqual(
              candidate.credentialContext,
              running.credentialContext,
            )
          ) {
            break;
          }
          joining.push(candidate);
          readIds.push(message.inboundMessageId);
        }
        if (joining.length === 0) {
          return readIds;
        }
        // An earlier drain can save a message in the Turn and then fail
        // before it marks the agent invocation. Do not give it to the Turn
        // again.
        const saved =
          (await getTurnRecord(running.childConversationId, turnId))
            ?.piMessages ?? [];
        const messages = withoutSavedSteeringMessages(
          saved,
          joining.map(
            (candidate): AgentSteeringMessage => ({
              kind: "runtime",
              provenance: agentInvocationProvenance(candidate),
              text: agentInvocationInputText(candidate),
              timestampMs: candidate.createdAtMs,
            }),
          ),
          buildSteeringPiMessage,
        );
        // Reports after a `steered_task` entry answer that task, so the
        // reply gate and the result can tell them from earlier ones. The
        // entry goes first, so no report about the task can come before it.
        for (const candidate of joining) {
          await appendAgentInvocationReport(running.invocationId, {
            invocationId: candidate.invocationId,
            kind: "steered_task",
          });
        }
        // The Turn saves the messages before they are marked.
        if (messages.length > 0) {
          await accept(messages);
          accepted.push(...messages);
        }
        for (const candidate of joining) {
          const terminal = await finishAgentInvocation({
            invocationId: candidate.invocationId,
            status: "completed",
            steered: true,
          });
          if (terminal && isTerminalAgentInvocation(terminal)) {
            await recordSubagentEnded(terminal);
          }
        }
        return readIds;
      },
      { deferred: true },
    );
    return accepted;
  };
}
