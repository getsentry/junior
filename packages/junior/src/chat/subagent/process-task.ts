import { enqueueThreadMessage } from "@/chat/queue/client";
import type { SubagentTaskPayload, ThreadMessagePayload } from "@/chat/queue/types";
import { generateAssistantReply } from "@/chat/respond";
import { getSubagentTaskRecord, upsertSubagentTaskRecord } from "@/chat/state";

function buildResumeDedupKey(payload: SubagentTaskPayload): string {
  return `${payload.queueContext.dedupKey}:subagent:${payload.callKey}`;
}

export async function processSubagentTask(payload: SubagentTaskPayload): Promise<void> {
  const existing = await getSubagentTaskRecord(payload.callKey);
  if (existing?.status === "completed" || existing?.status === "failed") {
    return;
  }

  await upsertSubagentTaskRecord({
    callKey: payload.callKey,
    conversationId: payload.conversationId,
    sessionId: payload.sessionId,
    dedupKey: payload.queueContext.dedupKey,
    normalizedThreadId: payload.queueContext.normalizedThreadId,
    task: payload.task,
    status: "running",
    message: payload.queueContext.message,
    thread: payload.queueContext.thread
  });

  try {
    const reply = await generateAssistantReply(payload.task, {
      requester: {
        userId: payload.queueContext.message.author?.userId,
        userName: payload.queueContext.message.author?.userName,
        fullName: payload.queueContext.message.author?.fullName
      },
      correlation: {
        conversationId: payload.conversationId,
        threadId: payload.queueContext.normalizedThreadId,
        turnId: payload.sessionId,
        channelId: payload.queueContext.thread.channelId,
        messageTs: payload.queueContext.message.id,
        threadTs: payload.queueContext.message.threadId,
        requesterId: payload.queueContext.message.author?.userId
      },
      toolChannelId: payload.queueContext.thread.channelId,
      queueContext: payload.queueContext,
      isSubagentExecution: true
    });

    await upsertSubagentTaskRecord({
      callKey: payload.callKey,
      conversationId: payload.conversationId,
      sessionId: payload.sessionId,
      dedupKey: payload.queueContext.dedupKey,
      normalizedThreadId: payload.queueContext.normalizedThreadId,
      task: payload.task,
      status: "completed",
      resultText: reply.text,
      message: payload.queueContext.message,
      thread: payload.queueContext.thread
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await upsertSubagentTaskRecord({
      callKey: payload.callKey,
      conversationId: payload.conversationId,
      sessionId: payload.sessionId,
      dedupKey: payload.queueContext.dedupKey,
      normalizedThreadId: payload.queueContext.normalizedThreadId,
      task: payload.task,
      status: "failed",
      errorMessage,
      message: payload.queueContext.message,
      thread: payload.queueContext.thread
    });
  }

  const stored = await getSubagentTaskRecord(payload.callKey);
  if (!stored) {
    return;
  }

  const resumePayload: ThreadMessagePayload = {
    dedupKey: buildResumeDedupKey(payload),
    kind: "subscribed_reply",
    normalizedThreadId: stored.normalizedThreadId,
    message: stored.message,
    thread: stored.thread
  };
  await enqueueThreadMessage(resumePayload, {
    idempotencyKey: `subagent-resume:${payload.callKey}`
  });
}
