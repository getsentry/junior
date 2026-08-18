import {
  conversationDisplayTitle,
  formatConversationCostTotal,
  formatElapsedDuration,
  formatMs,
  formatUsageTotal,
  actorLabel,
  slackLocationLabel,
  stringifyPartValue,
  transcriptMessageActorLabel,
  unavailableTranscriptLabel,
} from "./format";
import {
  groupTranscriptMessages,
  messageRawText,
} from "./conversations/transcriptRenderModel";
import { getDashboardAgentName } from "./agentName";
import { conversationTranscriptMessages } from "./conversations/eventTranscript";
import type {
  Conversation,
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewContextEventPart,
  TranscriptViewSubagentPart,
  TranscriptViewToolCallPart,
  TranscriptViewTurnContext,
} from "./types";
import { memoryRecallContent } from "./conversations/turnContext";

/** Build a clipboard Markdown transcript from the already-authorized dashboard report. */
export function buildConversationMarkdown(
  detail: ConversationTranscript,
  conversation?: Conversation,
): string {
  if (detail.previousCursor) {
    throw new Error("Cannot export a partial conversation transcript");
  }
  const lines: string[] = [];

  lines.push(`# ${headingText(conversationTitle(detail, conversation))}`, "");
  addMetaLine(lines, "Conversation ID", inlineCode(detail.conversationId));
  addMetaLine(lines, "Generated", detail.generatedAt);
  addMetaLine(lines, "Actor", conversationActor(conversation, detail));
  addMetaLine(lines, "Location", conversationLocation(conversation, detail));
  addMetaLine(
    lines,
    "Usage",
    [
      formatUsageTotal(detail.cumulativeUsage),
      formatConversationCostTotal(
        detail.cumulativeUsage,
        detail.auxiliaryCosts,
      ),
    ]
      .filter(Boolean)
      .join(" · "),
  );
  addMetaLine(lines, "Sentry conversation", detail.sentryConversationUrl);

  lines.push("", "## Transcript");
  appendConversationTranscript(lines, detail);

  return finishMarkdown(lines);
}

function appendConversationTranscript(
  lines: string[],
  conversationTranscript: ConversationTranscript,
): void {
  const transcript = conversationTranscriptMessages(conversationTranscript);

  if (conversationTranscript.eventHistory.status === "available") {
    appendTranscriptMessages(lines, conversationTranscript, transcript, false);
    return;
  }

  if (
    conversationTranscript.eventHistory.status === "redacted" &&
    transcript.length
  ) {
    lines.push(
      "",
      "Transcript hidden because this conversation is not public.",
    );
    appendTranscriptMessages(lines, conversationTranscript, transcript, true);
    return;
  }

  if (transcript.length) {
    appendTranscriptMessages(lines, conversationTranscript, transcript, false);
    return;
  }

  lines.push("", unavailableTranscriptLabel(conversationTranscript));
}

function appendTranscriptMessages(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  messages: TranscriptViewMessage[],
  redacted: boolean,
): void {
  for (const entry of groupTranscriptMessages(messages)) {
    if (entry.kind === "message") {
      if (entry.message.eventType) {
        appendResourceEvent(
          lines,
          conversationTranscript,
          entry.message,
          redacted,
        );
      } else if (entry.message.context) {
        appendMessageContext(
          lines,
          conversationTranscript,
          entry.message,
          redacted,
        );
      } else {
        appendMessage(lines, conversationTranscript, entry.message, redacted);
      }
      continue;
    }

    if (entry.kind === "failure") {
      appendFailure(
        lines,
        conversationTranscript,
        entry.outcome,
        entry.timestamp,
      );
      continue;
    }

    if (entry.kind === "subagent") {
      appendSubagent(
        lines,
        conversationTranscript,
        entry.part,
        entry.timestamp,
      );
      continue;
    }

    if (entry.kind === "context") {
      appendContextEvent(
        lines,
        conversationTranscript,
        entry.part,
        entry.timestamp,
      );
      continue;
    }

    if (entry.kind === "reasoning") {
      appendReasoning(
        lines,
        conversationTranscript,
        entry.part,
        entry.timestamp,
      );
      continue;
    }

    if (entry.kind === "structured_event") {
      lines.push("", `### ${entry.part.presentation.title}`);
      addEventMeta(lines, conversationTranscript, entry.timestamp);
      if (entry.part.presentation.preview) {
        lines.push("", entry.part.presentation.preview);
      }
      for (const detail of entry.part.presentation.details ?? []) {
        lines.push("", `- ${detail.title}`);
        if (detail.description) lines.push(`  ${detail.description}`);
        if (detail.content) lines.push("", fencedBlock(detail.content, "md"));
        if (detail.metadata?.length) {
          lines.push(`  ${detail.metadata.join(" · ")}`);
        }
      }
      continue;
    }

    if (entry.kind === "attachments_delivered") {
      const count = entry.part.attachments.length;
      lines.push(
        "",
        `### ${count === 1 ? "1 file delivered" : `${count} files delivered`}`,
      );
      addEventMeta(lines, conversationTranscript, entry.timestamp);
      for (const attachment of entry.part.attachments) {
        lines.push(
          "",
          `- ${attachment.filename} (${attachment.contentType}, ${attachment.bytes} bytes)`,
        );
      }
      continue;
    }

    appendTool(lines, conversationTranscript, entry.part, entry.timestamp);
  }
}

