import type { Message, SerializedMessage, SerializedThread, Thread } from "chat";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

let stateAdapterConnected = false;

function isSerializedThread(thread: ThreadMessagePayload["thread"]): thread is SerializedThread {
  return typeof thread === "object" && thread !== null && (thread as { _type?: unknown })._type === "chat:Thread";
}

function isSerializedMessage(message: ThreadMessagePayload["message"]): message is SerializedMessage {
  return typeof message === "object" && message !== null && (message as { _type?: unknown })._type === "chat:Message";
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

function createMessageOwnerToken(): string {
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function logThreadMessageFailureStep(
  payload: Pick<ThreadMessagePayload, "kind" | "normalizedThreadId" | "message" | "thread">,
  errorMessage: string,
  workflowRunId?: string
): Promise<void> {
  "use step";
  const { logError } = await import("@/chat/observability");
  logError(
    "workflow_message_failed",
    {
      slackThreadId: payload.normalizedThreadId,
      slackChannelId: getPayloadChannelId(payload),
      slackUserId: getPayloadUserId(payload),
      workflowRunId
    },
    {
      "messaging.message.id": payload.message.id,
      "app.workflow.message_kind": payload.kind,
      "error.message": errorMessage
    },
    "Thread workflow step failed"
  );
}

export async function processThreadMessageStep(payload: ThreadMessagePayload, workflowRunId?: string): Promise<void> {
  "use step";
  const [{ Message, ThreadImpl }, { WORKFLOW_DESERIALIZE }] = await Promise.all([import("chat"), import("@workflow/serde")]);
  const threadDeserializer = (ThreadImpl as unknown as Record<PropertyKey, (value: SerializedThread) => Thread>)[
    WORKFLOW_DESERIALIZE
  ];
  const messageDeserializer = (Message as unknown as Record<PropertyKey, (value: SerializedMessage) => Message>)[
    WORKFLOW_DESERIALIZE
  ];
  const [
    { processThreadMessageRuntime },
    {
      getStateAdapter,
      acquireWorkflowMessageProcessingOwnership,
      completeWorkflowMessageProcessingOwnership,
      failWorkflowMessageProcessingOwnership,
      getWorkflowMessageProcessingState,
      refreshWorkflowMessageProcessingOwnership
    }
  ] = await Promise.all([
    import("@/chat/thread-runtime/process-thread-message-runtime"),
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
  void messageStateContext;
  const existingMessageState = await getWorkflowMessageProcessingState(payload.dedupKey);
  if (existingMessageState?.status === "completed") {
    void messageId;
    void userId;
    return;
  }

  const ownerToken = createMessageOwnerToken();
  const claimResult = await acquireWorkflowMessageProcessingOwnership({
    rawKey: payload.dedupKey,
    ownerToken,
    workflowRunId: resolvedWorkflowRunId
  });
  if (claimResult === "blocked") {
    const latestMessageState = await getWorkflowMessageProcessingState(payload.dedupKey);
    if (
      latestMessageState?.status === "completed" ||
      latestMessageState?.status === "processing" ||
      latestMessageState?.status === "started"
    ) {
      return;
    }
  }

  // Serialized payloads require state adapter connectivity for ThreadImpl-backed state.
  // Connect once per runtime process to avoid repeated connect overhead on every step.
  if (threadWasSerialized && !stateAdapterConnected) {
    await getStateAdapter().connect();
    stateAdapterConnected = true;
  }
  const runtimeThread = isSerializedThread(payload.thread)
    ? threadDeserializer(payload.thread)
    : payload.thread;
  const runtimeMessage = isSerializedMessage(payload.message)
    ? messageDeserializer(payload.message)
    : payload.message;
  const runtimePayload = {
    ...payload,
    thread: runtimeThread,
    message: runtimeMessage
  };

  try {
    await refreshWorkflowMessageProcessingOwnership({
      rawKey: payload.dedupKey,
      ownerToken,
      workflowRunId: resolvedWorkflowRunId
    });
    await processThreadMessageRuntime({
      kind: payload.kind,
      thread: runtimePayload.thread,
      message: runtimePayload.message
    });
    await completeWorkflowMessageProcessingOwnership({
      rawKey: payload.dedupKey,
      ownerToken,
      workflowRunId: resolvedWorkflowRunId
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await failWorkflowMessageProcessingOwnership({
      rawKey: payload.dedupKey,
      ownerToken,
      errorMessage,
      workflowRunId: resolvedWorkflowRunId
    });
    throw error;
  }
}

Object.assign(processThreadMessageStep, { maxRetries: 1 });
