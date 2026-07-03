import type { Source } from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  extractCurrentInstructionBody,
  renderCurrentInstruction,
} from "@/chat/current-instruction";
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
  toObservablePromptPart,
  buildUserTurnText,
  encodeNonImageAttachmentForPrompt,
} from "@/chat/agent-run-helpers";
import { serializeGenAiAttribute, type LogContext } from "@/chat/logging";
import {
  toGenAiMessageMetadata,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { SkillInvocation, SkillMetadata } from "@/chat/skills";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { ToolDefinition } from "@/chat/tools/definition";
import type { Requester } from "@/chat/requester";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { AgentRunInput, AgentRunRouting } from "@/chat/agent-run/request";

const MAX_ROUTER_ATTACHMENT_PREVIEW_CHARS = 2_000;

export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const legacyStoredTextPartSchema = z
  .object({
    text: z.string(),
    type: z.literal("text"),
  })
  .strict();

type UserRunAttachment = NonNullable<AgentRunInput["userAttachments"]>[number];

export interface PromptInput {
  routerBlocks: string[];
  userContentParts: UserContentPart[];
}

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

function buildRouterAttachmentBlock(attachment: UserRunAttachment): string {
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

function buildUserRunInput(args: {
  omittedImageAttachmentCount: number;
  userAttachments?: AgentRunInput["userAttachments"];
  userRunText: string;
}): PromptInput {
  const routerBlocks: string[] = [];
  const userContentParts: UserContentPart[] = [
    { type: "text", text: args.userRunText },
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

/** Builds the prompt-facing user input while keeping attachment routing text aligned with Pi content. */
export function buildPromptInput(args: {
  input: AgentRunInput;
  userInput: string;
}): PromptInput {
  const promptConversationContext =
    args.input.piMessages && args.input.piMessages.length > 0
      ? undefined
      : args.input.conversationContext;
  const userRunText = buildUserTurnText(
    args.userInput,
    promptConversationContext,
  );
  return buildUserRunInput({
    omittedImageAttachmentCount: args.input.omittedImageAttachmentCount ?? 0,
    userAttachments: args.input.userAttachments,
    userRunText,
  });
}

/**
 * Convert a mid-run user message into the Pi user message shape used for
 * steering injection and parked-conversation session-log appends, so both
 * paths store identical durable history.
 */
export function buildSteeringPiMessage(message: {
  omittedImageAttachmentCount?: number;
  text: string;
  timestampMs?: number;
  userAttachments?: AgentRunInput["userAttachments"];
}): PiMessage {
  const { userContentParts } = buildUserRunInput({
    userRunText: buildUserTurnText(message.text),
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

/** Match stored resume prompts against the current wrapped prompt shape. */
function userPromptContentMatches(
  storedContent: unknown,
  currentContent: UserContentPart[],
): boolean {
  if (JSON.stringify(storedContent) === JSON.stringify(currentContent)) {
    return true;
  }
  if (!Array.isArray(storedContent)) {
    return false;
  }
  if (storedContent.length !== currentContent.length) {
    return false;
  }

  return storedContent.every((storedPart, index) => {
    const currentPart = currentContent[index];
    if (index === 0 && currentPart?.type === "text") {
      const legacyTextPart = legacyStoredTextPartSchema.safeParse(storedPart);
      if (legacyTextPart.success) {
        // TODO(v0.84.0): Remove legacy unwrapped resume prompt matching after
        // pre-current-instruction session records expire.
        return legacyTextPartMatchesCurrentText(
          legacyTextPart.data.text,
          currentPart.text,
        );
      }
    }

    return JSON.stringify(storedPart) === JSON.stringify(currentPart);
  });
}

function legacyTextPartMatchesCurrentText(
  storedText: string,
  currentText: string,
): boolean {
  const storedInstructionBody = extractCurrentInstructionBody(storedText);
  if (storedInstructionBody !== undefined) {
    return renderCurrentInstruction(storedInstructionBody) === currentText;
  }

  return renderCurrentInstruction(storedText) === currentText;
}

/** Assembles prompt history and telemetry input from restored state and wired tools. */
export async function assemblePrompt(args: {
  activeMcpCatalogs: ReturnType<
    typeof import("@/chat/tools/skill/mcp-tool-summary").toActiveMcpCatalogSummaries
  >;
  actorRequester?: Requester;
  artifactState?: ThreadArtifactsState;
  availableSkills: SkillMetadata[];
  configurationValues: Record<string, unknown>;
  conversationPrivacy?: ConversationPrivacy;
  dispatch?: AgentRunRouting["dispatch"];
  existingRunStartMessageIndex?: number;
  existingSessionPiMessages?: PiMessage[];
  invocation: SkillInvocation | null;
  priorPiMessages?: PiMessage[];
  resumedFromSessionRecord: boolean;
  routing: AgentRunRouting;
  source: Source;
  spanContext: LogContext;
  toolGuidance: Array<{
    name: string;
    promptGuidelines: ToolDefinition<any>["promptGuidelines"];
    promptSnippet: ToolDefinition<any>["promptSnippet"];
  }>;
  toolRuntimeContext: ToolRuntimeContext;
  userContentParts: UserContentPart[];
}): Promise<PromptAssembly> {
  const hasPromptCheckpoint =
    args.resumedFromSessionRecord &&
    args.existingRunStartMessageIndex !== undefined;
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
  const systemPromptContributions = await getPluginSystemPromptContributions(
    args.source,
  );
  const pluginSystemPrompt = buildPluginSystemPromptContributions(
    systemPromptContributions,
  );
  const baseInstructions = [
    buildSystemPrompt({ source: args.source }),
    pluginSystemPrompt,
  ]
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
          dispatch: args.dispatch
            ? {
                ...args.dispatch,
                destination: args.routing.destination,
                source: args.source,
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