function appendReasoning(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  part: Extract<TranscriptViewMessage["parts"][number], { type: "reasoning" }>,
  timestamp: number | undefined,
): void {
  lines.push("", "### Reasoning");
  addEventMeta(lines, conversationTranscript, timestamp);
  lines.push("", part.redacted ? "<redacted>" : part.text);
}

function appendFailure(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  outcome: "error" | "delivery_failed",
  timestamp: number | undefined,
): void {
  lines.push(
    "",
    outcome === "delivery_failed"
      ? "### Message delivery failed"
      : "### Agent response failed",
  );
  addEventMeta(lines, conversationTranscript, timestamp);
  lines.push(
    "",
    outcome === "delivery_failed"
      ? `${getDashboardAgentName()} could not deliver this message to its destination.`
      : `The model response ended before ${getDashboardAgentName()} could complete this turn.`,
  );
}

function appendContextEvent(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  part: TranscriptViewContextEventPart,
  timestamp: number | undefined,
): void {
  const event = part.event;
  lines.push(
    "",
    event.type === "handoff" ? "### Model handoff" : "### Context compacted",
  );
  addEventMeta(lines, conversationTranscript, timestamp);
  if (event.type === "handoff") {
    addMetaLine(lines, "Profile", event.modelProfile);
    addMetaLine(lines, "Model", event.modelId);
    addMetaLine(lines, "Reasoning", event.reasoningLevel);
  } else {
    addMetaLine(lines, "Profile", event.modelProfile);
    addMetaLine(lines, "Model", event.modelId);
    if (event.details) {
      addMetaLine(
        lines,
        "Estimated input tokens",
        String(event.details.estimatedInputTokens),
      );
      if (event.details.replacementInputTokens !== undefined) {
        addMetaLine(
          lines,
          "Replacement input tokens",
          String(event.details.replacementInputTokens),
        );
      }
      addMetaLine(
        lines,
        "Compaction trigger",
        String(event.details.triggerTokens),
      );
      addMetaLine(lines, "Input limit", String(event.details.inputLimitTokens));
      addMetaLine(
        lines,
        "Input messages",
        String(event.details.inputMessageCount),
      );
      addMetaLine(
        lines,
        "Retained messages",
        String(event.details.retainedMessageCount),
      );
      addMetaLine(
        lines,
        "Summary characters",
        String(event.details.summaryChars),
      );
    }
  }
  if (event.summary) {
    lines.push("", "#### Continuation summary", "", event.summary);
  }
}

function appendResourceEvent(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  message: TranscriptViewMessage,
  redacted: boolean,
): void {
  lines.push("", `### Event: ${headingText(message.eventType ?? "")}`);
  addEventMeta(lines, conversationTranscript, message.timestamp);

  if (redacted) {
    lines.push("", "- <redacted>");
    return;
  }

  const rawText = messageRawText(message);
  lines.push("", rawText.trim().length ? rawText : "_No content._");
}

function appendMessageContext(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  message: TranscriptViewMessage,
  redacted: boolean,
): void {
  lines.push(
    "",
    `### Context from ${messageRoleLabel(message, conversationTranscript)}`,
  );
  addEventMeta(lines, conversationTranscript, message.timestamp);
  lines.push("", redacted ? "<redacted>" : messageRawText(message));
  if (!redacted) {
    appendTurnContexts(lines, message.contexts);
  }
}

function appendMessage(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  message: TranscriptViewMessage,
  redacted: boolean,
): void {
  lines.push("", `### ${messageRoleLabel(message, conversationTranscript)}`);
  addEventMeta(lines, conversationTranscript, message.timestamp);

  if (redacted) {
    lines.push("", ...message.parts.map(() => "- <redacted>"));
    return;
  }

  const rawText = messageRawText(message);
  lines.push("", rawText.trim().length ? rawText : "_No content._");
  appendTurnContexts(lines, message.contexts);
}

