import { readFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@/chat/coerce";
import { homeDir } from "@/chat/discovery";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentTurnUsage } from "@/chat/usage";
import {
  getPluginPackageContent,
  getPluginProviders,
} from "@/chat/plugins/registry";
import { discoverSkills } from "@/chat/skills";
import { parseSlackThreadId } from "@/chat/slack/context";
import {
  buildSentryConversationUrl,
  buildSentryTraceUrl,
} from "@/chat/sentry-links";
import {
  canExposeConversationPayload,
  resolveConversationPrivacy,
} from "@/chat/conversation-privacy";
import {
  getAgentTurnSessionRecord,
  listAgentTurnSessionSummaries,
  listAgentTurnSessionSummariesForConversation,
  type AgentTurnRequester,
  type AgentTurnSessionSummary,
} from "@/chat/state/turn-session";
import { GET as healthGET } from "@/handlers/health";

const HUNG_TURN_PROGRESS_MS = 5 * 60 * 1000;
const SAFE_METADATA_KEY_LIMIT = 20;

export interface HealthReport {
  status: "ok";
  service: string;
  timestamp: string;
}

export interface PluginReport {
  name: string;
}

export interface SkillReport {
  name: string;
  pluginProvider?: string;
}

export interface RuntimeInfoReport {
  cwd: string;
  homeDir: string;
  descriptionText?: string;
  providers: string[];
  skills: SkillReport[];
  packagedContent: ReturnType<typeof getPluginPackageContent>;
}

export interface DashboardSessionReport {
  conversationTitle?: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: AgentTurnUsage;
  conversationId: string;
  id: string;
  status: "active" | "completed" | "failed" | "hung" | "superseded";
  startedAt: string;
  lastSeenAt: string;
  lastProgressAt: string;
  completedAt?: string;
  surface?: "slack" | "api" | "scheduler" | "internal";
  title?: string;
  requester?: string;
  requesterIdentity?: AgentTurnRequester;
  channel?: string;
  channelName?: string;
  sentryConversationUrl?: string;
  sentryTraceUrl?: string;
  traceId?: string;
}

export interface DashboardTranscriptPart {
  bytes?: number;
  chars?: number;
  id?: string;
  input?: unknown;
  inputKeys?: string[];
  inputSizeBytes?: number;
  inputSizeChars?: number;
  inputType?: string;
  name?: string;
  output?: unknown;
  outputKeys?: string[];
  outputSizeBytes?: number;
  outputSizeChars?: number;
  outputType?: string;
  redacted?: boolean;
  text?: string;
  type: string;
}

export interface DashboardTranscriptMessage {
  parts: DashboardTranscriptPart[];
  role: string;
  timestamp?: number;
}

export interface DashboardTurnReport extends DashboardSessionReport {
  transcriptAvailable: boolean;
  transcriptMetadata?: DashboardTranscriptMessage[];
  transcriptMessageCount?: number;
  transcriptRedacted?: boolean;
  transcriptRedactionReason?: "non_public_conversation";
  transcript: DashboardTranscriptMessage[];
}

export interface DashboardConversationReport {
  conversationId: string;
  generatedAt: string;
  turns: DashboardTurnReport[];
}

export interface DashboardSessionFeed {
  sessions: DashboardSessionReport[];
  source: "turn_session_records";
  generatedAt: string;
}

export interface JuniorReporting {
  /** Read the public runtime health snapshot without exposing discovery data. */
  getHealth(): Promise<HealthReport>;
  /** Read authenticated dashboard runtime discovery data. */
  getRuntimeInfo(): Promise<RuntimeInfoReport>;
  /** Read configured plugin names for authenticated dashboard views. */
  getPlugins(): Promise<PluginReport[]>;
  /** Read discovered skill names for authenticated dashboard views. */
  getSkills(): Promise<SkillReport[]>;
  /**
   * Read recent turn metadata for authenticated dashboard views.
   *
   * Keep this API trace-shaped: callers should rely on timestamps, status,
   * actor, route, usage, and links that can later be reconstructed from spans.
   */
  getSessions(): Promise<DashboardSessionFeed>;
  /**
   * Read one conversation transcript for the dashboard.
   *
   * The current implementation joins turn-session records with expiring session
   * logs, but the API should stay compatible with a future Sentry trace-history
   * source. Avoid adding fields that require Redis-only transcript internals.
   */
  getConversation(conversationId: string): Promise<DashboardConversationReport>;
}

