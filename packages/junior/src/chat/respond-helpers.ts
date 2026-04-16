/**
 * Pure helper functions used by the agent reply orchestration in respond.ts.
 *
 * These are extracted to reduce the size of the main orchestration module and
 * make individual helpers independently testable.
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Skill } from "@/chat/skills";

const MAX_INLINE_ATTACHMENT_BASE64_CHARS = 120_000;

/** Extract conversation and session identifiers from correlation context. */
export function getSessionIdentifiers(context: {
  correlation?: {
    conversationId?: string;
    threadId?: string;
    turnId?: string;
    runId?: string;
  };
}): {
  conversationId?: string;
  sessionId?: string;
} {
  return {
    conversationId:
      context.correlation?.conversationId ??
      context.correlation?.threadId ??
      context.correlation?.runId,
    sessionId: context.correlation?.turnId,
  };
}

/** Detect polite execution deferral phrases that signal the model is stalling. */
export function isExecutionDeferralResponse(text: string): boolean {
  return /\b(want me to proceed|do you want me to proceed|shall i proceed|can i proceed|should i proceed|let me do that now|give me a moment|tag me again|fresh invocation)\b/i.test(
    text,
  );
}

/** Detect disclaimers about missing tool access. */
export function isToolAccessDisclaimerResponse(text: string): boolean {
  return /\b(i (don't|do not) have access to (active )?tool|tool results came back empty|prior results .* empty|cannot access .*tool|need to (run|load) .*tool .* first)\b/i.test(
    text,
  );
}

/** True when the model produced an escape response instead of executing. */
export function isExecutionEscapeResponse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    isExecutionDeferralResponse(trimmed) ||
    isToolAccessDisclaimerResponse(trimmed)
  );
}

/** Best-effort JSON extraction from text that may contain fenced blocks. */
export function parseJsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenced) return undefined;
    try {
      return JSON.parse(fenced[1]) as unknown;
    } catch {
      return undefined;
    }
  }
}

/** Check whether a parsed object looks like a raw tool call/result payload. */
export function isToolPayloadShape(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;

  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type.startsWith("tool-")) return true;
  if (
    type === "tool_use" ||
    type === "tool_call" ||
    type === "tool_result" ||
    type === "tool_error"
  )
    return true;

  const hasToolName =
    typeof record.toolName === "string" || typeof record.name === "string";
  const hasToolInput =
    Object.prototype.hasOwnProperty.call(record, "input") ||
    Object.prototype.hasOwnProperty.call(record, "args");
  if (hasToolName && hasToolInput) return true;

  return false;
}

/** Detect responses that are raw tool payloads leaked as text. */
export function isRawToolPayloadResponse(text: string): boolean {
  const parsed = parseJsonCandidate(text);
  if (Array.isArray(parsed)) {
    return parsed.some((entry) => isToolPayloadShape(entry));
  }
  if (isToolPayloadShape(parsed)) {
    return true;
  }

  const compact = text.replace(/\s+/g, " ");
  return /"type"\s*:\s*"tool[-_](use|call|result|error)"/i.test(compact);
}

/** Redact image data from prompt content parts for observability. */
export function toObservablePromptPart(
  part:
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string },
): Record<string, unknown> {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text,
    };
  }

  return {
    type: "image",
    mimeType: part.mimeType,
    data: `[omitted:${part.data.length}]`,
  };
}

/** Truncate message text for log attributes. */
export function summarizeMessageText(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "[empty]";
  }
  return normalized.length > 1_200
    ? `${normalized.slice(0, 1_200)}...`
    : normalized;
}

/** Wrap user input with conversation context and observability metadata XML tags. */
export function buildUserTurnText(
  userInput: string,
  conversationContext?: string,
  metadata?: {
    sessionContext?: { conversationId?: string };
    turnContext?: { traceId?: string };
  },
): string {
  const trimmedContext = conversationContext?.trim();
  const hasSessionContext = Boolean(metadata?.sessionContext?.conversationId);
  const hasTurnContext = Boolean(metadata?.turnContext?.traceId);

  if (!trimmedContext && !hasSessionContext && !hasTurnContext) {
    return userInput;
  }

  const sections: string[] = [
    "<current-message>",
    userInput,
    "</current-message>",
  ];

  if (trimmedContext) {
    sections.push(
      "",
      "<thread-conversation-context>",
      "Use this context for continuity across prior thread turns.",
      trimmedContext,
      "</thread-conversation-context>",
    );
  }

  if (metadata?.sessionContext?.conversationId) {
    sections.push(
      "",
      "<session-context>",
      `- gen_ai.conversation.id: ${metadata.sessionContext.conversationId}`,
      "</session-context>",
    );
  }

  if (metadata?.turnContext?.traceId) {
    sections.push(
      "",
      "<turn-context>",
      `- trace_id: ${metadata.turnContext.traceId}`,
      "</turn-context>",
    );
  }

  return sections.join("\n");
}

