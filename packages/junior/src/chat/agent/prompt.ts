/**
 * Per-run prompt assembly.
 *
 * Builds the user-turn content parts (text, attachments, omitted-image
 * notices) and the full prompt for one run slice: system instructions, plugin
 * contributions, bootstrap turn context, resume-safe history trimming, and
 * the optional canonical telemetry view of public input messages.
 */
import { isDeepStrictEqual } from "node:util";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import {
  sandboxSkillDir,
  sandboxSkillFile,
  sandboxSkillPathResolution,
} from "@/chat/sandbox/paths";
import {
  buildPluginSystemPromptContributions,
  buildSystemPrompt,
  buildTurnContextPrompt,
} from "@/chat/prompt";
import {
  getPluginSystemPromptContributions,
  getPluginUserPromptContributions,
} from "@/chat/plugins/agent-hooks";
import type { PiMessage } from "@/chat/pi/messages";
import {
  hasRuntimeTurnContext,
  retainRuntimeTurnContext,
  stripRuntimeTurnContext,
} from "@/chat/pi/transcript";
import { serializeGenAiAttribute, type LogContext } from "@/chat/logging";
import type { ConversationPrivacy } from "@/chat/conversation-privacy";
import type { Skill, SkillMetadata } from "@/chat/skills";
import type { ActiveMcpCatalogSummary } from "@/chat/tool-support/skill/mcp-tool-summary";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import { isUserActor, type Actor } from "@/chat/actor";
import type { PluginTurnContext } from "@/chat/plugins/prompt";
import { escapeXml } from "@/chat/xml";
import type {
  AgentAttachment,
  AgentInstruction,
  AgentInstructionActor,
  AgentRun,
  AgentSteeringMessage,
} from "@/chat/agent/types";

const MAX_INLINE_ATTACHMENT_BASE64_CHARS = 120_000;
const MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS = 2_000;

export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type UserTurnAttachment = NonNullable<AgentInstruction["attachments"]>[number];

/** User-turn content parts plus the plain-text blocks used for routing decisions. */
export interface PromptInput {
  contextContentParts: UserContentPart[];
  routerBlocks: string[];
  userContentParts: UserContentPart[];
}

/** Fully assembled prompt state for one run slice. */
export interface PromptAssembly {
  baseInstructions: string;
  contextContentParts: UserContentPart[];
  inputMessages: Array<{
    role: string;
    content: Record<string, unknown>[];
  }>;
  inputMessagesAttribute: string | undefined;
  promptTimestamp?: number;
  promptHistoryMessages: PiMessage[];
  shouldPromptAgent: boolean;
  turnContexts: PluginTurnContext[];
  userContentParts: UserContentPart[];
}

/**
 * Keep host-owned thread history as one evidence-only block.
 *
 * Producers already emit `<thread-context>`. Only wrap plain unstructured
 * background text so ambient messages never look like more instruction.
 */
function renderThreadContextForPrompt(context: string): string {
  if (
    /^<(?:thread-context|thread-compactions|thread-transcript|thread-background|recent-thread-messages)(?:\s|>)/.test(
      context,
    )
  ) {
    return context;
  }
  return [
    '<thread-context authority="evidence-only">',
    context,
    "</thread-context>",
  ].join("\n");
}

/** Render the current actor's instruction without host-owned thread context. */
export function buildUserTurnText(
  userInput: string,
  actor?: AgentInstructionActor,
): string {
  return renderCurrentInstruction(userInput, actor);
}

