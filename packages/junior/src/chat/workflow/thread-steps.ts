import { Message, ThreadImpl } from "chat";
import type { SerializedMessage, SerializedThread, Thread } from "chat";
import { WORKFLOW_DESERIALIZE } from "@workflow/serde";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

let stateAdapterConnected = false;

function rehydrateAttachmentFetchers(
  payload: { message: { attachments: Array<{ fetchData?: () => Promise<Buffer>; url?: string }> } },
  downloadPrivateFile: (url: string) => Promise<Buffer>
): void {
  for (const attachment of payload.message.attachments) {
    if (!attachment.fetchData && attachment.url) {
      attachment.fetchData = () => downloadPrivateFile(attachment.url as string);
    }
  }
}

function isSerializedThread(thread: ThreadMessagePayload["thread"]): thread is SerializedThread {
  return typeof thread === "object" && thread !== null && (thread as { _type?: unknown })._type === "chat:Thread";
}

function isSerializedMessage(message: ThreadMessagePayload["message"]): message is SerializedMessage {
  return typeof message === "object" && message !== null && (message as { _type?: unknown })._type === "chat:Message";
}

function toRuntimeThread(thread: ThreadMessagePayload["thread"]): Thread {
  if (isSerializedThread(thread)) {
    return ThreadImpl[WORKFLOW_DESERIALIZE](thread);
  }
  return thread;
}

function toRuntimeMessage(message: ThreadMessagePayload["message"]): Message {
  if (isSerializedMessage(message)) {
    return Message[WORKFLOW_DESERIALIZE](message);
  }
  return message;
}

function getPayloadChannelId(payload: { thread: ThreadMessagePayload["thread"] }): string | undefined {
  return payload.thread.channelId;
}

