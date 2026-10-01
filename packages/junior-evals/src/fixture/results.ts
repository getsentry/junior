/**
 * Call results read through Junior's reporting API, the way the dashboard
 * reads a Conversation. Tests never read stored rows directly.
 */
import type { z } from "zod";
import { conversationDetailReportSchema } from "@/api/schema";
import type { RequestApp } from "./slack";
import type { VisibleMessage } from "./judge";

/** Header that selects the signed-in person for a fixture API request. */
export const VIEWER_HEADER = "x-fixture-viewer";

type ConversationDetail = z.infer<typeof conversationDetailReportSchema>;
type ReportEvent = ConversationDetail["events"][number];

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
