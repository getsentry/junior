/** Normalize complete and failed Slack eval observations for vitest-evals. */
import { GEN_AI_PROVIDER_NAME } from "@/chat/pi/client";
import type { AgentTurnUsage } from "@/chat/usage";
import type { EmittedLogRecord } from "@/chat/logging";
import {
  toJsonValue,
  type HarnessRun,
  type JsonValue,
  type TranscriptEvent,
} from "vitest-evals/harness";
import type { EvalResult } from "./behavior-harness";

type NormalizedMessage = EvalResult["sessionMessages"][number];

interface ToolCallRecord {
  name: string;
  arguments?: Record<string, JsonValue>;
  result?: JsonValue;
  error?: { message: string };
}

function hasAssistantStatusPending(result: EvalResult): boolean {
  const lastByThread = new Map<string, string>();
  for (const call of result.slackAdapter.statusCalls) {
    lastByThread.set(`${call.channelId}:${call.threadTs}`, call.text);
  }
  for (const text of lastByThread.values()) {
    if (text !== "") return true;
  }
  return false;
}

function toJson(value: unknown): JsonValue {
  return toJsonValue(value) ?? null;
}

function toJsonRecord(
  value: Record<string, unknown>,
): Record<string, JsonValue> {
  const record: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    record[key] = toJson(entry);
  }
  return record;
}

function slackMetadata(result: EvalResult): Record<string, JsonValue> {
  return {
    thread_title_set: result.slackAdapter.titleCalls.length > 0,
    suggested_prompts_set: result.slackAdapter.promptCalls.length > 0,
    assistant_status_pending: hasAssistantStatusPending(result),
  };
}

function slackSideEffectArtifacts(result: EvalResult): JsonValue {
  return {
    suggested_prompt_calls: result.slackAdapter.promptCalls.length,
    thread_title_calls: result.slackAdapter.titleCalls.length,
    thread_titles: result.slackAdapter.titleCalls.map((call) => call.title),
  };
}

function authorizationArtifacts(result: EvalResult): JsonValue {
  return result.authorizationCompletions.map((completion) => ({
    credential_stored: completion.credentialStored,
    delivery: completion.delivery,
    kind: completion.kind,
    provider: completion.provider,
    user_id: completion.userId,
  }));
}

function toToolCallRecord(
  invocation: EvalResult["toolInvocations"][number],
): ToolCallRecord {
  const args: Record<string, JsonValue> = {};
  if (invocation.arguments) {
    const genericArgs = toJson(invocation.arguments);
    if (
      genericArgs &&
      typeof genericArgs === "object" &&
      !Array.isArray(genericArgs)
    ) {
      Object.assign(args, genericArgs);
    } else {
      args.value = genericArgs;
    }
  }
  if (invocation.bash_command) {
    args.command = invocation.bash_command;
  }
  if (invocation.skill_name) {
    args.skill_name = invocation.skill_name;
  }
  if (invocation.mcp_tool_name) {
    args.tool_name = invocation.mcp_tool_name;
  }
  if (invocation.mcp_arguments) {
    args.arguments = toJson(invocation.mcp_arguments);
  }

  return {
    name: invocation.tool,
    ...(Object.keys(args).length > 0 ? { arguments: args } : {}),
    ...(invocation.completed
      ? {
          result: toJson(
            invocation.result ?? {
              ok: invocation.ok ?? invocation.error === undefined,
            },
          ),
        }
      : {}),
    ...(invocation.error ? { error: { message: invocation.error } } : {}),
  };
}

function toLogMetadata(record: EmittedLogRecord): Record<string, JsonValue> {
  return toJsonRecord({
    eventName: record.eventName,
    body: record.body,
    level: record.level,
    attributes: record.attributes,
  });
}

function toAssistantPostMessage(
  post: EvalResult["posts"][number],
): NormalizedMessage {
  return {
    role: "assistant",
    content: post.text,
    metadata: toJsonRecord({
      event_type: post.eventType ?? "thread_post",
      ...(post.channel ? { channel: post.channel } : {}),
      ...(post.thread_ts ? { thread_ts: post.thread_ts } : {}),
      files: post.files,
    }),
  };
}

function buildPostKey(post: {
  channel?: string;
  text: string;
  thread_ts?: string;
}): string {
  return `${post.channel ?? ""}\u0000${post.thread_ts ?? ""}\u0000${post.text}`;
}

