/**
 * Call results read through Junior's reporting API, the way the dashboard
 * reads a Conversation. Tests never read stored rows directly.
 */
import type { z } from "zod";
import { conversationDetailReportSchema } from "@/api/schema";
import {
  toJsonValue,
  type HarnessRun,
  type TranscriptEvent,
} from "vitest-evals/harness";
import type { RequestApp, SlackPost } from "./slack";
import type { VisibleMessage } from "./judge";
import type { GatewayModelCall } from "./gateway";

/** Header that selects the signed-in person for a fixture API request. */
export const VIEWER_HEADER = "x-fixture-viewer";

type ConversationDetail = z.infer<typeof conversationDetailReportSchema>;
type ReportEvent = ConversationDetail["events"][number];
type ReportUsage = NonNullable<
  ConversationDetail["modelUsage"]
>[number]["usage"];

/** An assistant message that people saw. */
export interface Reply {
  conversationId: string;
  messageId: string;
  text: string;
}

/** One agent tool call with its result. */
export interface ToolCall {
  input?: unknown;
  name: string;
  output?: unknown;
  status: "completed" | "error" | "running";
  toolCallId: string;
}

/**
 * Completed calls of one tool across the results of several calls. The agent
 * runs deferred tools through `executeTool`; those calls count as calls of the
 * inner tool, with its arguments as `input`.
 */
export function completedToolCalls(
  name: string,
  ...results: Array<{ toolCalls: ToolCall[] }>
): ToolCall[] {
  return results
    .flatMap((result) => result.toolCalls)
    .filter((call) => call.status === "completed")
    .flatMap((call) => {
      if (call.name === name) return [call];
      const deferred = call.input as
        | { arguments?: unknown; tool_name?: unknown }
        | undefined;
      return call.name === "executeTool" && deferred?.tool_name === name
        ? [{ ...call, input: deferred.arguments, name }]
        : [];
    });
}

/**
 * The result of a tool call. The reporting API returns JSON results as text,
 * so this parses them.
 */
export function toolOutput(call: ToolCall): unknown {
  if (typeof call.output !== "string") return call.output;
  try {
    return JSON.parse(call.output) as unknown;
  } catch {
    return call.output;
  }
}

/** Turn states of the reporting API. A turn that waits for authorization stays `started`. */
export type TurnStatus = "failed" | "no_reply" | "started" | "succeeded";

export interface Turn {
  replies: Reply[];
  status: TurnStatus;
  toolCalls: ToolCall[];
  turnId: string;
}

/** What one call added to a Conversation. */
export interface CallEvents {
  lastSeq: number;
  replies: Reply[];
  toolCalls: ToolCall[];
  turns: Turn[];
  /** User and assistant messages in order, for judges and reports. */
  visibleMessages: VisibleMessage[];
}

/** Read one Conversation through `GET /api/conversations/:id`. */
export async function readConversationDetail(
  api: RequestApp,
  conversationId: string,
  viewerEmail: string,
): Promise<ConversationDetail> {
  const response = await api.request(
    `/api/conversations/${encodeURIComponent(conversationId)}?limit=1000`,
    { headers: { [VIEWER_HEADER]: viewerEmail } },
  );
  if (response.status !== 200) {
    throw new Error(
      `Conversation detail returned ${response.status}: ${await response.text()}`,
    );
  }
  return conversationDetailReportSchema.parse(await response.json());
}

/** Sequence before a Conversation's first event. */
export const BEFORE_FIRST_EVENT = -1;

/** Return the last event sequence of a Conversation. */
export function lastEventSeq(detail: ConversationDetail): number {
  return detail.events.at(-1)?.seq ?? BEFORE_FIRST_EVENT;
}

function authorName(event: ReportEvent): string | undefined {
  if (event.data.type !== "message") return undefined;
  const identity = event.data.actorIdentity;
  return identity?.fullName ?? identity?.slackUserName;
}

