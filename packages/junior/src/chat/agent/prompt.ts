/**
 * Per-run prompt assembly.
 *
 * Builds the user-turn content parts (text, attachments, omitted-image
 * notices) and the full prompt for one run slice: system instructions, plugin
 * contributions, bootstrap turn context, resume-safe history trimming, and
 * the redacted telemetry view of the input messages.
 */
import { renderCurrentInstruction } from "@/chat/current-instruction";
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
  stripRuntimeTurnContext,
} from "@/chat/pi/transcript";
import { serializeGenAiAttribute, type LogContext } from "@/chat/logging";
import {
  toGenAiMessageMetadata,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { SkillInvocation, SkillMetadata } from "@/chat/skills";
import type { ActiveMcpCatalogSummary } from "@/chat/tool-support/skill/mcp-tool-summary";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import type { Requester } from "@/chat/requester";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type {
  AgentRunInput,
  AgentRunInstructionActor,
  AgentRunRouting,
  AgentRunSteeringMessage,
} from "@/chat/agent/request";

const MAX_INLINE_ATTACHMENT_BASE64_CHARS = 120_000;
const MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS = 2_000;

export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type UserTurnAttachment = NonNullable<AgentRunInput["userAttachments"]>[number];

/** User-turn content parts plus the plain-text blocks used for routing decisions. */
export interface PromptInput {
  routerBlocks: string[];
  userContentParts: UserContentPart[];
}

/** Fully assembled prompt state for one run slice. */
export interface PromptAssembly {
  baseInstructions: string;
  inputMessages: Array<{
    role: string;
    content: Record<string, unknown>[];
  }>;
  inputMessagesAttribute: string | undefined;
  promptContentParts: UserContentPart[];
  promptHistoryMessages: PiMessage[];
  shouldPromptAgent: boolean;
}

function isStructuredThreadContext(context: string): boolean {
  return /^<(recent-thread-messages|thread-(compactions|transcript))>/.test(
    context,
  );
}

function renderThreadContextForPrompt(context: string): string {
  if (isStructuredThreadContext(context)) {
    return context;
  }
  return ["<thread-background>", context, "</thread-background>"].join("\n");
}

/**
 * Keep thread text separate from the canonical active task boundary.
 */
export function buildUserTurnText(
  userInput: string,
  conversationContext?: string,
  actor?: AgentRunInstructionActor,
): string {
  const trimmedContext = conversationContext?.trim();
  const currentInstruction = renderCurrentInstruction(userInput, actor);

  if (!trimmedContext) {
    return currentInstruction;
  }

  return [
    renderThreadContextForPrompt(trimmedContext),
    "",
    currentInstruction,
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
  userAttachments?: AgentRunInput["userAttachments"];
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

  return { routerBlocks, userContentParts };
}

/** Build the prompt-facing user input, keeping router text aligned with Pi content. */
export function buildPromptInput(input: AgentRunInput): PromptInput {
  const promptConversationContext =
    input.piMessages &&
    input.piMessages.length > 0 &&
    !input.includeConversationContextWithPiMessages
      ? undefined
      : input.conversationContext;
  const userTurnText = buildUserTurnText(
    input.messageText,
    promptConversationContext,
    input.actor,
  );
  return buildUserTurnInput({
    omittedImageAttachmentCount: input.omittedImageAttachmentCount ?? 0,
    userAttachments: input.userAttachments,
    userTurnText,
  });
}

/**
 * Convert a mid-run user message into the Pi user message shape used for
 * steering injection and parked-conversation session-log appends, so both
 * paths store identical durable history.
 */
export function buildSteeringPiMessage(
  message: AgentRunSteeringMessage,
): PiMessage {
  const { userContentParts } = buildUserTurnInput({
    userTurnText: buildUserTurnText(message.text, undefined, message.actor),
    userAttachments: message.userAttachments,
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
): PiMessage[] {
  if (!messages || messages.length === 0) {
    return [];
  }

  const lastMessage = messages.at(-1) as
    | { content?: unknown; role?: unknown }
    | undefined;
  if (lastMessage?.role !== "user") {
    return messages;
  }
  const comparableLastMessage = stripRuntimeTurnContext([
    lastMessage as PiMessage,
  ])[0] as { content?: unknown } | undefined;
  if (
    !userPromptContentMatches(comparableLastMessage?.content, userContentParts)
  ) {
    return messages;
  }
  return messages.slice(0, -1);
}

function userPromptContentMatches(
  storedContent: unknown,
  currentContent: UserContentPart[],
): boolean {
  return JSON.stringify(storedContent) === JSON.stringify(currentContent);
}

/** Assemble prompt history, instructions, and telemetry input for one slice. */
export async function assemblePrompt(args: {
  activeMcpCatalogs: ActiveMcpCatalogSummary[];
  actorRequester?: Requester;
  artifactState?: ThreadArtifactsState;
  availableSkills: SkillMetadata[];
  configurationValues: Record<string, unknown>;
  conversationPrivacy?: ConversationPrivacy;
  existingSessionPiMessages?: PiMessage[];
  existingTurnStartMessageIndex?: number;
  invocation: SkillInvocation | null;
  priorPiMessages?: PiMessage[];
  resumedFromSessionRecord: boolean;
  routing: AgentRunRouting;
  spanContext: LogContext;
  toolGuidance: Array<{
    name: string;
    promptGuidelines: AnyToolDefinition["promptGuidelines"];
    promptSnippet: AnyToolDefinition["promptSnippet"];
  }>;
  toolRuntimeContext: ToolRuntimeContext;
  userContentParts: UserContentPart[];
}): Promise<PromptAssembly> {
  const source = args.routing.source;
  const hasPromptCheckpoint =
    args.resumedFromSessionRecord &&
    args.existingTurnStartMessageIndex !== undefined;
  const shouldPromptAgent =
    !args.resumedFromSessionRecord || !hasPromptCheckpoint;
  // Every re-prompt shape must trim a trailing checkpointed copy of the same
  // user prompt, including redelivery of the same inbound message after a
  // lost input commit against a still-`running` record; otherwise the prompt
  // appears twice in Pi history.
  const promptHistoryMessages = shouldPromptAgent
    ? withoutTrailingUncheckpointedUserPrompt(
        args.priorPiMessages,
        args.userContentParts,
      )
    : args.existingSessionPiMessages!;
  const needsBootstrapContextForPrompt =
    shouldPromptAgent && !hasRuntimeTurnContext(promptHistoryMessages);
  const systemPromptContributions =
    await getPluginSystemPromptContributions(source);
  const pluginSystemPrompt = buildPluginSystemPromptContributions(
    systemPromptContributions,
  );
  const baseInstructions = [buildSystemPrompt({ source }), pluginSystemPrompt]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
  const pluginUserPromptContributions = !shouldPromptAgent
    ? []
    : await getPluginUserPromptContributions({
        context: args.toolRuntimeContext,
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
            slackConversation: args.routing.slackConversation,
          },
          dispatch: args.routing.dispatch
            ? {
                ...args.routing.dispatch,
                destination: args.routing.destination,
                source,
              }
            : undefined,
          invocation: args.invocation,
          requester: args.actorRequester,
          artifactState: args.artifactState,
          configuration: args.configurationValues,
        })
      : null;
  const turnContextParts: UserContentPart[] = turnContextPrompt
    ? [{ type: "text", text: turnContextPrompt }]
    : [];
  const promptContentParts = [...turnContextParts, ...args.userContentParts];

  const inputMessages = [
    {
      role: "system",
      content: [{ type: "text", text: baseInstructions }],
    },
    {
      role: "user",
      content: promptContentParts.map((part) => toObservablePromptPart(part)),
    },
  ];
  const inputMessagesAttribute = serializeGenAiAttribute(
    args.conversationPrivacy !== "public"
      ? inputMessages.map(toGenAiMessageMetadata)
      : inputMessages,
  );

  return {
    baseInstructions,
    inputMessages,
    inputMessagesAttribute,
    promptContentParts,
    promptHistoryMessages,
    shouldPromptAgent,
  };
}