/** Encode a non-image attachment as base64 XML for the prompt. */
export function encodeNonImageAttachmentForPrompt(attachment: {
  data: Buffer;
  mediaType: string;
  filename?: string;
}): string {
  const base64 = attachment.data.toString("base64");
  const wasTruncated = base64.length > MAX_INLINE_ATTACHMENT_BASE64_CHARS;
  const encodedPayload = wasTruncated
    ? `${base64.slice(0, MAX_INLINE_ATTACHMENT_BASE64_CHARS)}...`
    : base64;

  return [
    "<attachment>",
    `filename: ${attachment.filename ?? "unnamed"}`,
    `media_type: ${attachment.mediaType}`,
    "encoding: base64",
    `truncated: ${wasTruncated ? "true" : "false"}`,
    "<data_base64>",
    encodedPayload,
    "</data_base64>",
    "</attachment>",
  ].join("\n");
}

/** Build a user-facing message for execution failures. */
export function buildExecutionFailureMessage(toolErrorCount: number): string {
  if (toolErrorCount > 0) {
    return "I couldn't complete this because one or more required tools failed in this turn. I've logged the failure details.";
  }

  return "I couldn't complete this request in this turn due to an execution failure. I've logged the details for debugging.";
}

/** Type guard for Pi SDK tool result messages. */
export function isToolResultMessage(
  value: unknown,
): value is ToolResultMessage<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { role?: unknown }).role === "toolResult"
  );
}

/** Extract the tool name from a raw tool result message. */
export function normalizeToolNameFromResult(
  result: unknown,
): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as { toolName?: unknown; name?: unknown };
  if (typeof record.toolName === "string" && record.toolName.length > 0) {
    return record.toolName;
  }
  if (typeof record.name === "string" && record.name.length > 0) {
    return record.name;
  }
  return undefined;
}

/** Check whether a tool result carries an error flag. */
export function isToolResultError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return Boolean((result as { isError?: unknown }).isError);
}

/** Type guard for Pi SDK assistant messages. */
export function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { role?: unknown }).role === "assistant"
  );
}

/** Extract role string from a raw Pi message. */
export function getPiMessageRole(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const role = (value as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/** Concatenate text content parts from an assistant message. */
export function extractAssistantText(message: AssistantMessage): string {
  const content =
    (message as { content?: Array<{ type?: unknown; text?: unknown }> })
      .content ?? [];
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/** Return assistant messages that belong to the terminal post-tool reply phase. */
export function getTerminalAssistantMessages(
  messages: readonly unknown[],
): AssistantMessage[] {
  let lastToolResultIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isToolResultMessage(messages[index])) {
      lastToolResultIndex = index;
      break;
    }
  }

  return messages.slice(lastToolResultIndex + 1).filter(isAssistantMessage);
}

/** True when messages end with a completed, text-bearing assistant turn. */
export function hasCompletedAssistantTurn(messages: AgentMessage[]): boolean {
  const message = getTerminalAssistantMessages(messages).at(-1);
  if (!message) {
    return false;
  }

  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return (
    typeof stopReason === "string" &&
    stopReason !== "error" &&
    extractAssistantText(message).trim().length > 0
  );
}

/** Upsert a skill into the active skills list by name. */
export function upsertActiveSkill(activeSkills: Skill[], next: Skill): void {
  const existing = activeSkills.find((skill) => skill.name === next.name);
  if (existing) {
    existing.body = next.body;
    existing.description = next.description;
    existing.skillPath = next.skillPath;
    existing.allowedTools = next.allowedTools;
    existing.requiresCapabilities = next.requiresCapabilities;
    existing.usesConfig = next.usesConfig;
    existing.pluginProvider = next.pluginProvider;
    return;
  }

  activeSkills.push(next);
}

/** Collect configuration keys referenced by active and invoked skills. */
export function collectRelevantConfigurationKeys(
  activeSkills: Array<{ usesConfig?: string[] }>,
  explicitSkill?: { usesConfig?: string[] } | null,
): string[] {
  const keys = new Set<string>();
  for (const skill of [
    ...activeSkills,
    ...(explicitSkill ? [explicitSkill] : []),
  ]) {
    for (const key of skill.usesConfig ?? []) {
      keys.add(key);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** Remove trailing assistant messages before checkpointing. */
export function trimTrailingAssistantMessages(
  messages: AgentMessage[],
): AgentMessage[] {
  let end = messages.length;
  while (end > 0 && getPiMessageRole(messages[end - 1]) === "assistant") {
    end -= 1;
  }
  return end === messages.length ? [...messages] : messages.slice(0, end);
}
