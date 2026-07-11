import { isRecord } from "@/chat/coerce";
import { unwrapCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";
import { unescapeXml } from "@/chat/xml";
import type {
  ConversationSubagentActivityReport,
  ConversationSubagentTranscriptReport,
  TranscriptMessage,
  TranscriptPart,
  TranscriptRole,
} from "./schema";

const SAFE_METADATA_KEY_LIMIT = 20;
const LEGACY_ADVISOR_TASK_OPEN = "<advisor-task>\n";
const LEGACY_ADVISOR_TASK_CLOSE = "\n</advisor-task>";
const LEGACY_EXECUTOR_CONTEXT_OPEN = "<executor-context>\n";
const LEGACY_EXECUTOR_CONTEXT_CLOSE = "\n</executor-context>";

/** Decode the advisor request wire format retained by historical SQL child rows. */
function unwrapLegacyAdvisorTask(text: string): string | undefined {
  // TODO(v0.97.0): Remove after raw advisor-task child messages are upgraded in SQL.
  if (
    !text.startsWith(LEGACY_ADVISOR_TASK_OPEN) ||
    !text.endsWith(LEGACY_EXECUTOR_CONTEXT_CLOSE)
  ) {
    return undefined;
  }

  const taskEnd = text.indexOf(
    LEGACY_ADVISOR_TASK_CLOSE,
    LEGACY_ADVISOR_TASK_OPEN.length,
  );
  if (taskEnd < 0) return undefined;

  const contextStart = taskEnd + LEGACY_ADVISOR_TASK_CLOSE.length + 2;
  if (!text.startsWith(LEGACY_EXECUTOR_CONTEXT_OPEN, contextStart)) {
    return undefined;
  }

  const task = text.slice(LEGACY_ADVISOR_TASK_OPEN.length, taskEnd);
  const context = text.slice(
    contextStart + LEGACY_EXECUTOR_CONTEXT_OPEN.length,
    -LEGACY_EXECUTOR_CONTEXT_CLOSE.length,
  );
  return `${unescapeXml(task)}\n\nExecutor context:\n${unescapeXml(context)}`;
}

function textPart(text: string): TranscriptPart {
  return { type: "text", text };
}

function recordField(value: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (value[name] !== undefined) {
      return value[name];
    }
  }
  return undefined;
}

function thinkingOutput(part: Record<string, unknown>): unknown {
  const output = recordField(part, ["thinking", "text", "content", "output"]);
  return isRecord(output)
    ? recordField(output, ["thinking", "text", "content", "output"])
    : output;
}

function isDisplayableTranscriptPart(part: TranscriptPart): boolean {
  if (part.type !== "thinking") return true;
  return typeof part.output === "string" && part.output.trim().length > 0;
}

/** Normalize Pi content parts for user-facing transcript output. */
function normalizeTranscriptPart(
  part: unknown,
  options: {
    unwrapCurrentTask?: boolean;
    unwrapLegacyAdvisorTask?: boolean;
  } = {},
): TranscriptPart {
  const displayText = (text: string) => {
    if (options.unwrapCurrentTask) {
      const instruction = unwrapCurrentInstruction(text);
      if (instruction !== undefined) return instruction;
    }
    if (options.unwrapLegacyAdvisorTask) {
      return unwrapLegacyAdvisorTask(text) ?? text;
    }
    return text;
  };

  if (typeof part === "string") {
    return textPart(displayText(part));
  }
  if (!isRecord(part)) {
    return { type: "unknown", output: part };
  }

  const rawType = typeof part.type === "string" ? part.type : "unknown";
  if (rawType === "text") {
    const text = recordField(part, ["text", "content"]);
    return textPart(
      typeof text === "string"
        ? displayText(text)
        : (JSON.stringify(text) ?? ""),
    );
  }
  if (rawType === "toolCall") {
    return {
      type: "tool_call",
      ...(typeof part.id === "string" ? { id: part.id } : {}),
      ...(typeof part.name === "string" ? { name: part.name } : {}),
      input: recordField(part, ["arguments", "input", "args"]),
    };
  }
  if (rawType === "toolResult") {
    return {
      type: "tool_result",
      ...(typeof part.id === "string" ? { id: part.id } : {}),
      ...(typeof part.name === "string" ? { name: part.name } : {}),
      output: recordField(part, ["result", "output", "content"]),
    };
  }
  if (rawType === "thinking") {
    return {
      type: "thinking",
      output: thinkingOutput(part),
    };
  }

  return {
    type: "unknown",
    ...(rawType !== "unknown" ? { sourceType: rawType } : {}),
    output: part,
  };
}