/** Render an explicitly selected skill as instructions for the current turn. */
export function renderExplicitSkillInstructions(skill: Skill): string {
  return [
    "<skill>",
    `<name>${escapeXml(skill.name)}</name>`,
    `<path>${escapeXml(sandboxSkillFile(skill.name))}</path>`,
    `<working_directory>${escapeXml(sandboxSkillDir(skill.name))}</working_directory>`,
    `<path_resolution>${escapeXml(sandboxSkillPathResolution(skill.name))}</path_resolution>`,
    skill.body,
    "</skill>",
  ].join("\n");
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

/** Redact image data from prompt content parts for observability. */
export function toObservablePromptPart(
  part: UserContentPart,
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

function buildOmittedImageAttachmentNotice(count: number): string {
  return [
    "<omitted-image-attachments>",
    `count: ${count}`,
    "Slack included image attachments with this turn, but this runtime cannot analyze images because no vision model is configured.",
    "Do not claim that no image was attached.",
    "If the user asks about image contents, explain that image analysis is unavailable in this runtime and continue with any text or non-image files that are still available.",
    "</omitted-image-attachments>",
  ].join("\n");
}

function trimRouterAttachmentText(text: string): string {
  const normalized = text.replaceAll("\0", " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length <= MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS)}...`;
}

function supportsRouterTextPreview(mediaType: string): boolean {
  const baseMediaType = mediaType.split(";", 1)[0]?.trim().toLowerCase();
  if (!baseMediaType) {
    return false;
  }
  return (
    baseMediaType.startsWith("text/") ||
    baseMediaType === "application/json" ||
    baseMediaType === "application/xml" ||
    baseMediaType === "application/x-www-form-urlencoded" ||
    baseMediaType.endsWith("+json") ||
    baseMediaType.endsWith("+xml")
  );
}

function buildRouterAttachmentBlock(attachment: UserTurnAttachment): string {
  if (attachment.promptText) {
    return trimRouterAttachmentText(attachment.promptText);
  }

  const header = [
    "<attachment>",
    `filename: ${attachment.filename ?? "unnamed"}`,
    `media_type: ${attachment.mediaType}`,
  ];

  if (attachment.data && supportsRouterTextPreview(attachment.mediaType)) {
    const preview = trimRouterAttachmentText(attachment.data.toString("utf8"));
    if (preview) {
      return [
        ...header,
        "<text-preview>",
        preview,
        "</text-preview>",
        "</attachment>",
      ].join("\n");
    }
  }

  return [...header, "</attachment>"].join("\n");
}

function buildUserTurnInput(args: {
  omittedImageAttachmentCount: number;
  userAttachments?: AgentAttachment[];
  userTurnText: string;
}): PromptInput {
  const routerBlocks: string[] = [];
  const userContentParts: UserContentPart[] = [
    { type: "text", text: args.userTurnText },
  ];

  if (args.omittedImageAttachmentCount > 0) {
    const omittedImagesNotice = buildOmittedImageAttachmentNotice(
      args.omittedImageAttachmentCount,
    );
    userContentParts.push({ type: "text", text: omittedImagesNotice });
    routerBlocks.push(omittedImagesNotice);
  }

  for (const attachment of args.userAttachments ?? []) {
    routerBlocks.push(buildRouterAttachmentBlock(attachment));

    if (attachment.promptText) {
      userContentParts.push({
        type: "text",
        text: attachment.promptText,
      });
      continue;
    }

    if (attachment.mediaType.startsWith("image/")) {
      if (!attachment.data) {
        throw new Error("Image attachment is missing image data");
      }
      userContentParts.push({
        type: "image",
        data: attachment.data.toString("base64"),
        mimeType: attachment.mediaType,
      });
      continue;
    }

    if (!attachment.data) {
      throw new Error("Attachment is missing attachment data");
    }

    userContentParts.push({
      type: "text",
      text: encodeNonImageAttachmentForPrompt({
        data: attachment.data,
        mediaType: attachment.mediaType,
        filename: attachment.filename,
      }),
    });
  }

  return { contextContentParts: [], routerBlocks, userContentParts };
}

/** Build the prompt-facing user input, keeping router text aligned with Pi content. */
export function buildPromptInput(args: {
  instruction: AgentInstruction;
  history?: readonly import("@/chat/pi/messages").PiMessage[];
}): PromptInput {
  const { instruction, history } = args;
  const promptConversationContext =
    history &&
    history.length > 0 &&
    !instruction.includeConversationContextWithHistory
      ? undefined
      : instruction.context;
  const promptInput = buildUserTurnInput({
    omittedImageAttachmentCount: instruction.omittedImageAttachmentCount ?? 0,
    userAttachments: instruction.attachments
      ? [...instruction.attachments]
      : undefined,
    userTurnText: buildUserTurnText(instruction.text, instruction.actor),
  });
  const trimmedContext = promptConversationContext?.trim();
  return {
    ...promptInput,
    contextContentParts: trimmedContext
      ? [{ type: "text", text: renderThreadContextForPrompt(trimmedContext) }]
      : [],
  };
}

/**
 * Convert a mid-run user message into the Pi user message shape used for
 * steering injection and parked-conversation event-log appends, so both
 * paths store identical durable history.
 */
export function buildSteeringPiMessage(
  message: AgentSteeringMessage,
): PiMessage {
  const { userContentParts } = buildUserTurnInput({
    userTurnText: buildUserTurnText(message.text, message.actor),
    userAttachments: message.attachments ? [...message.attachments] : undefined,
    omittedImageAttachmentCount: message.omittedImageAttachmentCount ?? 0,
  });
  return {
    role: "user",
    content: userContentParts,
    timestamp: message.timestampMs ?? Date.now(),
  } as PiMessage;
}

function withoutTrailingUncheckpointedUserPrompt(
  messages: PiMessage[] | undefined,
  userContentParts: UserContentPart[],
): { messages: PiMessage[]; promptTimestamp?: number } {
  if (!messages || messages.length === 0) {
    return { messages: [] };
  }

  const lastMessage = messages.at(-1) as
    | { content?: unknown; role?: unknown }
    | undefined;
  if (lastMessage?.role !== "user") {
    return { messages };
  }
  const comparableLastMessage = stripRuntimeTurnContext([
    lastMessage as PiMessage,
  ])[0] as { content?: unknown } | undefined;
  if (
    !userPromptContentMatches(comparableLastMessage?.content, userContentParts)
  ) {
    return { messages };
  }
  const promptTimestamp =
    typeof (lastMessage as { timestamp?: unknown }).timestamp === "number"
      ? (lastMessage as { timestamp: number }).timestamp
      : undefined;
  const withoutPrompt = messages.slice(0, -1);
  const previousMessage = withoutPrompt.at(-1);
  if (
    previousMessage &&
    stripRuntimeTurnContext([previousMessage, lastMessage as PiMessage])
      .length === 1
  ) {
    return { messages: withoutPrompt.slice(0, -1), promptTimestamp };
  }
  return { messages: withoutPrompt, promptTimestamp };
}

// Deep equality, not serialized-string equality: durable history round-trips
// through jsonb, which does not preserve object key order.
function userPromptContentMatches(
  storedContent: unknown,
  currentContent: UserContentPart[],
): boolean {
  return isDeepStrictEqual(storedContent, currentContent);
}

function isUserContentPart(value: unknown): value is UserContentPart {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  if (value.type === "text") {
    return "text" in value && typeof value.text === "string";
  }
  return (
    value.type === "image" &&
    "data" in value &&
    typeof value.data === "string" &&
    "mimeType" in value &&
    typeof value.mimeType === "string"
  );
}

// A failed input acknowledgement redelivers the same running checkpoint.
// Reuse its exact prompt so plugin context cannot diverge from its durable event.
function checkpointedPrompt(args: {
  messages: PiMessage[] | undefined;
  turnStartMessageIndex: number | undefined;
  userContentParts: UserContentPart[];
}):
  | {
      contextContentParts: UserContentPart[];
      userContentParts: UserContentPart[];
    }
  | undefined {
  if (
    !args.messages ||
    args.turnStartMessageIndex === undefined ||
    args.turnStartMessageIndex >= args.messages.length
  ) {
    return undefined;
  }
  const turnMessages = args.messages.slice(args.turnStartMessageIndex);
  const durableTurnMessages = stripRuntimeTurnContext(turnMessages);
  if (durableTurnMessages.length !== 1) {
    return undefined;
  }
  const message = durableTurnMessages[0] as
    | { content?: unknown; role?: unknown }
    | undefined;
  if (message?.role !== "user" || !Array.isArray(message.content)) {
    return undefined;
  }
  if (!userPromptContentMatches(message.content, args.userContentParts)) {
    return undefined;
  }
  if (!message.content.every(isUserContentPart)) {
    return undefined;
  }
  const contextContentParts = retainRuntimeTurnContext(turnMessages).flatMap(
    (runtimeMessage) => {
      const content = (runtimeMessage as { content?: unknown }).content;
      return Array.isArray(content) && content.every(isUserContentPart)
        ? content
        : [];
    },
  );
  return {
    contextContentParts,
    userContentParts: message.content,
  };
}

/** Assemble prompt history, instructions, and telemetry input for one slice. */
export async function assemblePrompt(args: {
  activeMcpCatalogs: ActiveMcpCatalogSummary[];
  currentActor?: Actor;
  availableSkills: SkillMetadata[];
  configurationValues: Record<string, unknown>;
  contextContentParts: UserContentPart[];
  conversationPrivacy?: ConversationPrivacy;
  existingSessionPiMessages?: PiMessage[];
  existingTurnStartMessageIndex?: number;
  explicitSkill: Skill | null;
  priorPiMessages?: PiMessage[];
  resumedFromSessionRecord: boolean;
  run: Pick<
    AgentRun,
    "source" | "destination" | "dispatch" | "slackConversation"
  >;
  spanContext: LogContext;
  turnId: string;
  toolGuidance: Array<{
    name: string;
    promptGuidelines: AnyToolDefinition["promptGuidelines"];
    promptSnippet: AnyToolDefinition["promptSnippet"];
  }>;
  toolRuntimeContext: ToolRuntimeContext;
  userContentParts: UserContentPart[];
}): Promise<PromptAssembly> {
  const source = args.run.source;
  const hasPromptCheckpoint =
    args.resumedFromSessionRecord &&
    args.existingTurnStartMessageIndex !== undefined;
  const shouldPromptAgent =
    !args.resumedFromSessionRecord || !hasPromptCheckpoint;
  const requestContentParts = args.userContentParts;
  // Every re-prompt shape must trim a trailing checkpointed copy of the same
  // user prompt, including redelivery of the same inbound message after a
  // lost input commit against a still-`running` record; otherwise the prompt
  // appears twice in Pi history.
  const trimmedPrompt = shouldPromptAgent
    ? withoutTrailingUncheckpointedUserPrompt(
        args.priorPiMessages,
        requestContentParts,
      )
    : { messages: args.existingSessionPiMessages! };
  const promptHistoryMessages = trimmedPrompt.messages;
  const replayedPrompt =
    shouldPromptAgent && !args.resumedFromSessionRecord
      ? checkpointedPrompt({
          messages: args.existingSessionPiMessages,
          turnStartMessageIndex: args.existingTurnStartMessageIndex,
          userContentParts: requestContentParts,
        })
      : undefined;
  const needsBootstrapContextForPrompt =
    shouldPromptAgent &&
    !replayedPrompt &&
    !hasRuntimeTurnContext(promptHistoryMessages);
  const systemPromptContributions =
    await getPluginSystemPromptContributions(source);
  const pluginSystemPrompt = buildPluginSystemPromptContributions(
    systemPromptContributions,
  );
  const baseInstructions = [buildSystemPrompt({ source }), pluginSystemPrompt]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
  const pluginUserPromptContributions =
    !shouldPromptAgent || replayedPrompt
      ? []
      : await getPluginUserPromptContributions({
          context: args.toolRuntimeContext,
          turnId: args.turnId,
        });
  const turnContextPrompt =
    needsBootstrapContextForPrompt || pluginUserPromptContributions.length > 0
      ? buildTurnContextPrompt({
          availableSkills: args.availableSkills,
          activeMcpCatalogs: args.activeMcpCatalogs,
          includeSessionContext: needsBootstrapContextForPrompt,
          pluginPromptContributions: pluginUserPromptContributions,
          toolGuidance: args.toolGuidance,
          runtime: {
            conversationId: args.spanContext.conversationId,
            slackConversation: args.run.slackConversation,
          },
          dispatch: args.run.dispatch
            ? {
                ...args.run.dispatch,
                destination: args.run.destination,
                source,
              }
            : undefined,
          actor: isUserActor(args.currentActor) ? args.currentActor : undefined,
          configuration: args.configurationValues,
        })
      : null;
  const turnContextParts: UserContentPart[] = turnContextPrompt
    ? [{ type: "text", text: turnContextPrompt }]
    : [];
  const contextContentParts = replayedPrompt?.contextContentParts ?? [
    ...turnContextParts,
    ...(args.explicitSkill
      ? [
          {
            type: "text" as const,
            text: renderExplicitSkillInstructions(args.explicitSkill),
          },
        ]
      : []),
    ...args.contextContentParts,
  ];
  const userContentParts =
    replayedPrompt?.userContentParts ?? requestContentParts;

  const inputMessages = [
    {
      role: "system",
      content: [{ type: "text", text: baseInstructions }],
    },
    ...(contextContentParts.length > 0
      ? [
          {
            role: "user",
            content: contextContentParts.map((part) =>
              toObservablePromptPart(part),
            ),
          },
        ]
      : []),
    {
      role: "user",
      content: userContentParts.map((part) => toObservablePromptPart(part)),
    },
  ];
  const inputMessagesAttribute = serializeGenAiAttribute(
    args.conversationPrivacy === "public"
      ? [
          {
            role: "system",
            parts: [{ type: "text", content: baseInstructions }],
          },
          ...(contextContentParts.length > 0
            ? [
                {
                  role: "user",
                  parts: contextContentParts.flatMap((part) =>
                    part.type === "text"
                      ? [{ type: "text", content: part.text }]
                      : [],
                  ),
                },
              ]
            : []),
          {
            role: "user",
            parts: userContentParts.flatMap((part) =>
              part.type === "text"
                ? [{ type: "text", content: part.text }]
                : [],
            ),
          },
        ]
      : undefined,
  );

  return {
    baseInstructions,
    contextContentParts,
    inputMessages,
    inputMessagesAttribute,
    ...(trimmedPrompt.promptTimestamp !== undefined
      ? { promptTimestamp: trimmedPrompt.promptTimestamp }
      : {}),
    promptHistoryMessages,
    shouldPromptAgent,
    turnContexts: pluginUserPromptContributions.flatMap((contribution) =>
      contribution.context ? [contribution.context] : [],
    ),
    userContentParts,
  };
}
