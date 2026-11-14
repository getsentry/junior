import type { AgentRequestStreamFn } from "@/chat/pi/agent-history";
import type { MessageAttachment } from "@/chat/attachments/input";
import type {
  AgentAttachment,
  AgentEnvironment,
  AgentRun,
} from "@/chat/agent/types";
import type { AgentRunOutcome } from "@/chat/runtime/agent-run-outcome";
import type { SandboxEgressTracePropagationConfig } from "@/chat/sandbox/egress/tracing";
import type { AttachmentStorage } from "@/chat/attachments/storage";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import type { BackgroundCompactionQueue } from "@/chat/services/background-compaction-queue";

/** Run one agent-run slice behind runtime-owned orchestration boundaries. */
export interface AgentRunner {
  run(run: AgentRun): Promise<AgentRunOutcome>;
}

/** Compose the agent executor with stable host dependencies. */
export function createAgentRunner(
  execute: (
    run: AgentRun,
    streamFn?: AgentRequestStreamFn,
  ) => Promise<AgentRunOutcome>,
  options?: {
    attachmentStorage?: AttachmentStorage;
    backgroundCompactionQueue?: BackgroundCompactionQueue;
    bindMessageAgent?: AgentEnvironment["bindMessageAgent"];
    bindSpawnAgent?: AgentEnvironment["bindSpawnAgent"];
    conversationWorkQueue?: ConversationWorkQueue;
    streamFn?: AgentRequestStreamFn;
    tracePropagation?: SandboxEgressTracePropagationConfig;
  },
): AgentRunner {
  const attachmentStorage = options?.attachmentStorage;
  const backgroundCompactionQueue = options?.backgroundCompactionQueue;
  const conversationWorkQueue = options?.conversationWorkQueue;
  const streamFn = options?.streamFn;
  const tracePropagation = options?.tracePropagation;
  const bindSpawnAgent = options?.bindSpawnAgent;
  const bindMessageAgent = options?.bindMessageAgent;
  return {
    run: async (run) => {
      const nextRun: AgentRun = {
        ...run,
        environment: {
          ...run.environment,
          attachmentStorage:
            run.environment?.attachmentStorage ?? attachmentStorage,
          backgroundCompactionQueue:
            run.environment?.backgroundCompactionQueue ??
            backgroundCompactionQueue,
          conversationWorkQueue:
            run.environment?.conversationWorkQueue ?? conversationWorkQueue,
          sandboxTracePropagation:
            run.environment?.sandboxTracePropagation ?? tracePropagation,
          // Tool wiring binds agent tools after it reads the Turn's behavior.
          ...(bindSpawnAgent ? { bindSpawnAgent } : undefined),
          ...(bindSpawnAgent && bindMessageAgent
            ? { bindMessageAgent }
            : undefined),
        },
      };
      // Attachment storage loads runtime config. Keep it behind execution so
      // the local CLI can set its defaults before config is first read.
      const loadStoredAttachments = async (
        attachments: readonly MessageAttachment[],
      ): Promise<AgentAttachment[]> => {
        const { loadInputAttachments } =
          await import("@/chat/attachments/model-input");
        const storage = nextRun.environment?.attachmentStorage;
        if (!storage) throw new Error("Attachment storage is unavailable.");
        return await loadInputAttachments({
          attachments,
          conversationId: run.conversationId,
          storage,
        });
      };
      if (run.instruction.storedAttachments?.length) {
        nextRun.instruction = {
          ...run.instruction,
          attachments: await loadStoredAttachments(
            run.instruction.storedAttachments,
          ),
        };
      }
      const drainSteeringMessages = nextRun.durability?.drainSteeringMessages;
      if (drainSteeringMessages) {
        // Steered web messages carry stored files like the instruction does.
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
                            await loadStoredAttachments(storedAttachments),
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