function appendTurnContexts(
  lines: string[],
  contexts: TranscriptViewTurnContext[] | undefined,
): void {
  for (const context of contexts ?? []) {
    const memory = memoryRecallContent(context);
    lines.push(
      "",
      memory
        ? "#### Recalled memories"
        : `#### ${headingText(context.kind)} context`,
    );
    addMetaLine(lines, "Plugin", context.pluginName);
    addMetaLine(lines, "Loaded", context.loadedAt);
    if (!memory) {
      lines.push(
        "",
        "```json",
        JSON.stringify(context.content, null, 2),
        "```",
      );
      continue;
    }
    for (const item of memory.memories) {
      lines.push(
        "",
        `- ${item.content}`,
        `  - ID: ${inlineCode(item.id)}`,
        `  - Observed: ${new Date(item.observedAtMs).toISOString()}`,
        `  - Scope: ${item.scope}`,
        `  - Kind: ${item.kind}`,
      );
    }
  }
}

function appendSubagent(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  part: TranscriptViewSubagentPart,
  timestamp: number | undefined,
): void {
  lines.push("", `### Subagent: ${headingText(part.subagentKind)}`);
  addEventMeta(lines, conversationTranscript, timestamp);
  addMetaLine(lines, "Status", part.status);
}

function appendTool(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  part: TranscriptViewToolCallPart,
  timestamp: number | undefined,
): void {
  lines.push("", `### Tool: ${headingText(part.name)}`);
  addEventMeta(lines, conversationTranscript, timestamp);
  addMetaLine(lines, "Status", part.status);
  addMetaLine(
    lines,
    "Duration",
    formatElapsedDuration(timestamp, part.resultTimestamp),
  );
  const input = stringifyPartValue(part.input);
  if (input) {
    lines.push("", "#### Arguments", "", fencedBlock(input, "json"));
  }
  const output = stringifyPartValue(part.output);
  if (output) {
    lines.push("", "#### Result", "", fencedBlock(output, "json"));
  }
}

function addEventMeta(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  timestamp: number | undefined,
): void {
  const meta = [
    eventTimestamp(timestamp),
    eventOffset(conversationTranscript, timestamp),
  ].filter(isNonEmptyString);
  if (meta.length) {
    lines.push("", `_${meta.join(" - ")}_`);
  }
}

function conversationTitle(
  detail: ConversationTranscript,
  conversation: Conversation | undefined,
): string {
  const title = detail.displayTitle.trim();
  if (title) return title;
  return conversation ? conversationDisplayTitle(conversation) : "Conversation";
}

function conversationActor(
  conversation: Conversation | undefined,
  conversationTranscript: ConversationTranscript | undefined,
): string {
  return (
    actorLabel(
      conversation?.actorIdentity ?? conversationTranscript?.actorIdentity,
    ) ?? ""
  );
}

function conversationLocation(
  conversation: Conversation | undefined,
  conversationTranscript: ConversationTranscript | undefined,
): string {
  if (conversation) return slackLocationLabel(conversation) ?? "";
  return conversationTranscript
    ? (slackLocationLabel(conversationTranscript) ?? "")
    : "";
}

function messageRoleLabel(
  message: TranscriptViewMessage,
  conversationTranscript: ConversationTranscript,
): string {
  return headingText(
    transcriptMessageActorLabel(conversationTranscript, message),
  );
}

function eventTimestamp(timestamp: number | undefined): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toISOString();
}

function eventOffset(
  conversationTranscript: ConversationTranscript,
  timestamp: number | undefined,
): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "";
  const start = Date.parse(conversationTranscript.startedAt);
  if (!Number.isFinite(start) || timestamp < start) return "";
  return `+${formatMs(timestamp - start)}`;
}

function addMetaLine(
  lines: string[],
  label: string,
  value: string | undefined,
): void {
  if (!value) return;
  lines.push(`- ${label}: ${value}`);
}

function headingText(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "Untitled";
}

function inlineCode(value: string): string {
  const fence = value.includes("`") ? "``" : "`";
  return `${fence}${value}${fence}`;
}

function fencedBlock(value: string, language: string): string {
  const longestBacktickRun = [...value.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function finishMarkdown(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function isNonEmptyString(value: string): boolean {
  return value.length > 0;
}