function readDescriptionText(): string | undefined {
  try {
    const raw = readFileSync(
      path.join(homeDir(), "DESCRIPTION.md"),
      "utf8",
    ).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

async function readHealth(): Promise<HealthReport> {
  const res = healthGET();
  return (await res.json()) as HealthReport;
}

async function readSkills(): Promise<SkillReport[]> {
  const skills = await discoverSkills();
  return skills.map((skill) => ({
    name: skill.name,
    pluginProvider: skill.pluginProvider,
  }));
}

async function readPlugins(): Promise<PluginReport[]> {
  return getPluginProviders().map((plugin) => ({
    name: plugin.manifest.name,
  }));
}

function statusFromCheckpoint(
  summary: AgentTurnSessionSummary,
): DashboardSessionReport["status"] {
  const state = summary.state;
  if (
    state === "running" &&
    Date.now() - summary.lastProgressAtMs > HUNG_TURN_PROGRESS_MS
  ) {
    return "hung";
  }
  if (state === "running" || state === "awaiting_resume") {
    return "active";
  }
  if (state === "abandoned") {
    return "superseded";
  }
  return state;
}

function surfaceFromConversationId(
  conversationId: string,
): DashboardSessionReport["surface"] {
  return parseSlackThreadId(conversationId) ? "slack" : "internal";
}

function titleFromSummary(summary: AgentTurnSessionSummary): string {
  if (summary.state === "awaiting_resume" && summary.resumeReason) {
    return `Awaiting ${summary.resumeReason} resume`;
  }
  return `Turn ${summary.sessionId}`;
}

function requesterLabel(
  requester: AgentTurnRequester | undefined,
): string | undefined {
  if (!requester) return undefined;
  return (
    requester.email ??
    requester.slackUserName ??
    requester.fullName ??
    requester.slackUserId
  );
}

function safePrivateLabel(summary: AgentTurnSessionSummary): string {
  const slackThread = parseSlackThreadId(summary.conversationId);
  if (slackThread?.channelId.startsWith("D")) {
    return "Direct Message";
  }
  if (slackThread?.channelId.startsWith("G")) {
    return summary.channelName?.startsWith("mpdm-")
      ? "Group DM"
      : "Private Channel";
  }
  return "Private Channel";
}

function sessionReportFromSummary(
  summary: AgentTurnSessionSummary,
): DashboardSessionReport {
  const slackThread = parseSlackThreadId(summary.conversationId);
  const privacy = resolveConversationPrivacy({
    conversationId: summary.conversationId,
  });
  const privateLabel =
    privacy !== "public" ? safePrivateLabel(summary) : undefined;
  const conversationTitle = privateLabel ?? summary.conversationTitle;
  const channelName = privateLabel ?? summary.channelName;
  const requester = requesterLabel(summary.requester);
  const sentryConversationUrl = buildSentryConversationUrl(
    summary.conversationId,
  );
  const sentryTraceUrl = summary.traceId
    ? buildSentryTraceUrl(summary.traceId)
    : undefined;
  return {
    conversationId: summary.conversationId,
    ...(conversationTitle ? { conversationTitle } : {}),
    id: summary.sessionId,
    status: statusFromCheckpoint(summary),
    startedAt: new Date(summary.startedAtMs).toISOString(),
    lastProgressAt: new Date(summary.lastProgressAtMs).toISOString(),
    lastSeenAt: new Date(summary.updatedAtMs).toISOString(),
    ...(summary.state === "completed"
      ? { completedAt: new Date(summary.updatedAtMs).toISOString() }
      : {}),
    ...(summary.cumulativeDurationMs !== undefined
      ? { cumulativeDurationMs: summary.cumulativeDurationMs }
      : {}),
    ...(summary.cumulativeUsage
      ? { cumulativeUsage: summary.cumulativeUsage }
      : {}),
    surface: surfaceFromConversationId(summary.conversationId),
    title: titleFromSummary(summary),
    ...(requester ? { requester } : {}),
    ...(summary.requester ? { requesterIdentity: summary.requester } : {}),
    ...(slackThread ? { channel: slackThread.channelId } : {}),
    ...(channelName ? { channelName } : {}),
    ...(sentryConversationUrl ? { sentryConversationUrl } : {}),
    ...(summary.traceId ? { traceId: summary.traceId } : {}),
    ...(sentryTraceUrl ? { sentryTraceUrl } : {}),
  };
}

function canExposeConversationTranscript(
  summary: AgentTurnSessionSummary,
): boolean {
  return canExposeConversationPayload({
    conversationId: summary.conversationId,
  });
}

function textPart(text: string): DashboardTranscriptPart {
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

function normalizeTranscriptPart(part: unknown): DashboardTranscriptPart {
  if (typeof part === "string") {
    return textPart(part);
  }
  if (!isRecord(part)) {
    return { type: "unknown", output: part };
  }

  const rawType = typeof part.type === "string" ? part.type : "unknown";
  if (rawType === "text") {
    const text = recordField(part, ["text", "content"]);
    return textPart(
      typeof text === "string" ? text : (JSON.stringify(text) ?? ""),
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
      output: recordField(part, ["thinking", "text", "content", "output"]),
    };
  }

  return {
    type: rawType,
    output: part,
  };
}

function normalizeToolResultMessage(
  record: Record<string, unknown>,
): DashboardTranscriptPart {
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

function normalizeTranscriptMessage(
  message: PiMessage,
): DashboardTranscriptMessage {
  const record = message as unknown as Record<string, unknown>;
  const content = record.content;
  const role = typeof record.role === "string" ? record.role : "unknown";
  return {
    role,
    ...(typeof record.timestamp === "number"
      ? { timestamp: record.timestamp }
      : {}),
    parts:
      role === "toolResult"
        ? [normalizeToolResultMessage(record)]
        : Array.isArray(content)
          ? content.map(normalizeTranscriptPart)
          : [normalizeTranscriptPart(content)],
  };
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

function redactedPayloadFields(prefix: "input" | "output", value: unknown) {
  const keys = payloadKeys(value);
  return {
    [`${prefix}Type`]: payloadType(value),
    [`${prefix}SizeBytes`]: serializedBytes(value),
    [`${prefix}SizeChars`]: serializedChars(value),
    ...(keys ? { [`${prefix}Keys`]: keys } : {}),
  };
}

function redactTranscriptPart(
  part: DashboardTranscriptPart,
): DashboardTranscriptPart {
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
    type: part.type,
    redacted: true,
    ...redactedPayloadFields("output", part.output ?? part.input ?? part.text),
  };
}

function redactTranscriptMessage(
  message: DashboardTranscriptMessage,
): DashboardTranscriptMessage {
  return {
    role: message.role,
    ...(typeof message.timestamp === "number"
      ? { timestamp: message.timestamp }
      : {}),
    parts: message.parts.map(redactTranscriptPart),
  };
}

function turnScopedMessages(messages: PiMessage[]): PiMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index] as unknown as Record<string, unknown>;
    if (record.role === "user") {
      return messages.slice(index);
    }
  }
  return messages;
}

function traceIdFromTranscript(
  transcript: DashboardTranscriptMessage[],
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

async function readSessions(): Promise<DashboardSessionFeed> {
  const summaries = await listAgentTurnSessionSummaries(50);
  return {
    source: "turn_session_records",
    generatedAt: new Date().toISOString(),
    sessions: summaries.map(sessionReportFromSummary),
  };
}

async function readConversation(
  conversationId: string,
): Promise<DashboardConversationReport> {
  const summaries = (
    await listAgentTurnSessionSummariesForConversation(conversationId)
  ).sort(
    (left, right) =>
      left.startedAtMs - right.startedAtMs ||
      left.updatedAtMs - right.updatedAtMs ||
      left.sessionId.localeCompare(right.sessionId),
  );

  const turns = await Promise.all(
    summaries.map(async (summary): Promise<DashboardTurnReport> => {
      const sessionRecord = await getAgentTurnSessionRecord(
        summary.conversationId,
        summary.sessionId,
      );
      const scopedMessages = sessionRecord?.piMessages
        ? turnScopedMessages(sessionRecord.piMessages)
        : [];
      const canExposeTranscript = canExposeConversationTranscript(summary);
      const normalizedTranscript = scopedMessages.map(
        normalizeTranscriptMessage,
      );
      const transcript = canExposeTranscript ? normalizedTranscript : [];
      const transcriptMetadata = canExposeTranscript
        ? undefined
        : normalizedTranscript.map(redactTranscriptMessage);
      const traceId =
        summary.traceId ??
        sessionRecord?.traceId ??
        (canExposeTranscript ? traceIdFromTranscript(transcript) : undefined);
      const sentryTraceUrl = traceId ? buildSentryTraceUrl(traceId) : undefined;
      return {
        ...sessionReportFromSummary(summary),
        ...(traceId ? { traceId } : {}),
        ...(sentryTraceUrl ? { sentryTraceUrl } : {}),
        transcriptAvailable: Boolean(sessionRecord) && canExposeTranscript,
        ...(sessionRecord && scopedMessages.length > 0
          ? { transcriptMessageCount: scopedMessages.length }
          : {}),
        ...(!canExposeTranscript
          ? {
              transcriptMetadata,
              transcriptRedacted: true,
              transcriptRedactionReason: "non_public_conversation" as const,
            }
          : {}),
        transcript,
      };
    }),
  );

  return {
    conversationId,
    generatedAt: new Date().toISOString(),
    turns,
  };
}

/** Create the read-only reporting boundary used by authenticated dashboard routes. */
export function createJuniorReporting(): JuniorReporting {
  return {
    getHealth: readHealth,
    async getRuntimeInfo() {
      const [plugins, skills] = await Promise.all([
        readPlugins(),
        readSkills(),
      ]);

      return {
        cwd: process.cwd(),
        homeDir: homeDir(),
        descriptionText: readDescriptionText(),
        providers: plugins.map((plugin) => plugin.name),
        skills,
        packagedContent: getPluginPackageContent(),
      };
    },
    getPlugins: readPlugins,
    getSkills: readSkills,
    getSessions: readSessions,
    getConversation: readConversation,
  };
}