function getPayloadUserId(payload: { message: ThreadMessagePayload["message"] }): string | undefined {
  return payload.message.author?.userId;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getPayloadWorkflowRunId(payload: ThreadMessagePayload): string | undefined {
  return (
    toOptionalString(payload.workflowRunId) ??
    toOptionalString((payload.thread as { runId?: unknown }).runId) ??
    toOptionalString((payload.message as { runId?: unknown }).runId)
  );
}

export async function logThreadMessageFailureStep(
  payload: Pick<ThreadMessagePayload, "kind" | "normalizedThreadId" | "message" | "thread">,
  errorMessage: string,
  workflowRunId?: string
): Promise<void> {
  "use step";
  const { logError, withContext } = await import("@/chat/observability");

  await withContext(
    {
      slackThreadId: payload.normalizedThreadId,
      slackChannelId: getPayloadChannelId(payload),
      slackUserId: getPayloadUserId(payload),
      workflowRunId
    },
    async () => {
      logError(
        "workflow_message_failed",
        {},
        {
          "app.workflow.message_kind": payload.kind,
          "messaging.message.id": payload.message.id,
          "error.message": errorMessage
        },
        "Thread workflow step failed"
      );
    }
  );
}

export async function processThreadMessageStep(payload: ThreadMessagePayload, workflowRunId?: string): Promise<void> {
  "use step";
  const [
    { appSlackRuntime, bot },
    { logInfo, withContext, withSpan },
    { downloadPrivateSlackFile },
    {
      getStateAdapter,
      getWorkflowMessageProcessingState,
      markWorkflowMessageCompleted,
      markWorkflowMessageFailed,
      markWorkflowMessageStarted
    }
  ] = await Promise.all([
    import("@/chat/bot"),
    import("@/chat/observability"),
    import("@/chat/slack-actions/client"),
    import("@/chat/state")
  ]);

  const resolvedWorkflowRunId = workflowRunId ?? getPayloadWorkflowRunId(payload);
  const threadWasSerialized = isSerializedThread(payload.thread);
  const messageId = toOptionalString(payload.message.id);
  const userId = getPayloadUserId(payload);
  const messageStateContext = {
    slackThreadId: payload.normalizedThreadId,
    slackChannelId: getPayloadChannelId(payload),
    slackUserId: userId,
    workflowRunId: resolvedWorkflowRunId
  };
  const existingMessageState = await getWorkflowMessageProcessingState(payload.dedupKey);
  if (existingMessageState?.status === "completed" || existingMessageState?.status === "started") {
    logInfo(
      "workflow_message_state_counter",
      messageStateContext,
      {
        ...(messageId ? { "messaging.message.id": messageId } : {}),
        ...(userId ? { "enduser.id": userId } : {}),
        "app.workflow.message_state": existingMessageState.status,
        "app.workflow.message_outcome": "skipped"
      },
      "Skipping workflow message because it is already in-progress or completed"
    );
    return;
  }
  const started = await markWorkflowMessageStarted(payload.dedupKey, resolvedWorkflowRunId);
  if (started) {
    logInfo(
      "workflow_message_state_counter",
      messageStateContext,
      {
        ...(messageId ? { "messaging.message.id": messageId } : {}),
        ...(userId ? { "enduser.id": userId } : {}),
        "app.workflow.message_state": "started",
        "app.workflow.message_outcome": "processing"
      },
      "Marked workflow message as started"
    );
  }
  if (!started) {
    const latestMessageState = await getWorkflowMessageProcessingState(payload.dedupKey);
    if (latestMessageState?.status === "completed" || latestMessageState?.status === "started") {
      logInfo(
        "workflow_message_state_counter",
        messageStateContext,
        {
          ...(messageId ? { "messaging.message.id": messageId } : {}),
          ...(userId ? { "enduser.id": userId } : {}),
          "app.workflow.message_state": latestMessageState.status,
          "app.workflow.message_outcome": "skipped"
        },
        "Skipping workflow message because processing state is already claimed"
      );
      return;
    }
  }

  bot.registerSingleton();
  // Serialized payloads require state adapter connectivity for ThreadImpl-backed state.
  // Connect once per runtime process to avoid repeated connect overhead on every step.
  if (threadWasSerialized && !stateAdapterConnected) {
    await getStateAdapter().connect();
    stateAdapterConnected = true;
  }
  const runtimeThread = toRuntimeThread(payload.thread);
  const runtimeMessage = toRuntimeMessage(payload.message);
  const runtimePayload = {
    ...payload,
    thread: runtimeThread,
    message: runtimeMessage
  };
  rehydrateAttachmentFetchers(runtimePayload, downloadPrivateSlackFile);

  try {
    await withContext(
      {
        slackThreadId: payload.normalizedThreadId,
        slackChannelId: runtimeThread.channelId,
        slackUserId: runtimeMessage.author.userId,
        workflowRunId: resolvedWorkflowRunId
      },
      async () => {
        await withSpan(
          "workflow.thread_message",
          "workflow.thread_message",
          {
            slackThreadId: payload.normalizedThreadId,
            slackChannelId: runtimeThread.channelId,
            slackUserId: runtimeMessage.author.userId,
            workflowRunId: resolvedWorkflowRunId
          },
          async () => {
            if (payload.kind === "new_mention") {
              await appSlackRuntime.handleNewMention(runtimeThread, runtimeMessage);
            } else {
              await appSlackRuntime.handleSubscribedMessage(runtimeThread, runtimeMessage);
            }
          },
          {
            "messaging.message.id": runtimeMessage.id,
            "app.workflow.message_kind": payload.kind
          }
        );
      }
    );
    await markWorkflowMessageCompleted(payload.dedupKey, resolvedWorkflowRunId);
    logInfo(
      "workflow_message_state_counter",
      messageStateContext,
      {
        ...(messageId ? { "messaging.message.id": messageId } : {}),
        ...(userId ? { "enduser.id": userId } : {}),
        "app.workflow.message_state": "completed",
        "app.workflow.message_outcome": "succeeded"
      },
      "Marked workflow message as completed"
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await markWorkflowMessageFailed(payload.dedupKey, errorMessage, resolvedWorkflowRunId);
    logInfo(
      "workflow_message_state_counter",
      messageStateContext,
      {
        ...(messageId ? { "messaging.message.id": messageId } : {}),
        ...(userId ? { "enduser.id": userId } : {}),
        "app.workflow.message_state": "failed",
        "app.workflow.message_outcome": "failed",
        "error.message": errorMessage
      },
      "Marked workflow message as failed"
    );
    throw error;
  }
}

Object.assign(processThreadMessageStep, { maxRetries: 1 });

export async function releaseWorkflowStartupLeaseStep(
  normalizedThreadId: string,
  startupLeaseOwnerToken: string
): Promise<void> {
  "use step";
  const [{ releaseWorkflowStartupLease }, { logWarn }] = await Promise.all([
    import("@/chat/state"),
    import("@/chat/observability")
  ]);

  try {
    await releaseWorkflowStartupLease(normalizedThreadId, startupLeaseOwnerToken);
  } catch (error) {
    logWarn(
      "workflow_startup_lease_release_failed",
      {},
      {
        "messaging.message.conversation_id": normalizedThreadId,
        "error.message": error instanceof Error ? error.message : String(error)
      },
      "Failed to release workflow startup lease after hook registration"
    );
  }
}
