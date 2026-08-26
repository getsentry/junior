import type {
  ConversationPendingMessage,
  ConversationReportEvent,
} from "@sentry/junior/api/schema";

import type {
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewPart,
} from "../types";

type ToolCall =
  | Extract<
      ConversationReportEvent["data"],
      { type: "tool_calls" }
    >["calls"][number]
  | Extract<
      Extract<
        ConversationReportEvent["data"],
        { type: "assistant_message" }
      >["parts"][number],
      { type: "tool_call" }
    >;

function eventTimestamp(event: ConversationReportEvent): number {
  return Date.parse(event.createdAt);
}

function eventMessage(
  event: ConversationReportEvent,
  role: TranscriptViewMessage["role"],
  parts: TranscriptViewPart[],
): TranscriptViewMessage {
  return {
    parts,
    role,
    sourceSeq: event.seq,
    timestamp: eventTimestamp(event),
  };
}

function specialToolIds(events: ConversationReportEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const data = event.data;
    if (data.type === "handoff" && data.triggeringToolCallId) {
      ids.add(data.triggeringToolCallId);
    }
    if (data.type === "subagent" && data.parentToolCallId) {
      ids.add(data.parentToolCallId);
    }
  }
  return ids;
}

function historyMessageIds(
  messages: readonly TranscriptViewMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.messageId) ids.add(message.messageId);
  }
  return ids;
}

/** Project one accepted mailbox row into a pending transcript message. */
export function pendingTranscriptMessage(
  message: ConversationPendingMessage,
  index: number,
): TranscriptViewMessage {
  return {
    delivery: message.delivery,
    messageId: message.messageId,
    parts: message.redacted
      ? [{ type: "text", redacted: true }]
      : [{ type: "text", text: message.text ?? "" }],
    pending: true,
    role: "user",
    source: message.source,
    // Keep pending rows after history without colliding with real event seqs.
    sourceSeq: Number.MAX_SAFE_INTEGER - 1_000_000 + index,
    timestamp: Date.parse(message.createdAt),
    ...(message.actorIdentity ? { actorIdentity: message.actorIdentity } : undefined),
  };
}

/**
 * Append mailbox-pending rows that are not already present in committed history.
 *
 * History wins on `messageId`. Pending rows keep mailbox order after the latest
 * committed transcript content.
 */
export function mergePendingTranscriptMessages(
  messages: TranscriptViewMessage[],
  pending: readonly ConversationPendingMessage[] | undefined,
): TranscriptViewMessage[] {
  if (!pending?.length) return messages;
  const extras = unresolvedPendingTranscriptMessages(messages, pending);
  return extras.length === 0 ? messages : [...messages, ...extras];
}

/**
 * Project mailbox rows that are not already committed in history.
 *
 * History wins on `messageId`. Use this for the composer-attached stack so a
 * send does not appear twice once workers persist the user message.
 */
export function unresolvedPendingTranscriptMessages(
  messages: readonly TranscriptViewMessage[],
  pending: readonly ConversationPendingMessage[] | undefined,
): TranscriptViewMessage[] {
  if (!pending?.length) return [];
  const committedIds = historyMessageIds(messages);
  return pending
    .filter((message) => !committedIds.has(message.messageId))
    .map((message, index) => pendingTranscriptMessage(message, index));
}

/** Reduce the ordered reporting event API into dashboard-only transcript rows. */
export function conversationTranscriptMessages(
  conversation: ConversationTranscript,
  pendingMessages?: readonly ConversationPendingMessage[],
): TranscriptViewMessage[] {
  return transcriptMessagesFromEvents(conversation.events, pendingMessages);
}