/** Collect the replies, tool calls, and turns after `afterSeq`. */
export function readCallEvents(args: {
  afterSeq: number;
  conversationId: string;
  detail: ConversationDetail;
}): CallEvents {
  const replies: Reply[] = [];
  const visibleMessages: VisibleMessage[] = [];
  const turns = new Map<string, Turn>();
  const toolCalls = new Map<string, ToolCall>();
  const turnToolCallIds = new Map<Turn, string[]>();
  let currentTurn: Turn | undefined;
  let lastSeq = args.afterSeq;

  for (const event of args.detail.events) {
    if (event.seq <= args.afterSeq) continue;
    lastSeq = event.seq;
    const data = event.data;
    if (data.type === "turn_lifecycle") {
      const turn = turns.get(data.turnId) ?? {
        replies: [],
        status: data.state,
        toolCalls: [],
        turnId: data.turnId,
      };
      turn.status = data.state;
      turns.set(data.turnId, turn);
      if (!turnToolCallIds.has(turn)) turnToolCallIds.set(turn, []);
      if (data.state === "started") {
        currentTurn = turn;
      } else if (currentTurn === turn) {
        currentTurn = undefined;
      }
      continue;
    }
    if (data.type === "message" && data.text !== undefined) {
      if (data.role === "assistant") {
        const reply = {
          conversationId: args.conversationId,
          messageId: data.messageId,
          text: data.text,
        };
        replies.push(reply);
        currentTurn?.replies.push(reply);
        visibleMessages.push({ content: data.text, role: "assistant" });
      } else if (data.role === "user") {
        const author = authorName(event);
        visibleMessages.push({
          content: data.text,
          role: "user",
          ...(author ? { author } : undefined),
        });
      }
      continue;
    }
    if (data.type === "tool_calls") {
      for (const call of data.calls) {
        const existing = toolCalls.get(call.toolCallId);
        toolCalls.set(call.toolCallId, {
          name: call.name,
          status: call.status,
          toolCallId: call.toolCallId,
          input: existing?.input ?? call.input,
          output: call.output ?? existing?.output,
        });
        if (!existing && currentTurn) {
          turnToolCallIds.get(currentTurn)?.push(call.toolCallId);
        }
      }
      continue;
    }
    // A handoff replaces agent history, so its tool call gets no tool result.
    // The handoff event completes the call, as the dashboard shows it.
    if (data.type === "handoff" && data.triggeringToolCallId) {
      const call = toolCalls.get(data.triggeringToolCallId);
      if (call) call.status = "completed";
    }
  }

  for (const turn of turns.values()) {
    turn.toolCalls = (turnToolCallIds.get(turn) ?? []).flatMap((id) => {
      const call = toolCalls.get(id);
      return call ? [call] : [];
    });
  }

  return {
    lastSeq,
    replies,
    toolCalls: [...toolCalls.values()],
    turns: [...turns.values()],
    visibleMessages,
  };
}

function usageMetrics(usage: ReportUsage | undefined): ModelUsageMetrics {
  const cost = usage?.cost;
  return {
    ...(usage?.inputTokens !== undefined
      ? { inputTokens: usage.inputTokens }
      : undefined),
    ...(usage?.outputTokens !== undefined
      ? { outputTokens: usage.outputTokens }
      : undefined),
    ...(usage?.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : undefined),
    ...(usage?.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: usage.cacheCreationTokens }
      : undefined),
    ...(cost
      ? {
          costUsd: {
            ...(cost.input !== undefined ? { input: cost.input } : undefined),
            ...(cost.output !== undefined
              ? { output: cost.output }
              : undefined),
            ...(cost.cacheRead !== undefined
              ? { cacheRead: cost.cacheRead }
              : undefined),
            ...(cost.cacheWrite !== undefined
              ? { cacheWrite: cost.cacheWrite }
              : undefined),
            ...(cost.total !== undefined ? { total: cost.total } : undefined),
          },
        }
      : undefined),
  };
}

/** Numeric model-call usage after a Conversation event boundary, without content. */
export function readModelCalls(
  events: ReadonlyArray<ReportEvent>,
  afterSeq: number,
): ModelCallUsage[] {
  return events.flatMap((event) =>
    event.seq > afterSeq && event.data.type === "assistant_message"
      ? [
          {
            eventSeq: event.seq,
            ...(event.model?.modelId
              ? { modelId: event.model.modelId }
              : undefined),
            ...(event.model?.modelProfile
              ? { modelProfile: event.model.modelProfile }
              : undefined),
            ...usageMetrics(event.modelCall?.usage),
          },
        ]
      : [],
  );
}

/** Model totals include recorded assistant calls, including child Conversations. */
export function readModelTotals(
  entries: ReadonlyArray<NonNullable<ConversationDetail["modelUsage"]>[number]>,
): ModelTotalUsage[] {
  return entries.map(({ modelId, usage }) => ({
    modelId,
    ...usageMetrics(usage),
  }));
}

/**
 * Compare a Slack post with a stored reply by their words. Slack rendering
 * changes formatting and links references, such as `owner/repo#1`.
 */