function normalizeToolResultMessage(
  record: Record<string, unknown>,
): TranscriptPart {
  const content = record.content;
  let output = content;
  if (Array.isArray(content) && content.length === 1 && isRecord(content[0])) {
    const extracted = recordField(content[0], [
      "text",
      "content",
      "output",
      "result",
    ]);
    output = extracted !== undefined ? extracted : content;
  }
  return {
    type: "tool_result",
    ...(typeof record.toolCallId === "string" ? { id: record.toolCallId } : {}),
    ...(typeof record.name === "string"
      ? { name: record.name }
      : typeof record.toolName === "string"
        ? { name: record.toolName }
        : {}),
    output,
  };
}

/** Normalize one provider transcript message into the reporting contract. */
export function normalizeTranscriptMessage(
  message: PiMessage,
): TranscriptMessage {
  return normalizeMessage(message);
}

/** Normalize a stored subagent message, including bounded legacy formats. */
export function normalizeSubagentTranscriptMessage(
  message: PiMessage,
  subagentKind: string,
): TranscriptMessage {
  return normalizeMessage(message, {
    unwrapLegacyAdvisorTask: subagentKind === "advisor",
  });
}

function normalizeMessage(
  message: PiMessage,
  options: { unwrapLegacyAdvisorTask?: boolean } = {},
): TranscriptMessage {
  const record = message as unknown as Record<string, unknown>;
  const content = record.content;
  const role = transcriptRole(record.role);
  return {
    role,
    ...(typeof record.timestamp === "number"
      ? { timestamp: record.timestamp }
      : {}),
    parts:
      role === "toolResult"
        ? [normalizeToolResultMessage(record)]
        : Array.isArray(content)
          ? content
              .map((part) =>
                normalizeTranscriptPart(part, {
                  unwrapCurrentTask: role === "user",
                  unwrapLegacyAdvisorTask:
                    options.unwrapLegacyAdvisorTask && role === "user",
                }),
              )
              .filter(isDisplayableTranscriptPart)
          : [
              normalizeTranscriptPart(content, {
                unwrapCurrentTask: role === "user",
                unwrapLegacyAdvisorTask:
                  options.unwrapLegacyAdvisorTask && role === "user",
              }),
            ],
  };
}

function transcriptRole(role: unknown): TranscriptRole {
  return role === "assistant" ||
    role === "system" ||
    role === "tool" ||
    role === "toolResult" ||
    role === "user"
    ? role
    : "unknown";
}

function serializedChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  return JSON.stringify(value)?.length ?? 0;
}

function serializedBytes(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(serialized ?? "").byteLength;
}

function payloadType(value: unknown): string {
  return Array.isArray(value) ? "array" : typeof value;
}

function payloadKeys(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const keys = Object.keys(value as Record<string, unknown>).slice(
    0,
    SAFE_METADATA_KEY_LIMIT,
  );
  return keys.length > 0 ? keys : undefined;
}

/** Describe a redacted payload without exposing its contents. */
export function redactedPayloadFields(
  prefix: "input" | "output",
  value: unknown,
) {
  const keys = payloadKeys(value);
  return {
    [`${prefix}Type`]: payloadType(value),
    [`${prefix}SizeBytes`]: serializedBytes(value),
    [`${prefix}SizeChars`]: serializedChars(value),
    ...(keys ? { [`${prefix}Keys`]: keys } : {}),
  };
}

function redactTranscriptPart(part: TranscriptPart): TranscriptPart {
  if (part.type === "text") {
    return {
      type: "text",
      redacted: true,
      bytes: serializedBytes(part.text ?? ""),
      chars: serializedChars(part.text ?? ""),
    };
  }
  if (part.type === "thinking") {
    return {
      type: "thinking",
      redacted: true,
      ...redactedPayloadFields("output", part.output),
    };
  }
  if (part.type === "tool_call") {
    return {
      type: "tool_call",
      redacted: true,
      ...(part.id ? { id: part.id } : {}),
      ...(part.name ? { name: part.name } : {}),
      ...redactedPayloadFields("input", part.input),
    };
  }
  if (part.type === "tool_result") {
    return {
      type: "tool_result",
      redacted: true,
      ...(part.id ? { id: part.id } : {}),
      ...(part.name ? { name: part.name } : {}),
      ...redactedPayloadFields("output", part.output),
    };
  }
  return {
    type: "unknown",
    redacted: true,
    ...(part.sourceType ? { sourceType: part.sourceType } : {}),
    ...redactedPayloadFields("output", part.output ?? part.input ?? part.text),
  };
}