function toSessionMessages(result: EvalResult): NormalizedMessage[] {
  const observedPostKeys = new Set(
    result.sessionMessages.flatMap((message) => {
      if (message.role !== "assistant" || typeof message.content !== "string") {
        return [];
      }
      const channel = message.metadata?.channel;
      const threadTs = message.metadata?.thread_ts;
      return [
        buildPostKey({
          text: message.content,
          ...(typeof channel === "string" ? { channel } : {}),
          ...(typeof threadTs === "string" ? { thread_ts: threadTs } : {}),
        }),
      ];
    }),
  );
  const threadPostKeys = new Set(result.posts.map(buildPostKey));
  return [
    ...result.sessionMessages,
    ...result.posts
      .filter((post) => !observedPostKeys.has(buildPostKey(post)))
      .map(toAssistantPostMessage),
    ...result.channelPosts
      .filter((post) => !threadPostKeys.has(buildPostKey(post)))
      .map(
        (post): NormalizedMessage => ({
          role: "assistant",
          content: post.text,
          metadata: toJsonRecord({
            event_type: post.thread_ts ? "thread_post" : "channel_post",
            channel: post.channel,
            ...(post.thread_ts ? { thread_ts: post.thread_ts } : {}),
          }),
        }),
      ),
    ...result.reactions.map(
      (reaction): NormalizedMessage => ({
        role: "assistant",
        content: {
          type: "reaction_added",
          emoji: reaction.emoji,
        },
        metadata: toJsonRecord({
          event_type: "reaction_added",
          channel: reaction.channel,
          timestamp: reaction.timestamp,
        }),
      }),
    ),
    ...result.canvases.map(
      (canvas): NormalizedMessage => ({
        role: "assistant",
        content: {
          type: "canvas_created",
          title: canvas.title,
          markdown: canvas.markdown,
        },
        metadata: {
          event_type: "canvas_created",
        },
      }),
    ),
  ];
}

function usageTotal(usage: AgentTurnUsage | undefined): number | undefined {
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  const components = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined);
  return components.length > 0
    ? components.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function toHarnessUsage(result: EvalResult): HarnessRun["usage"] {
  const usage = result.usage;
  const metadata = toJsonRecord({
    ...(usage?.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage?.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : {}),
    ...(usage?.cost
      ? {
          currency: "USD",
          cost: usage.cost,
          ...(usage.cost.total !== undefined
            ? { costUsd: usage.cost.total }
            : {}),
        }
      : {}),
    ...(result.modelIds.length > 1 ? { modelIds: result.modelIds } : {}),
  });
  return {
    provider: GEN_AI_PROVIDER_NAME,
    ...(result.modelIds.length === 1 ? { model: result.modelIds[0] } : {}),
    ...(usage?.inputTokens !== undefined
      ? { inputTokens: usage.inputTokens }
      : {}),
    ...(usage?.outputTokens !== undefined
      ? { outputTokens: usage.outputTokens }
      : {}),
    ...(usage?.reasoningTokens !== undefined
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
    ...(usageTotal(usage) !== undefined
      ? { totalTokens: usageTotal(usage) }
      : {}),
    toolCalls: result.toolInvocations.length,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function toTranscriptEvents(
  messages: NormalizedMessage[],
  toolCallRecords: ToolCallRecord[],
): TranscriptEvent[] {
  const messageEvents: TranscriptEvent[] = messages.map((message) => ({
    type: "message",
    ...message,
  }));
  const toolEvents: TranscriptEvent[] = toolCallRecords.flatMap(
    (call, index) => {
      const id = `eval-tool-${index}`;
      return [
        {
          type: "tool_call" as const,
          id,
          name: call.name,
          ...(call.arguments ? { arguments: call.arguments } : {}),
        },
        ...(call.error
          ? [
              {
                type: "tool_result" as const,
                toolCallId: id,
                name: call.name,
                error: call.error,
              },
            ]
          : call.result !== undefined
            ? [
                {
                  type: "tool_result" as const,
                  toolCallId: id,
                  name: call.name,
                  content: call.result,
                },
              ]
            : []),
      ];
    },
  );
  return [...messageEvents, ...toolEvents];
}

/** Preserve the same session shape for successful and failed eval runs. */
export function toEvalHarnessRun(
  result: EvalResult,
  totalMs: number,
): HarnessRun {
  const toolCallRecords = result.toolInvocations.map(toToolCallRecord);
  const messages = toSessionMessages(result);

  return {
    artifacts: {
      authorization_completions: authorizationArtifacts(result),
      slack_side_effects: slackSideEffectArtifacts(result),
    },
    session: {
      events: toTranscriptEvents(messages, toolCallRecords),
      metadata: toJsonRecord({
        slack_metadata: slackMetadata(result),
        log_records: result.logRecords.map(toLogMetadata),
        conversation_ids: result.conversationIds,
      }),
    },
    usage: toHarnessUsage(result),
    timings: { totalMs },
    errors: [],
  };
}
