import { Type } from "@sinclair/typebox";
import { enqueueSubagentTask } from "@/chat/queue/client";
import type { QueueResumeContext, SubagentTaskPayload } from "@/chat/queue/types";
import { getSubagentTaskRecord, upsertSubagentTaskRecord } from "@/chat/state";
import { tool } from "@/chat/tools/definition";
import { RetryableTurnError } from "@/chat/turn/errors";

function buildSubagentCallKey(input: {
  conversationId?: string;
  sessionId?: string;
  toolCallId?: string;
}): string | undefined {
  if (!input.conversationId || !input.sessionId || !input.toolCallId) {
    return undefined;
  }
  return `${input.conversationId}:${input.sessionId}:${input.toolCallId}`;
}

function requireQueueContext(value: QueueResumeContext | undefined): QueueResumeContext {
  if (!value) {
    throw new Error("taskSubagent requires queue message context");
  }
  return value;
}

export function createTaskSubagentTool() {
  return tool({
    description:
      "Delegate a scoped task to a background subagent worker. Use this for longer recon/planning/review tasks that may outlive one serverless turn.",
    inputSchema: Type.Object({
      task: Type.String({
        minLength: 1,
        maxLength: 8_000,
        description: "Delegated task instructions."
      })
    }),
    execute: async ({ task }, options) => {
      const callKey = buildSubagentCallKey({
        conversationId: options.conversationId,
        sessionId: options.sessionId,
        toolCallId: options.toolCallId
      });
      if (!callKey) {
        throw new Error("taskSubagent requires conversation/session/tool call identifiers");
      }
      const queueContext = requireQueueContext(options.queueContext);

      const existing = await getSubagentTaskRecord(callKey);
      if (existing?.status === "completed") {
        return {
          ok: true,
          call_key: callKey,
          status: existing.status,
          output: existing.resultText ?? ""
        };
      }
      if (existing?.status === "failed") {
        throw new Error(existing.errorMessage ?? "Delegated subagent task failed");
      }

      if (!existing) {
        const payload: SubagentTaskPayload = {
          callKey,
          conversationId: options.conversationId!,
          sessionId: options.sessionId!,
          task,
          queueContext
        };

        await upsertSubagentTaskRecord({
          callKey,
          conversationId: payload.conversationId,
          sessionId: payload.sessionId,
          dedupKey: payload.queueContext.dedupKey,
          normalizedThreadId: payload.queueContext.normalizedThreadId,
          task: payload.task,
          status: "queued",
          message: payload.queueContext.message,
          thread: payload.queueContext.thread
        });

        await enqueueSubagentTask(payload, { idempotencyKey: callKey });
      }

      throw new RetryableTurnError("subagent_task_deferred", `subagent task pending call_key=${callKey}`);
    }
  });
}