/** Reduce ordered reporting events without subscribing to detail metadata. */
export function transcriptMessagesFromEvents(
  events: ConversationReportEvent[],
  pendingMessages?: readonly ConversationPendingMessage[],
): TranscriptViewMessage[] {
  const replacedToolIds = specialToolIds(events);
  const tools = new Map<
    string,
    Extract<TranscriptViewPart, { type: "tool_call" }>
  >();
  const standaloneToolMessages = new Map<string, TranscriptViewMessage>();
  const subagents = new Map<
    string,
    Extract<TranscriptViewPart, { type: "subagent" }>
  >();
  const messages: TranscriptViewMessage[] = [];
  const messagesById = new Map<string, TranscriptViewMessage>();
  const latestUserMessageByTurn = new Map<string, TranscriptViewMessage>();
  let latestUserMessage: TranscriptViewMessage | undefined;

  const ensureTool = (event: ConversationReportEvent, call: ToolCall): void => {
    if (replacedToolIds.has(call.toolCallId)) return;
    const output = "output" in call ? call.output : undefined;
    const existing = tools.get(call.toolCallId);
    if (existing) {
      existing.name = call.name;
      existing.status = call.status;
      if (call.input !== undefined) existing.input = call.input;
      if (output !== undefined) existing.output = output;
      if (existing.startedTimestamp === undefined && call.startedAt) {
        existing.startedTimestamp = Date.parse(call.startedAt);
      }
      if (call.status !== "running") {
        existing.resultTimestamp = eventTimestamp(event);
      }
      return;
    }

    const part = {
      type: "tool_call" as const,
      id: call.toolCallId,
      name: call.name,
      status: call.status,
      ...(call.input === undefined ? undefined : { input: call.input }),
      ...(output === undefined ? undefined : { output }),
      ...(call.status === "running"
        ? undefined
        : { resultTimestamp: eventTimestamp(event) }),
    };
    const message = {
      ...eventMessage(event, "tool", [part]),
      sourceSeq: call.startedSeq ?? event.seq,
      timestamp: call.startedAt
        ? Date.parse(call.startedAt)
        : eventTimestamp(event),
    };
    tools.set(call.toolCallId, part);
    standaloneToolMessages.set(call.toolCallId, message);
    messages.push(message);
  };

  // API sequence is the only ordering authority. Do not sort by timestamps:
  // producers may preserve ingestion order while clocks are skewed.
  for (const event of events) {
    const data = event.data;
    if (data.type === "message") {
      const message = {
        ...eventMessage(event, data.role, [
          data.redacted
            ? { type: "text", redacted: true }
            : { type: "text", text: data.text! },
        ]),
        messageId: data.messageId,
        ...(data.actorIdentity ? { actorIdentity: data.actorIdentity } : undefined),
        ...(data.eventType ? { eventType: data.eventType } : undefined),
        ...(data.explicitMention !== undefined
          ? { explicitMention: data.explicitMention }
          : undefined),
        ...(data.source ? { source: data.source } : undefined),
      };
      messages.push(message);
      messagesById.set(message.messageId, message);
      if (message.role === "user") latestUserMessage = message;
      continue;
    }

    if (data.type === "message_handled") {
      const message = messagesById.get(data.messageId);
      if (
        message?.role === "user" &&
        message.explicitMention === false &&
        !message.eventType
      ) {
        message.context = true;
      }
      continue;
    }

    if (data.type === "assistant_message") {
      messages.push(
        eventMessage(
          event,
          "assistant",
          data.parts.map((part) =>
            part.redacted
              ? { type: "reasoning", redacted: true }
              : { type: "reasoning", text: part.text! },
          ),
        ),
      );
      continue;
    }

    if (data.type === "turn_lifecycle" && data.state === "started") {
      const inputMessages = data.inputMessageIds
        ?.map((messageId) => messagesById.get(messageId))
        .filter((message) => message !== undefined);
      const turnUserMessage = inputMessages
        ?.slice()
        .reverse()
        .find((message) => message.role === "user");
      if (turnUserMessage) {
        latestUserMessageByTurn.set(data.turnId, turnUserMessage);
      } else if (latestUserMessage) {
        latestUserMessageByTurn.set(data.turnId, latestUserMessage);
      }
      for (const message of inputMessages ?? []) {
        if (
          message.role === "user" &&
          message.explicitMention === false &&
          !message.eventType
        ) {
          message.context = true;
        }
      }
      continue;
    }

    if (data.type === "turn_routed") {
      const message = latestUserMessageByTurn.get(data.turnId);
      if (message) {
        message.route = {
          modelProfile: data.modelProfile,
          modelId: data.modelId,
          reasoningLevel: data.reasoningLevel,
          ...(data.confidence !== undefined
            ? { confidence: data.confidence }
            : undefined),
          source: data.source,
        };
      }
      continue;
    }

    if (data.type === "turn_context") {
      const message = latestUserMessageByTurn.get(data.turnId);
      if (message) {
        message.contexts ??= [];
        message.contexts.push({
          content: data.content,
          kind: data.kind,
          loadedAt: event.createdAt,
          pluginName: data.pluginName,
          version: data.version,
        });
      }
      continue;
    }

    if (data.type === "tool_calls") {
      for (const call of data.calls) ensureTool(event, call);
      if (data.assistant) {
        const parts: TranscriptViewPart[] = [];
        for (const part of data.assistant.parts) {
          if (part.type === "reasoning") {
            parts.push(
              part.redacted
                ? { type: "reasoning", redacted: true }
                : { type: "reasoning", text: part.text! },
            );
            continue;
          }
          if (replacedToolIds.has(part.toolCallId)) continue;
          const tool = tools.get(part.toolCallId);
          if (!tool) continue;

          const standaloneMessage = standaloneToolMessages.get(part.toolCallId);
          if (standaloneMessage) {
            if (standaloneMessage.sourceSeq !== event.seq) {
              tool.startedTimestamp = standaloneMessage.timestamp;
            }
            const messageIndex = messages.indexOf(standaloneMessage);
            if (messageIndex >= 0) messages.splice(messageIndex, 1);
            standaloneToolMessages.delete(part.toolCallId);
          }
          parts.push(tool);
        }
        if (parts.length > 0) {
          messages.push(eventMessage(event, "assistant", parts));
        }
      }
      continue;
    }

    if (data.type === "subagent") {
      const subagentId = `${data.childConversationId}:${data.startedSeq}`;
      const existing = subagents.get(subagentId);
      if (existing) {
        existing.status = data.status;
        continue;
      }
      const part = {
        type: "subagent" as const,
        id: subagentId,
        childConversationId: data.childConversationId,
        subagentKind: data.subagentKind,
        status: data.status,
      };
      subagents.set(subagentId, part);
      messages.push({
        ...eventMessage(event, "tool", [part]),
        sourceSeq: data.startedSeq,
        timestamp: Date.parse(data.startedAt),
      });
      continue;
    }

    if (data.type === "structured_event") {
      messages.push(
        eventMessage(event, "system", [
          {
            type: "structured_event",
            namespace: data.namespace,
            name: data.name,
            version: data.version,
            presentation: data.presentation,
          },
        ]),
      );
      continue;
    }

    if (data.type === "attachments_delivered") {
      messages.push(
        eventMessage(event, "system", [
          {
            type: "attachments_delivered",
            attachments: data.attachments,
          },
        ]),
      );
      continue;
    }

    if (data.type === "compaction" || data.type === "handoff") {
      messages.push(
        eventMessage(event, "system", [
          {
            type: "context_event",
            event:
              data.type === "handoff"
                ? {
                    type: data.type,
                    createdAt: event.createdAt,
                    modelId: data.modelId,
                    modelProfile: data.modelProfile,
                    ...(data.summary ? { summary: data.summary } : undefined),
                    ...(data.reasoningLevel
                      ? { reasoningLevel: data.reasoningLevel }
                      : undefined),
                  }
                : {
                    type: data.type,
                    createdAt: event.createdAt,
                    ...(data.modelId ? { modelId: data.modelId } : undefined),
                    ...(data.modelProfile
                      ? { modelProfile: data.modelProfile }
                      : undefined),
                    ...(data.summary ? { summary: data.summary } : undefined),
                    ...(data.details ? { details: data.details } : undefined),
                  },
          },
        ]),
      );
      continue;
    }

    if (data.type === "turn_lifecycle" && data.state === "failed") {
      messages.push({
        role: data.failureCode === "delivery_failed" ? "system" : "assistant",
        failureCode: data.failureCode,
        ...(data.failureReason
          ? { failureReason: data.failureReason }
          : undefined),
        parts: [],
        sourceSeq: event.seq,
        timestamp: eventTimestamp(event),
      });
      continue;
    }
  }

  const ordered = messages
    .filter(
      (message) =>
        message.role !== "user" ||
        message.eventType !== undefined ||
        message.explicitMention !== false ||
        message.context === true,
    )
    .sort((left, right) => left.sourceSeq - right.sourceSeq);
  return mergePendingTranscriptMessages(ordered, pendingMessages);
}
