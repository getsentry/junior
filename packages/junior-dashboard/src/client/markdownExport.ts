import {
  conversationDisplayTitle,
  formatMs,
  formatUsageTotal,
  requesterLabel,
  slackLocationLabel,
  stringifyPartValue,
  transcriptRoleKind,
  unavailableTranscriptLabel,
} from "./format";
import {
  groupTranscriptMessages,
  messageRawText,
} from "./components/transcriptRenderModel";
import { turnTranscriptMessages } from "./transcriptActivity";
import type {
  Conversation,
  ConversationDetailFeed,
  ConversationTurn,
  TranscriptViewMessage,
  TranscriptViewPart,
  TranscriptViewSubagentPart,
} from "./types";

/** Build a clipboard Markdown transcript from the already-authorized dashboard report. */
export function buildConversationMarkdown(
  detail: ConversationDetailFeed,
  conversation?: Conversation,
): string {
  const lines: string[] = [];
  const firstTurn = detail.runs[0];

  lines.push(`# ${headingText(conversationTitle(detail, conversation))}`, "");
  addMetaLine(lines, "Conversation ID", inlineCode(detail.conversationId));
  addMetaLine(lines, "Generated", detail.generatedAt);
  addMetaLine(
    lines,
    "Requester",
    conversationRequester(conversation, firstTurn),
  );
  addMetaLine(lines, "Location", conversationLocation(conversation, firstTurn));
  addMetaLine(
    lines,
    "Usage",
    formatUsageTotal(detail.runs.map((turn) => turn.cumulativeUsage)),
  );
  addMetaLine(lines, "Sentry conversation", detail.sentryConversationUrl);

  if (detail.runs.length === 0) {
    lines.push("", "## Transcript", "", "No transcript is available.");
    return finishMarkdown(lines);
  }

  lines.push("", "## Transcript");
  detail.runs.forEach((turn) => {
    appendTurnTranscript(lines, turn);
  });

  return finishMarkdown(lines);
}

function appendTurnTranscript(lines: string[], turn: ConversationTurn): void {
  const transcript = turnTranscriptMessages(turn);

  if (turn.transcriptAvailable) {
    appendTranscriptMessages(lines, turn, transcript, false);
    return;
  }

  if (turn.transcriptRedacted && transcript.length) {
    lines.push(
      "",
      "Transcript hidden because this conversation is not public.",
    );
    appendTranscriptMessages(lines, turn, transcript, true);
    return;
  }

  if (transcript.length) {
    appendTranscriptMessages(lines, turn, transcript, false);
    return;
  }

  lines.push("", unavailableTranscriptLabel(turn));
}

function appendTranscriptMessages(
  lines: string[],
  turn: ConversationTurn,
  messages: TranscriptViewMessage[],
  redacted: boolean,
): void {
  for (const entry of groupTranscriptMessages(messages)) {
    if (entry.kind === "message") {
      appendMessage(lines, turn, entry.message, redacted);
      continue;
    }

    if (entry.kind === "thinking") {
      appendThinking(lines, turn, entry.part, entry.timestamp, redacted);
      continue;
    }

    if (entry.kind === "subagent") {
      appendSubagent(lines, turn, entry.part, entry.timestamp);
      continue;
    }

    if (redacted) {
      appendRedactedTool(
        lines,
        turn,
        entry.call,
        entry.result,
        entry.timestamp,
        entry.resultTimestamp,
      );
      continue;
    }

    appendTool(
      lines,
      turn,
      entry.call,
      entry.result,
      entry.timestamp,
      entry.resultTimestamp,
    );
  }
}

function appendMessage(
  lines: string[],
  turn: ConversationTurn,
  message: TranscriptViewMessage,
  redacted: boolean,
): void {
  lines.push("", `### ${messageRoleLabel(message, turn)}`);
  addEventMeta(lines, turn, message.timestamp);

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
  turn: ConversationTurn,
  part: TranscriptViewPart,
  timestamp: number | undefined,
  redacted: boolean,
): void {
  lines.push("", "### Thinking");
  addEventMeta(lines, turn, timestamp);

  if (redacted) {
    lines.push("", `- ${redactedPartLabel(part)}`);
    return;
  }

  lines.push("", fencedBlock(stringifyPartValue(part.output), "text"));
}

function appendSubagent(
  lines: string[],
  turn: ConversationTurn,
  part: TranscriptViewSubagentPart,
  timestamp: number | undefined,
): void {
  lines.push("", `### Subagent: ${headingText(part.subagentKind)}`);
  addEventMeta(lines, turn, timestamp);
  addMetaLine(lines, "Status", part.outcome ?? part.status);
  addMetaLine(lines, "Parent tool call", part.parentToolCallId);
}

function appendTool(
  lines: string[],
  turn: ConversationTurn,
  call: TranscriptViewPart | undefined,
  result: TranscriptViewPart | undefined,
  timestamp: number | undefined,
  resultTimestamp: number | undefined,
): void {
  appendToolHeader(lines, turn, call, result, timestamp, resultTimestamp);
  lines.push("", fencedBlock(stringifyPartValue({ call, result }), "json"));
}

function appendRedactedTool(
  lines: string[],
  turn: ConversationTurn,
  call: TranscriptViewPart | undefined,
  result: TranscriptViewPart | undefined,
  timestamp: number | undefined,
  resultTimestamp: number | undefined,
): void {
  appendToolHeader(lines, turn, call, result, timestamp, resultTimestamp);

  const redactedLines = [call, result]
    .filter((part): part is TranscriptViewPart => part !== undefined)
    .map(redactedPartLabel);
  lines.push("", ...redactedLines.map((line) => `- ${line}`));
}

function appendToolHeader(
  lines: string[],
  turn: ConversationTurn,
  call: TranscriptViewPart | undefined,
  result: TranscriptViewPart | undefined,
  timestamp: number | undefined,
  resultTimestamp: number | undefined,
): void {
  lines.push("", `### Tool: ${headingText(toolName(call, result))}`);
  addEventMeta(lines, turn, timestamp);
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
  turn: ConversationTurn,
  timestamp: number | undefined,
): void {
  const meta = [eventTimestamp(timestamp), eventOffset(turn, timestamp)].filter(
    isNonEmptyString,
  );
  if (meta.length) {
    lines.push("", `_${meta.join(" - ")}_`);
  }
}

function conversationTitle(
  detail: ConversationDetailFeed,
  conversation: Conversation | undefined,
): string {
  const title = detail.displayTitle.trim();
  if (title) return title;
  return conversation ? conversationDisplayTitle(conversation) : "Conversation";
}

function conversationRequester(
  conversation: Conversation | undefined,
  turn: ConversationTurn | undefined,
): string {
  return (
    requesterLabel(
      conversation?.requesterIdentity ?? turn?.requesterIdentity,
    ) ?? ""
  );
}

function conversationLocation(
  conversation: Conversation | undefined,
  turn: ConversationTurn | undefined,
): string {
  if (conversation) return slackLocationLabel(conversation) ?? "";
  return turn ? (slackLocationLabel(turn) ?? "") : "";
}

function messageRoleLabel(
  message: TranscriptViewMessage,
  turn: ConversationTurn,
): string {
  const kind = transcriptRoleKind(message.role);
  if (kind === "assistant") return "Junior";
  if (kind === "user") return requesterLabel(turn.requesterIdentity) ?? "User";
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
  turn: ConversationTurn,
  timestamp: number | undefined,
): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "";
  const start = Date.parse(turn.startedAt);
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
