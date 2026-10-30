import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { MessageAttachment } from "@/chat/attachments/input";
import {
  isAgentRunFeatureDisabled,
  type AgentAttachment,
  type AgentRun,
  type MessageAgent,
  type SpawnAgent,
} from "@/chat/agent/types";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { AttachmentStorage } from "@/chat/attachments/storage";

/** Run one agent-run slice behind runtime-owned orchestration boundaries. */
export interface AgentRunner {
  run(run: AgentRun): Promise<AgentRunOutcome>;
}

/** Compose the agent executor with stable host dependencies. */
export function createAgentRunner(
  execute: (run: AgentRun, streamFn?: StreamFn) => Promise<AgentRunOutcome>,
  options?: {
    attachmentStorage?: AttachmentStorage;
    bindMessageAgent?: (run: AgentRun) => MessageAgent | undefined;
    bindSpawnAgent?: (run: AgentRun) => SpawnAgent | undefined;
    streamFn?: StreamFn;
    tracePropagation?: SandboxEgressTracePropagationConfig;
  },
): AgentRunner {
  const attachmentStorage = options?.attachmentStorage;
  const streamFn = options?.streamFn;
  const tracePropagation = options?.tracePropagation;
  const bindSpawnAgent = options?.bindSpawnAgent;
  const bindMessageAgent = options?.bindMessageAgent;
  return {
    run: async (run) => {
      const spawnAgent =
        bindSpawnAgent &&
        !isAgentRunFeatureDisabled(run.disabledFeatures, "subagents")
          ? bindSpawnAgent(run)
          : undefined;
      // A child agent can always message its parent, even when it is too deep
      // to start child agents of its own.
      const messageAgent =
        bindMessageAgent &&
        bindSpawnAgent &&
        (spawnAgent || run.parentConversationId)
          ? bindMessageAgent(run)
          : undefined;
      const nextRun: AgentRun = {
        ...run,
        environment: {
          ...run.environment,
          attachmentStorage:
            run.environment?.attachmentStorage ?? attachmentStorage,
          sandboxTracePropagation:
            run.environment?.sandboxTracePropagation ?? tracePropagation,
        },
        ...(spawnAgent || messageAgent
          ? {
              durability: {
                ...run.durability,
                ...(spawnAgent ? { spawnAgent } : undefined),
                ...(messageAgent ? { messageAgent } : undefined),
              },
            }
          : undefined),
      };
      // Image storage loads runtime config. Keep it behind execution so the
      // local CLI can set its defaults before config is first read.
      const loadStoredImages = async (
        attachments: readonly MessageAttachment[],
      ): Promise<AgentAttachment[]> => {
        const { loadInputImages } = await import("@/chat/attachments/images");
        const storage = nextRun.environment?.attachmentStorage;
        if (!storage) throw new Error("Attachment storage is unavailable.");
        return await loadInputImages({
          attachments,
          conversationId: run.conversationId,
          storage,
        });
      };
      if (run.instruction.storedAttachments?.length) {
        nextRun.instruction = {
          ...run.instruction,
          attachments: await loadStoredImages(
            run.instruction.storedAttachments,
          ),
        };
      }
      const drainSteeringMessages = nextRun.durability?.drainSteeringMessages;
      if (drainSteeringMessages) {
        // Steered web messages carry stored images like the instruction does.
        nextRun.durability = {
          ...nextRun.durability,
          drainSteeringMessages: (accept) =>
            drainSteeringMessages(async (messages) =>
              accept(
                await Promise.all(
                  messages.map(async ({ storedAttachments, ...message }) =>
                    storedAttachments?.length
                      ? {
                          ...message,
                          attachments:
                            await loadStoredImages(storedAttachments),
                        }
                      : message,
                  ),
                ),
              ),
            ),
        };
      }
      return await execute(nextRun, streamFn);
    },
  };
}