/** Redact transcript payloads while retaining safe structural metadata. */
export function redactTranscriptMessage(
  message: TranscriptMessage,
): TranscriptMessage {
  return {
    role: message.role,
    ...(typeof message.timestamp === "number"
      ? { timestamp: message.timestamp }
      : {}),
    parts: message.parts.map(redactTranscriptPart),
  };
}

function isConversationMessageRole(role: TranscriptRole): boolean {
  return role === "user" || role === "assistant";
}

function hasTextPart(message: TranscriptMessage): boolean {
  return message.parts.some((part) => {
    if (part.type !== "text") return false;
    if (part.redacted) return true;
    return typeof part.text === "string" && part.text.trim().length > 0;
  });
}

function isConversationMessage(message: TranscriptMessage): boolean {
  if (!isConversationMessageRole(message.role)) return false;
  if (message.role === "assistant") return hasTextPart(message);
  return message.parts.length > 0;
}

/** Count user-visible conversation messages in a normalized transcript. */
export function countConversationMessages(
  transcript: TranscriptMessage[],
): number {
  return transcript.filter(isConversationMessage).length;
}

/** Read the latest trace identifier carried by a transcript message. */
export function traceIdFromTranscript(
  transcript: TranscriptMessage[],
): string | undefined {
  for (const message of transcript) {
    for (const part of message.parts) {
      const text =
        part.text ??
        (typeof part.output === "string"
          ? part.output
          : typeof part.input === "string"
            ? part.input
            : undefined);
      const match = text?.match(
        /\btrace[_-]?id["']?\s*[:=]\s*["']?([a-f0-9]{16,32})\b/i,
      );
      if (match?.[1]) {
        return match[1];
      }
    }
  }
  return undefined;
}

/** Build a subagent transcript response from its durable activity metadata. */
export function subagentTranscriptReport(
  activity: ConversationSubagentActivityReport,
  options: {
    subagentConversationId?: string;
    subagentSentryConversationUrl?: string;
    transcript?: TranscriptMessage[];
    transcriptMessageCount?: number;
    transcriptRedacted?: boolean;
    transcriptRedactionReason?: "non_public_conversation";
    transcriptExpired?: boolean;
    transcriptExpiredAt?: string;
    unavailableReason?: ConversationSubagentTranscriptReport["unavailableReason"];
  } = {},
): ConversationSubagentTranscriptReport {
  return {
    type: "subagent",
    ...(options.subagentConversationId
      ? { subagentConversationId: options.subagentConversationId }
      : {}),
    createdAt: activity.createdAt,
    id: activity.id,
    ...(activity.modelId ? { modelId: activity.modelId } : {}),
    status: activity.status,
    ...(options.subagentSentryConversationUrl
      ? { subagentSentryConversationUrl: options.subagentSentryConversationUrl }
      : {}),
    subagentKind: activity.subagentKind,
    transcript: options.transcript ?? [],
    transcriptAvailable: Boolean(options.transcript?.length),
    ...(activity.endedAt ? { endedAt: activity.endedAt } : {}),
    ...(activity.outcome ? { outcome: activity.outcome } : {}),
    ...(activity.parentToolCallId
      ? { parentToolCallId: activity.parentToolCallId }
      : {}),
    ...(activity.reasoningLevel
      ? { reasoningLevel: activity.reasoningLevel }
      : {}),
    ...(options.transcriptMessageCount !== undefined
      ? { transcriptMessageCount: options.transcriptMessageCount }
      : {}),
    ...(options.transcriptRedacted
      ? { transcriptRedacted: options.transcriptRedacted }
      : {}),
    ...(options.transcriptRedactionReason
      ? { transcriptRedactionReason: options.transcriptRedactionReason }
      : {}),
    ...(options.transcriptExpired
      ? { transcriptExpired: options.transcriptExpired }
      : {}),
    ...(options.transcriptExpiredAt
      ? { transcriptExpiredAt: options.transcriptExpiredAt }
      : {}),
    ...(options.unavailableReason
      ? { unavailableReason: options.unavailableReason }
      : {}),
  };
}