function comparableText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^|>]+\|([^>]*)>/g, "$1")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/[*_~`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Use Slack thread posts as the replies of a Slack call. A post that matches
 * a stored reply keeps the stored message id, so `fork()` can use it.
 */
export function slackCallReplies(args: {
  conversationId: string;
  durable: { replies: Reply[]; visibleMessages: VisibleMessage[] };
  posts: SlackPost[];
}): { replies: Reply[]; visibleMessages: VisibleMessage[] } {
  const unmatched = [...args.durable.replies];
  const extra: VisibleMessage[] = [];
  const replies = args.posts.map((post): Reply => {
    const index = unmatched.findIndex(
      (reply) => comparableText(reply.text) === comparableText(post.text),
    );
    const durable = index >= 0 ? unmatched.splice(index, 1)[0] : undefined;
    if (!durable) extra.push({ content: post.text, role: "assistant" });
    return {
      conversationId: args.conversationId,
      messageId: durable?.messageId ?? `slack:${post.ts}`,
      text: post.text,
    };
  });
  return {
    replies,
    visibleMessages: [...args.durable.visibleMessages, ...extra],
  };
}

function toTranscriptEvents(
  messages: VisibleMessage[],
  toolCalls: ToolCall[],
): TranscriptEvent[] {
  return [
    ...messages.map(
      (message): TranscriptEvent => ({
        type: "message",
        role: message.role,
        content: message.content,
        ...(message.author
          ? { metadata: { author_name: message.author } }
          : undefined),
      }),
    ),
    ...toolCalls.flatMap((toolCall): TranscriptEvent[] => {
      const input = toJsonValue(toolCall.input);
      const output = toJsonValue(toolCall.output) ?? null;
      const call: TranscriptEvent = {
        type: "tool_call",
        id: toolCall.toolCallId,
        name: toolCall.name,
        ...(input && typeof input === "object" && !Array.isArray(input)
          ? { arguments: input }
          : undefined),
      };
      if (toolCall.status === "running") return [call];
      return [
        call,
        {
          type: "tool_result",
          toolCallId: toolCall.toolCallId,
          name: toolCall.name,
          ...(toolCall.status === "error"
            ? { error: { message: JSON.stringify(output) } }
            : { content: output }),
        },
      ];
    }),
  ];
}

/** Model spend the fixture can see: agent cost and AI Gateway requests. */
export interface FixtureUsage {
  agentCostUsd: number;
  auxiliaryCostUsd: number;
  gatewayRequests: Record<string, number>;
  gatewayModelCalls: GatewayModelCall[];
  modelCalls: ModelCallUsage[];
  modelTotals: ModelTotalUsage[];
}

interface ModelUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

/** Per-call counters from the Conversation reporting API. */
export type ModelCallUsage = ModelUsageMetrics & {
  eventSeq: number;
  modelId?: string;
  modelProfile?: string;
};

/** Per-model totals from the Conversation reporting API. */
export type ModelTotalUsage = ModelUsageMetrics & { modelId: string };

/** The vitest-evals run for one call. */
export function toHarnessRun(args: {
  conversationId: string;
  usage: FixtureUsage;
  messages: VisibleMessage[];
  startedAtMs: number;
  toolCalls: ToolCall[];
}): HarnessRun {
  return {
    session: {
      events: toTranscriptEvents(args.messages, args.toolCalls),
      metadata: { conversation_ids: [args.conversationId] },
    },
    usage: {
      toolCalls: args.toolCalls.length,
      metadata: {
        costUsd: args.usage.agentCostUsd,
        auxiliaryCostUsd: args.usage.auxiliaryCostUsd,
        gatewayRequests: args.usage.gatewayRequests,
        gatewayModelCalls: toJsonValue(args.usage.gatewayModelCalls) ?? [],
        modelCalls: toJsonValue(args.usage.modelCalls) ?? [],
        modelTotals: toJsonValue(args.usage.modelTotals) ?? [],
      },
    },
    timings: { totalMs: Date.now() - args.startedAtMs },
    errors: [],
  };
}

/** One vitest-evals run with every call of the test, for the eval report. */
export function combinedRun(
  calls: Array<{ conversationId: string; events: TranscriptEvent[] }>,
  usage: FixtureUsage,
  startedAtMs: number,
): HarnessRun {
  return {
    session: {
      events: calls.flatMap((entry) => entry.events),
      metadata: {
        conversation_ids: [
          ...new Set(calls.map((entry) => entry.conversationId)),
        ],
      },
    },
    usage: {
      metadata: {
        costUsd: usage.agentCostUsd,
        auxiliaryCostUsd: usage.auxiliaryCostUsd,
        gatewayRequests: usage.gatewayRequests,
        gatewayModelCalls: toJsonValue(usage.gatewayModelCalls) ?? [],
        modelCalls: toJsonValue(usage.modelCalls) ?? [],
        modelTotals: toJsonValue(usage.modelTotals) ?? [],
      },
    },
    timings: { totalMs: Date.now() - startedAtMs },
    errors: [],
  };
}
