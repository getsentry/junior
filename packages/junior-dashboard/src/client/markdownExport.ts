import {
  conversationDisplayTitle,
  formatCostTotal,
  formatMs,
  formatUsageTotal,
  actorLabel,
  slackLocationLabel,
  stringifyPartValue,
  transcriptRoleKind,
  unavailableTranscriptLabel,
} from "./format";
import {
  groupTranscriptMessages,
  messageRawText,
} from "./components/transcriptRenderModel";
import { conversationTranscriptMessages } from "./transcriptActivity";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import type { ConversationSubagentTranscriptReport } from "@sentry/junior/api/schema";
import type {
  Conversation,
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewPart,
  TranscriptViewContextEventPart,
  TranscriptViewSubagentPart,
} from "./types";

/** Build a clipboard Markdown transcript from the already-authorized dashboard report. */
export function buildConversationMarkdown(
  detail: ConversationDetailReport,
  conversation?: Conversation,
): string {
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
      formatCostTotal(detail.cumulativeUsage),
    ]
      .filter(Boolean)
      .join(" · "),
  );
  addMetaLine(lines, "Sentry conversation", detail.sentryConversationUrl);

  lines.push("", "## Transcript");
  appendConversationTranscript(lines, detail);

  return finishMarkdown(lines);
}

/** Build Markdown for one child-agent transcript using the shared formatter. */
export function buildSubagentMarkdown(
  report: ConversationSubagentTranscriptReport,
  conversationTranscript: ConversationTranscript,
): string {
  const lines: string[] = [`# ${headingText(report.subagentKind)}`, ""];
  addMetaLine(lines, "Subagent ID", inlineCode(report.id));
  addMetaLine(lines, "Conversation ID", report.subagentConversationId);
  addMetaLine(lines, "Created", report.createdAt);
  addMetaLine(lines, "Status", report.outcome ?? report.status);
  addMetaLine(
    lines,
    "Duration",
    formatMs(conversationTranscript.cumulativeDurationMs),
  );
  addMetaLine(
    lines,
    "Sentry conversation",
    report.subagentSentryConversationUrl,
  );
  lines.push("", "## Transcript");
  appendConversationTranscript(lines, conversationTranscript);
  return finishMarkdown(lines);
}

