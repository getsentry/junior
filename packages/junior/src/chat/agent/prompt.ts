/**
 * Per-run prompt assembly.
 *
 * Builds the user-turn content parts (text, attachments, omitted-image
 * notices) and the full prompt for one run slice: system instructions, plugin
 * contributions, bootstrap turn context, resume-safe history trimming, and
 * the optional canonical telemetry view of public input messages.
 */
import { isDeepStrictEqual } from "node:util";
import {
  renderSystemMessageUpdate,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import type { Platform } from "@sentry/junior-plugin-api";
import type { PromptMode, TurnInputSender } from "@/chat/system-prompt-rules";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import {
  buildCapabilitySections,
  buildTurnContextPrompt,
  type DisabledToolPromptContext,
} from "@/chat/prompt";
import { getPluginUserPromptContributions } from "@/chat/plugins/agent-hooks";
import { buildDeploymentSystemPrompt } from "@/chat/system-prompt";
import { loadTurnConversationNotes } from "@/chat/conversations/notes";
import { getDb, getSqlExecutor } from "@/chat/db";
import { isExperimentalFeatureEnabled } from "@/chat/experimental";
import { latestSeenPlanVersion, renderPlanDelta } from "@/chat/plan/prompt";
import { listPlanItems } from "@/chat/plan/store";
import type { PlanItem } from "@/chat/plan/types";
import { readUserCustomization } from "@/chat/identities/customization";
import type { PiMessage } from "@/chat/pi/messages";
import { systemSectionsUpdate } from "@/chat/pi/agent-history";
import {
  renderAgentsInstructionsForPrompt,
  type RepositoryInstructions,
} from "@/chat/repository-instructions";
import {
  hasRuntimeTurnContext,
  retainRuntimeTurnContext,
  stripRuntimeTurnContext,
} from "@/chat/pi/transcript";
import { serializeGenAiAttribute, type LogContext } from "@/chat/logging";
import {
  toCanonicalInputMessage,
  type ConversationPrivacy,
} from "@/chat/conversation-privacy";
import type { SkillMetadata } from "@/chat/skills";
import type { ActiveMcpCatalogSummary } from "@/chat/tool-support/skill/mcp-tool-summary";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import { isUserActor, type Actor } from "@/chat/actor";
import { findActorTimezone } from "@/chat/identities/timezone";
import type { PluginTurnContext } from "@/chat/plugins/prompt";
import { listWorkspaces } from "@/chat/workspaces/store";
import type { Workspace } from "@/chat/workspaces/types";
import { isVisionImageMediaType } from "@/chat/attachments/media";
import type {
  AgentAttachment,
  AgentInstruction,
  AgentInstructionActor,
  AgentInstructionInput,
  AgentRun,
  AgentSteeringMessage,
} from "@/chat/agent/types";

export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** User-turn content parts plus the thread context sent beside them. */
export interface PromptInput {
  contextContentParts: UserContentPart[];
  userContentParts: UserContentPart[];
}

/** Fully assembled prompt state for one run slice. */
export interface PromptAssembly {
  baseInstructions: string;
  /** Platform that `baseInstructions` was built for. */
  platform: Platform;
  contextContentParts: UserContentPart[];
  inputMessages: Array<{
    role: string;
    content: Record<string, unknown>[];
  }>;
  inputMessagesAttribute: string | undefined;
  promptTimestamp?: number;
  promptHistoryMessages: PiMessage[];
  /**
   * A system message with the capability sections that changed since the
   * history, for a new prompt. It goes before the Turn's context message.
   */
  sectionsMessage?: SystemMessage;
  shouldPromptAgent: boolean;
  turnContexts: PluginTurnContext[];
  userContentParts: UserContentPart[];
}

/** Context that plugin prompt hooks and the user customization read. */
export type PromptHookContext = Parameters<
  typeof getPluginUserPromptContributions
>[0]["context"];

/** Per-Turn prompt context that `assemblePrompt` adds to a new prompt. */
export interface PromptTurnContext {
  conversationNotes?: Awaited<ReturnType<typeof loadTurnConversationNotes>>;
  pluginUserPromptContributions: Awaited<
    ReturnType<typeof getPluginUserPromptContributions>
  >;
  /** Every item of the Conversation's plan, for the `<plan-delta>`. */
  planItems?: PlanItem[];
  userCustomization?: string | undefined;
  workspaces?: Workspace[];
  /** IANA timezone of the person who asked, from `findActorTimezone`. */
  askerTimezone?: string | undefined;
}

interface PromptReplayArgs {
  existingSessionPiMessages?: PiMessage[] | undefined;
  existingTurnStartMessageIndex?: number | undefined;
  resumedFromSessionRecord: boolean;
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
    /^<(?:thread-context|thread-transcript|thread-background|recent-thread-messages)(?:\s|>)/.test(
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

/**
 * Return the author of a person's instruction, or undefined for a system
 * actor. Every Turn path that renders `<current-instruction>` sets it, so the
 * model knows who asks now even when the speaker changed after the first
 * Turn, whose `<actor>` block is not sent again.
 */
export function instructionActorFor(
  actor: Actor,
  slackTs?: string,
): AgentInstructionActor | undefined {
  if (!isUserActor(actor)) return undefined;
  const authorName = actor.fullName ?? actor.userName;
  return {
    authorId: actor.userId,
    ...(authorName ? { authorName } : undefined),
    ...(slackTs ? { slackTs } : undefined),
  };
}

/**
 * Build the instruction for Turn inputs. Each input keeps its own prompt
 * content part, and `text` joins them for action review.
 */
export function instructionForInputs(
  inputs: readonly AgentInstructionInput[],
): Pick<AgentInstruction, "inputs" | "text"> {
  return {
    inputs,
    text: inputs
      .map((input) => input.text.trim())
      .filter(Boolean)
      .join("\n\n"),
  };
}

// Render one prompt text part per input, in order. Inputs are never joined.
// A batch has one Actor, so every person part has the same attributes.
function renderInputParts(instruction: AgentInstruction): string[] {
  const inputs = instruction.inputs ?? [
    { kind: "person" as const, text: instruction.text },
  ];
  return inputs.map((input) =>
    input.kind === "person"
      ? buildUserTurnText(input.text, instruction.actor)
      : input.text.trim(),
  );
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

function buildUserTurnInput(args: {
  inputParts: readonly string[];
  omittedImageAttachmentCount: number;
  userAttachments?: AgentAttachment[] | undefined;
}): PromptInput {
  const userContentParts: UserContentPart[] = args.inputParts.map((text) => ({
    type: "text",
    text,
  }));

  if (args.omittedImageAttachmentCount > 0) {
    const omittedImagesNotice = buildOmittedImageAttachmentNotice(
      args.omittedImageAttachmentCount,
    );
    userContentParts.push({ type: "text", text: omittedImagesNotice });
  }

  for (const attachment of args.userAttachments ?? []) {
    if (attachment.promptText) {
      userContentParts.push({
        type: "text",
        text: attachment.promptText,
      });
      continue;
    }

    if (attachment.attachmentId) {
      userContentParts.push({
        type: "text",
        text: `Stored attachment: ${JSON.stringify({ attachment_id: attachment.attachmentId, filename: attachment.filename, media_type: attachment.mediaType })}. Use loadAttachment to access the original file.`,
      });
    }

    if (isVisionImageMediaType(attachment.mediaType)) {
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

    // Producers give every non-image file a loadAttachment pointer.
    throw new Error("Non-image attachment is missing its prompt text");
  }

  return { contextContentParts: [], userContentParts };
}

/** Build the prompt-facing user input. */
export function buildPromptInput(args: {
  instruction: AgentInstruction;
}): PromptInput {
  const { instruction } = args;
  const promptInput = buildUserTurnInput({
    omittedImageAttachmentCount: instruction.omittedImageAttachmentCount ?? 0,
    userAttachments: instruction.attachments
      ? [...instruction.attachments]
      : undefined,
    inputParts: renderInputParts(instruction),
  });
  const trimmedContext = instruction.context?.trim();
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
    inputParts: [
      message.kind === "runtime"
        ? message.text.trim()
        : buildUserTurnText(message.text, message.actor),
    ],
    userAttachments: message.attachments ? [...message.attachments] : undefined,
    omittedImageAttachmentCount: message.omittedImageAttachmentCount ?? 0,
  });
  return {
    role: "user",
    content: userContentParts,
    timestamp: message.timestampMs ?? Date.now(),
  };
}

/**
 * Return a stable key for one steering message. Resolved attachments may change
 * when Junior retries a mailbox delivery, so only the message time and text
 * form the key.
 */
function steeringMessageKey(message: PiMessage): string | undefined {
  if (message.role !== "user") {
    return undefined;
  }
  const first = Array.isArray(message.content) ? message.content[0] : undefined;
  const text =
    first && typeof first === "object" && "text" in first
      ? String((first as { text?: unknown }).text ?? "")
      : "";
  return `${message.timestamp}:${text}`;
}

/**
 * Remove steering messages that saved history already holds. A repeated
 * mailbox delivery can contain saved and unsaved messages.
 */
export function withoutSavedSteeringMessages<T>(
  saved: readonly PiMessage[],
  entries: readonly T[],
  toMessage: (entry: T) => PiMessage,
): T[] {
  const savedKeys = new Set(
    saved
      .map(steeringMessageKey)
      .filter((key): key is string => key !== undefined),
  );
  return entries.filter((entry) => {
    const key = steeringMessageKey(toMessage(entry));
    return key === undefined || !savedKeys.has(key);
  });
}

function withoutTrailingUncheckpointedUserPrompt(
  messages: PiMessage[] | undefined,
  userContentParts: UserContentPart[],
): { messages: PiMessage[]; promptTimestamp?: number | undefined } {
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

// Load the saved text of the person who sent this Turn, so each person in a
// shared thread gets only their own customization.
async function loadUserCustomization(
  context: Pick<PromptHookContext, "resolveActorIdentity">,
): Promise<string | undefined> {
  if (!isExperimentalFeatureEnabled("user-customization")) return undefined;
  const user = (await context.resolveActorIdentity?.())?.user;
  return user ? await readUserCustomization(user.id) : undefined;
}

// Turn context is not part of the prompt identity that replay compares, so a
// lookup that fails on one slice does not duplicate the instruction.
async function loadAskerTimezone(
  actor: Actor | undefined,
  context: Pick<PromptHookContext, "resolveActorIdentity">,
): Promise<string | undefined> {
  return await findActorTimezone({
    actor,
    db: getDb(),
    nowMs: Date.now(),
    resolveUserId: async () =>
      (await context.resolveActorIdentity?.())?.user?.id,
  });
}

// Record the customization with the Turn input, so the dashboard can show it
// beside plugin context such as recalled memories.
function userCustomizationTurnContext(text: string): PluginTurnContext {
  return {
    pluginName: "junior",
    kind: "user_customization",
    version: 1,
    content: { text },
    loadedAtMs: Date.now(),
  };
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

// A resumed slice continues its checkpointed prompt. A redelivered prompt
// reuses its checkpointed copy. Only a new prompt gets new Turn context.
function planPromptReplay(args: PromptReplayArgs) {
  const hasPromptCheckpoint =
    args.resumedFromSessionRecord &&
    args.existingTurnStartMessageIndex !== undefined;
  const shouldPromptAgent =
    !args.resumedFromSessionRecord || !hasPromptCheckpoint;
  const replayedPrompt =
    shouldPromptAgent && !args.resumedFromSessionRecord
      ? checkpointedPrompt({
          messages: args.existingSessionPiMessages,
          turnStartMessageIndex: args.existingTurnStartMessageIndex,
          userContentParts: args.userContentParts,
        })
      : undefined;
  return {
    loadsTurnContext: shouldPromptAgent && !replayedPrompt,
    replayedPrompt,
    shouldPromptAgent,
  };
}

/**
 * Load the Turn context for a new prompt: plugin prompt hooks, such as
 * memory recall, Conversation notes, and the user customization.
 *
 * It needs no tool wiring, so the caller can run it while sandbox setup
 * runs.
 */
export async function loadPromptTurnContext(
  args: PromptReplayArgs & {
    context: PromptHookContext;
    currentActor?: Actor | undefined;
    turnId: string;
  },
): Promise<PromptTurnContext> {
  if (!planPromptReplay(args).loadsTurnContext) {
    return { pluginUserPromptContributions: [] };
  }
  const [
    pluginUserPromptContributions,
    conversationNotes,
    userCustomization,
    workspaces,
    planItems,
    askerTimezone,
  ] = await Promise.all([
    getPluginUserPromptContributions({
      context: args.context,
      turnId: args.turnId,
    }),
    loadTurnConversationNotes({
      conversationId: args.context.conversationId,
      turnId: args.turnId,
    }),
    isUserActor(args.currentActor)
      ? loadUserCustomization(args.context)
      : undefined,
    listWorkspaces(getDb()),
    listPlanItems(getSqlExecutor(), args.context.conversationId),
    loadAskerTimezone(args.currentActor, args.context),
  ]);
  return {
    askerTimezone,
    conversationNotes,
    planItems,
    pluginUserPromptContributions,
    userCustomization,
    workspaces,
  };
}

/** Choose the platform whose system prompt a Turn gets. */
export function promptPlatform(
  run: Pick<AgentRun, "delivery" | "location">,
  promptMode: PromptMode,
): Platform {
  // A child agent's final text goes to its parent, not to Slack. So every
  // child Turn is local, also on a path that has a Delivery, and its system
  // prompt stays the same on every path.
  if (promptMode === "child_agent") return "local";
  // Every Turn of a Thread or an Automation Conversation has one system
  // prompt, so its Location picks the platform. A person's Turn in a
  // Slack-located one keeps the Slack rules that it had. The other Turns have
  // no Delivery: an agent's Turn on its Agent invocation, and an Automation
  // run, whose `reply` text still goes to Slack. They get the same prompt.
  if (promptMode === "thread" || promptMode === "automation") {
    return run.location?.provider === "slack" ? "slack" : "local";
  }
  return run.delivery && run.location?.provider === "slack" ? "slack" : "local";
}

/** Assemble prompt history, instructions, and telemetry input for one slice. */
export async function assemblePrompt(args: {
  activeMcpCatalogs: ActiveMcpCatalogSummary[];
  currentActor?: Actor | undefined;
  availableSkills: SkillMetadata[];
  configurationValues: Record<string, unknown>;
  contextContentParts: UserContentPart[];
  conversationPrivacy?: ConversationPrivacy | undefined;
  existingSessionPiMessages?: PiMessage[] | undefined;
  existingTurnStartMessageIndex?: number | undefined;
  /** Skills that the person or the Automation named; the model loads them. */
  invokedSkillNames: readonly string[];
  priorPiMessages?: PiMessage[] | undefined;
  /** From `turnBehavior`. */
  promptMode: PromptMode;
  /** From `turnBehavior`. */
  sender?: TurnInputSender | undefined;
  /** AGENTS.md read from the sandbox when this slice started. */
  repositoryInstructions?: RepositoryInstructions | undefined;
  resumedFromSessionRecord: boolean;
  run: Pick<
    AgentRun,
    | "source"
    | "destination"
    | "dispatch"
    | "slackConversation"
    | "location"
    | "delivery"
  >;
  spanContext: LogContext;
  disabledTools: DisabledToolPromptContext[];
  /** The tools that a Code Mode script can call, from `renderScriptTools`. */
  scriptTools: string;
  toolGuidance: Array<{
    name: string;
    promptGuidelines: AnyToolDefinition["promptGuidelines"];
    promptSnippet: AnyToolDefinition["promptSnippet"];
  }>;
  /** Result of `loadPromptTurnContext` for the same prompt arguments. */
  turnContext: PromptTurnContext;
  userContentParts: UserContentPart[];
}): Promise<PromptAssembly> {
  const source = args.run.source;
  const { loadsTurnContext, replayedPrompt, shouldPromptAgent } =
    planPromptReplay(args);
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
  const needsBootstrapContextForPrompt =
    shouldPromptAgent &&
    !replayedPrompt &&
    !hasRuntimeTurnContext(promptHistoryMessages);
  const platform = promptPlatform(args.run, args.promptMode);
  const baseInstructions = await buildDeploymentSystemPrompt(
    platform,
    args.promptMode,
  );
  // A replayed or checkpointed prompt already holds the context of this Turn,
  // so `loadPromptTurnContext` returns nothing for it.
  const {
    askerTimezone,
    conversationNotes,
    planItems,
    pluginUserPromptContributions,
    userCustomization,
    workspaces,
  } = args.turnContext;
  const disabledTools = loadsTurnContext ? args.disabledTools : [];
  // Before the first assistant message, the request folds it into the
  // system prompt. Later, Pi sends it right before the next assistant
  // message, after this prompt. A resumed slice already holds it.
  const sectionsMessage = loadsTurnContext
    ? systemSectionsUpdate(
        promptHistoryMessages,
        buildCapabilitySections({
          availableSkills: args.availableSkills,
          activeMcpCatalogs: args.activeMcpCatalogs,
          scriptTools: args.scriptTools,
          toolGuidance: args.toolGuidance,
          workspaces: workspaces ?? [],
        }),
        trimmedPrompt.promptTimestamp ?? Date.now(),
      )
    : undefined;
  // It returns nothing when no section has news for this Turn.
  const turnContextPrompt = loadsTurnContext
    ? buildTurnContextPrompt({
        askerTimezone,
        conversationNotes,
        disabledTools,
        includeSessionContext: needsBootstrapContextForPrompt,
        invokedSkillNames: args.invokedSkillNames,
        // Only changes that others made after the plan version that history
        // shows. The model's own changes are in its tool results.
        planDelta: planItems
          ? renderPlanDelta(
              planItems,
              latestSeenPlanVersion(promptHistoryMessages),
            )
          : null,
        pluginPromptContributions: pluginUserPromptContributions,
        ...(args.sender ? { turnInput: args.sender } : undefined),
        userCustomization,
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
  const agentsInstructions = args.repositoryInstructions
    ? renderAgentsInstructionsForPrompt(
        promptHistoryMessages,
        args.repositoryInstructions,
      )
    : undefined;
  const contextContentParts = replayedPrompt?.contextContentParts ?? [
    ...turnContextParts,
    ...(agentsInstructions
      ? [{ type: "text" as const, text: agentsInstructions }]
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
    ...(sectionsMessage
      ? [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: renderSystemMessageUpdate(sectionsMessage),
              },
            ],
          },
        ]
      : []),
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
          ...(sectionsMessage
            ? [toCanonicalInputMessage(sectionsMessage)]
            : []),
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
    platform,
    ...(trimmedPrompt.promptTimestamp !== undefined
      ? { promptTimestamp: trimmedPrompt.promptTimestamp }
      : undefined),
    promptHistoryMessages,
    ...(sectionsMessage ? { sectionsMessage } : undefined),
    shouldPromptAgent,
    turnContexts: [
      ...(userCustomization
        ? [userCustomizationTurnContext(userCustomization)]
        : []),
      ...pluginUserPromptContributions.flatMap((contribution) =>
        contribution.context ? [contribution.context] : [],
      ),
    ],
    userContentParts,
  };
}
