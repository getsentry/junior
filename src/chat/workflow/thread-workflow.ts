import { defineHook, getWorkflowMetadata } from "workflow";
import type { ThreadMessagePayload } from "@/chat/workflow/types";

const MAX_DEDUP_KEYS = 500;
const DEDUP_TRIM_SIZE = Math.floor(MAX_DEDUP_KEYS / 2);

export const threadMessageHook = defineHook<ThreadMessagePayload>();

function trimSeenDedupKeys(seen: Set<string>): void {
  if (seen.size <= MAX_DEDUP_KEYS) {
    return;
  }

  let deleteCount = seen.size - DEDUP_TRIM_SIZE;
  for (const key of seen) {
    seen.delete(key);
    deleteCount -= 1;
    if (deleteCount <= 0) {
      break;
    }
  }
}

function rehydrateAttachmentFetchers(
  payload: ThreadMessagePayload,
  downloadPrivateFile: (url: string) => Promise<Buffer>
): void {
  for (const attachment of payload.message.attachments) {
    if (!attachment.fetchData && attachment.url) {
      attachment.fetchData = () => downloadPrivateFile(attachment.url as string);
    }
  }
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

function attachWorkflowRunId(payload: ThreadMessagePayload, workflowRunId: string): void {
  payload.workflowRunId = workflowRunId;

  const threadWithRun = payload.thread as { runId?: string };
  if (!threadWithRun.runId) {
    threadWithRun.runId = workflowRunId;
  }

  const messageWithRun = payload.message as { runId?: string };
  if (!messageWithRun.runId) {
    messageWithRun.runId = workflowRunId;
  }
}

async function* withWorkflowRunId(
  stream: AsyncIterable<ThreadMessagePayload>,
  workflowRunId: string
): AsyncIterable<ThreadMessagePayload> {
  for await (const payload of stream) {
    attachWorkflowRunId(payload, workflowRunId);
    yield payload;
  }
}

async function logThreadMessageFailure(args: {
  errorMessage: string;
  payload: Pick<ThreadMessagePayload, "kind" | "normalizedThreadId" | "message" | "thread">;
  workflowRunId?: string;
}): Promise<void> {
  "use step";
  const { logError, withContext } = await import("@/chat/observability");

  await withContext(
    {
      slackThreadId: args.payload.normalizedThreadId,
      slackChannelId: args.payload.thread.channelId,
      slackUserId: args.payload.message.author.userId,
      workflowRunId: args.workflowRunId
    },
    async () => {
      logError(
        "workflow_message_failed",
        {},
        {
          "app.workflow.message_kind": args.payload.kind,
          "messaging.message.id": args.payload.message.id,
          "error.message": args.errorMessage
        },
        "Thread workflow step failed"
      );
    }
  );
}

export async function processThreadMessage(payload: ThreadMessagePayload): Promise<void> {
  "use step";
  const [{ appSlackRuntime, bot }, { logInfo, withContext, withSpan }, { downloadPrivateSlackFile }] = await Promise.all([
    import("@/chat/bot"),
    import("@/chat/observability"),
    import("@/chat/slack-actions/client")
  ]);

  bot.registerSingleton();
  rehydrateAttachmentFetchers(payload, downloadPrivateSlackFile);
  const workflowRunId = getPayloadWorkflowRunId(payload);

  await withContext(
    {
      slackThreadId: payload.normalizedThreadId,
      slackChannelId: payload.thread.channelId,
      slackUserId: payload.message.author.userId,
      workflowRunId
    },
    async () => {
      await withSpan(
        "workflow.thread_message",
        "workflow.thread_message",
        {
          slackThreadId: payload.normalizedThreadId,
          slackChannelId: payload.thread.channelId,
          slackUserId: payload.message.author.userId,
          workflowRunId
        },
        async () => {
          if (payload.kind === "new_mention") {
            await appSlackRuntime.handleNewMention(payload.thread, payload.message);
          } else {
            await appSlackRuntime.handleSubscribedMessage(payload.thread, payload.message);
          }
        },
        {
          "messaging.message.id": payload.message.id,
          "app.workflow.message_kind": payload.kind
        }
      );

      logInfo(
        "workflow_message_processed",
        {},
        {
          "app.workflow.message_kind": payload.kind
        },
        "Thread workflow step processed message"
      );
    }
  );
}

Object.assign(processThreadMessage, { maxRetries: 1 });

export interface ThreadMessageLoopOptions {
  onProcessingError?: (args: { errorMessage: string; payload: ThreadMessagePayload }) => Promise<void>;
  processMessage?: (payload: ThreadMessagePayload) => Promise<void>;
}

export async function runThreadMessageLoop(
  stream: AsyncIterable<ThreadMessagePayload>,
  options: ThreadMessageLoopOptions = {}
): Promise<void> {
  const processMessageImpl = options.processMessage ?? processThreadMessage;
  const onProcessingErrorImpl =
    options.onProcessingError ??
    (async ({ errorMessage, payload }: { errorMessage: string; payload: ThreadMessagePayload }) =>
      logThreadMessageFailure({
        payload,
        errorMessage,
        workflowRunId: getPayloadWorkflowRunId(payload)
      }));

  const seenDedupKeys = new Set<string>();

  for await (const payload of stream) {
    if (seenDedupKeys.has(payload.dedupKey)) {
      continue;
    }

    seenDedupKeys.add(payload.dedupKey);
    trimSeenDedupKeys(seenDedupKeys);

    try {
      await processMessageImpl(payload);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await onProcessingErrorImpl({
        payload,
        errorMessage
      });
    }
  }
}

export async function slackThreadWorkflow(normalizedThreadId: string): Promise<void> {
  "use workflow";
  const { workflowRunId } = getWorkflowMetadata();

  const hook = threadMessageHook.create({
    token: normalizedThreadId
  });

  await runThreadMessageLoop(withWorkflowRunId(hook, workflowRunId));
}