function appendConversationTranscript(
  lines: string[],
  conversationTranscript: ConversationTranscript,
): void {
  const transcript = conversationTranscriptMessages(conversationTranscript);

  if (conversationTranscript.transcriptAvailable) {
    appendTranscriptMessages(lines, conversationTranscript, transcript, false);
    return;
  }

  if (conversationTranscript.transcriptRedacted && transcript.length) {
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
      appendMessage(lines, conversationTranscript, entry.message, redacted);
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

    if (entry.kind === "thinking") {
      appendThinking(
        lines,
        conversationTranscript,
        entry.part,
        entry.timestamp,
        redacted,
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

    if (redacted) {
      appendRedactedTool(
        lines,
        conversationTranscript,
        entry.call,
        entry.result,
        entry.timestamp,
        entry.resultTimestamp,
      );
      continue;
    }

    appendTool(
      lines,
      conversationTranscript,
      entry.call,
      entry.result,
      entry.timestamp,
      entry.resultTimestamp,
    );
  }
}

function appendFailure(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  outcome: "error" | "aborted",
  timestamp: number | undefined,
): void {
  lines.push(
    "",
    outcome === "error"
      ? "### Agent response failed"
      : "### Agent response stopped",
  );
  addEventMeta(lines, conversationTranscript, timestamp);
  lines.push(
    "",
    outcome === "error"
      ? "The model response ended before Junior could complete this turn."
      : "The model response was stopped before Junior could complete this turn.",
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
    event.type === "model_handoff"
      ? "### Model handoff"
      : "### Context compacted",
  );
  addEventMeta(lines, conversationTranscript, timestamp);
  if (event.type === "model_handoff") {
    addMetaLine(lines, "From model", event.fromModelId);
    addMetaLine(lines, "To model", event.toModelId);
  } else {
    addMetaLine(lines, "Model", event.modelId);
  }
  const body = event.type === "model_handoff" ? event.message : event.summary;
  if (body) lines.push("", body);
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
    const redactedLines = message.parts.map(redactedPartLabel);
    lines.push("", ...redactedLines.map((line) => `- ${line}`));
    return;
  }

  const rawText = messageRawText(message);
  lines.push("", rawText.trim().length ? rawText : "_No content._");
}

function appendThinking(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  part: TranscriptViewPart,
  timestamp: number | undefined,
  redacted: boolean,
): void {
  lines.push("", "### Thinking");
  addEventMeta(lines, conversationTranscript, timestamp);

  if (redacted) {
    lines.push("", `- ${redactedPartLabel(part)}`);
    return;
  }

  lines.push("", fencedBlock(stringifyPartValue(part.output), "text"));
}

function appendSubagent(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  part: TranscriptViewSubagentPart,
  timestamp: number | undefined,
): void {
  lines.push("", `### Subagent: ${headingText(part.subagentKind)}`);
  addEventMeta(lines, conversationTranscript, timestamp);
  addMetaLine(lines, "Status", part.outcome ?? part.status);
  addMetaLine(lines, "Parent tool call", part.parentToolCallId);
}

function appendTool(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  call: TranscriptViewPart | undefined,
  result: TranscriptViewPart | undefined,
  timestamp: number | undefined,
  resultTimestamp: number | undefined,
): void {
  appendToolHeader(
    lines,
    conversationTranscript,
    call,
    result,
    timestamp,
    resultTimestamp,
  );
  lines.push("", fencedBlock(stringifyPartValue({ call, result }), "json"));
}

function appendRedactedTool(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  call: TranscriptViewPart | undefined,
  result: TranscriptViewPart | undefined,
  timestamp: number | undefined,
  resultTimestamp: number | undefined,
): void {
  appendToolHeader(
    lines,
    conversationTranscript,
    call,
    result,
    timestamp,
    resultTimestamp,
  );

  const redactedLines = [call, result]
    .filter((part): part is TranscriptViewPart => part !== undefined)
    .map(redactedPartLabel);
  lines.push("", ...redactedLines.map((line) => `- ${line}`));
}

function appendToolHeader(
  lines: string[],
  conversationTranscript: ConversationTranscript,
  call: TranscriptViewPart | undefined,
  result: TranscriptViewPart | undefined,
  timestamp: number | undefined,
  resultTimestamp: number | undefined,
): void {
  lines.push("", `### Tool: ${headingText(toolName(call, result))}`);
  addEventMeta(lines, conversationTranscript, timestamp);
  addMetaLine(lines, "Result timestamp", eventTimestamp(resultTimestamp));
  addMetaLine(lines, "Duration", toolDuration(timestamp, resultTimestamp));
  if (!result) {
    addMetaLine(
      lines,
      "Result",
      call?.status === "running" ? "running" : "missing",
    );
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
  detail: ConversationDetailReport,
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
  const kind = transcriptRoleKind(message.role);
  if (kind === "assistant")
    return conversationTranscript.assistantLabel ?? "Junior";
  if (kind === "user")
    return actorLabel(conversationTranscript.actorIdentity) ?? "User";
  if (kind === "system") return "System";
  if (kind === "tool") return "Tool";
  return headingText(message.role || "Unknown");
}

function redactedPartLabel(part: TranscriptViewPart): string {
  const meta = [
    part.type !== "text" ? part.type : "",
    part.name ? `name: ${inlineCode(part.name)}` : "",
    part.chars !== undefined ? `${part.chars} chars` : "",
    part.bytes !== undefined ? `${part.bytes} bytes` : "",
    part.inputType ? `input: ${part.inputType}` : "",
    part.outputType ? `output: ${part.outputType}` : "",
    part.inputKeys?.length ? `input keys: ${part.inputKeys.join(", ")}` : "",
    part.outputKeys?.length ? `output keys: ${part.outputKeys.join(", ")}` : "",
  ].filter(isNonEmptyString);
  return ["<redacted>", ...meta].join(" - ");
}

function toolName(
  call: TranscriptViewPart | undefined,
  result: TranscriptViewPart | undefined,
): string {
  return call?.name ?? result?.name ?? call?.id ?? result?.id ?? "unknown";
}

function toolDuration(
  timestamp: number | undefined,
  resultTimestamp: number | undefined,
): string {
  if (
    typeof timestamp !== "number" ||
    typeof resultTimestamp !== "number" ||
    !Number.isFinite(timestamp) ||
    !Number.isFinite(resultTimestamp) ||
    resultTimestamp < timestamp
  ) {
    return "";
  }
  return formatMs(resultTimestamp - timestamp);
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
