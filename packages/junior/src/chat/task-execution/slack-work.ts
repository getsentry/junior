import type { SlackAdapter } from "@chat-adapter/slack";
import {
  Message,
  ThreadImpl,
  type MessageContext,
  type SerializedMessage,
  type SerializedThread,
  type StateAdapter,
} from "chat";
import { z } from "zod";
import type {
  SlackTurnOptions,
  SteeringCandidateMessage,
} from "@/chat/runtime/slack-runtime";
import {
  isCooperativeTurnYieldError,
  isTurnInputDeferredError,
  isTurnInputCommitLostError,
  TurnInputCommitLostError,
} from "@/chat/runtime/turn";
import { normalizeIncomingSlackThreadId } from "@/chat/ingress/message-router";
import { rehydrateAttachmentFetchers } from "@/chat/slack/attachment-fetchers";
import { getStateAdapter } from "@/chat/state/adapter";
import type { ConversationStore } from "@/chat/conversations/store";
import type { AgentInput, InboundMessage } from "@/chat/task-execution/store";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  runWithSlackInstallation,
  type SlackInstallationContext,
} from "@/chat/slack/adapter-context";
import { ensureSlackMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { lookupSlackUser } from "@/chat/slack/user";
import { parseActorUserId, type SlackActorProfile } from "@/chat/actor";
import {
  isResourceEventSlackMessage,
  RESOURCE_EVENT_SLACK_AUTHOR_ID,
} from "@/chat/resource-events/actor";
import {
  createSlackDestination,
  requireSlackDestination,
} from "@/chat/destination";
import {
  deliverReplyTo,
  requireReplyDestination,
} from "@/chat/task-execution/reply-delivery";
import { stripLeadingSteeringOverride } from "@/chat/slack/message-control";
import { botConfig, type CrossActorMidRunMode } from "@/chat/config";

const slackConversationRouteSchema = z.enum(["mention", "subscribed"]);
export type SlackConversationRoute = z.output<
  typeof slackConversationRouteSchema
>;

function hasSteeringOverride(text: string): boolean {
  return stripLeadingSteeringOverride(text) !== text;
}

const serializedDateSchema = z.iso.datetime();
const mdastPointSchema = z
  .object({
    column: z.number().int().positive(),
    line: z.number().int().positive(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();
const mdastPositionSchema = z
  .object({
    end: mdastPointSchema,
    start: mdastPointSchema,
  })
  .strict();

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalNullableBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "boolean";
}

function hasValidMdastBase(
  node: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  const allowed = new Set(["data", "position", "type", ...fields]);
  return (
    Object.keys(node).every((key) => allowed.has(key)) &&
    (node.data === undefined ||
      (typeof node.data === "object" &&
        node.data !== null &&
        !Array.isArray(node.data))) &&
    (node.position === undefined ||
      mdastPositionSchema.safeParse(node.position).success)
  );
}

const mdastPhrasingTypes = new Set([
  "break",
  "delete",
  "emphasis",
  "footnoteReference",
  "html",
  "image",
  "imageReference",
  "inlineCode",
  "link",
  "linkReference",
  "strong",
  "text",
]);
const mdastBlockOrDefinitionTypes = new Set([
  "blockquote",
  "code",
  "definition",
  "footnoteDefinition",
  "heading",
  "html",
  "list",
  "paragraph",
  "table",
  "thematicBreak",
]);
const mdastListItemTypes = new Set(["listItem"]);
const mdastTableCellTypes = new Set(["tableCell"]);
const mdastTableRowTypes = new Set(["tableRow"]);

function hasMdastChildren(
  node: Record<string, unknown>,
  allowedTypes?: ReadonlySet<string>,
): boolean {
  return (
    Array.isArray(node.children) &&
    node.children.every(
      (child) =>
        isFormattedContentNode(child) &&
        (!allowedTypes ||
          (typeof child === "object" &&
            child !== null &&
            !Array.isArray(child) &&
            allowedTypes.has(String((child as { type?: unknown }).type)))),
    )
  );
}

/** Validate every supported mdast node before restoring a serialized message. */
function isFormattedContentNode(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const node = value as Record<string, unknown>;
  switch (node.type) {
    case "break":
    case "thematicBreak":
      return hasValidMdastBase(node, []);
    case "html":
    case "inlineCode":
    case "text":
    case "yaml":
      return (
        hasValidMdastBase(node, ["value"]) && typeof node.value === "string"
      );
    case "code":
      return (
        hasValidMdastBase(node, ["lang", "meta", "value"]) &&
        typeof node.value === "string" &&
        isOptionalNullableString(node.lang) &&
        isOptionalNullableString(node.meta)
      );
    case "delete":
    case "emphasis":
    case "paragraph":
    case "strong":
    case "tableCell":
      return (
        hasValidMdastBase(node, ["children"]) &&
        hasMdastChildren(node, mdastPhrasingTypes)
      );
    case "blockquote":
      return (
        hasValidMdastBase(node, ["children"]) &&
        hasMdastChildren(node, mdastBlockOrDefinitionTypes)
      );
    case "tableRow":
      return (
        hasValidMdastBase(node, ["children"]) &&
        hasMdastChildren(node, mdastTableCellTypes)
      );
    case "heading":
      return (
        hasValidMdastBase(node, ["children", "depth"]) &&
        hasMdastChildren(node, mdastPhrasingTypes) &&
        Number.isInteger(node.depth) &&
        Number(node.depth) >= 1 &&
        Number(node.depth) <= 6
      );
    case "list":
      return (
        hasValidMdastBase(node, ["children", "ordered", "spread", "start"]) &&
        hasMdastChildren(node, mdastListItemTypes) &&
        isOptionalNullableBoolean(node.ordered) &&
        isOptionalNullableBoolean(node.spread) &&
        (node.start === undefined ||
          node.start === null ||
          (typeof node.start === "number" && Number.isFinite(node.start)))
      );
    case "listItem":
      return (
        hasValidMdastBase(node, ["checked", "children", "spread"]) &&
        hasMdastChildren(node, mdastBlockOrDefinitionTypes) &&
        isOptionalNullableBoolean(node.checked) &&
        isOptionalNullableBoolean(node.spread)
      );
    case "table":
      return (
        hasValidMdastBase(node, ["align", "children"]) &&
        hasMdastChildren(node, mdastTableRowTypes) &&
        (node.align === undefined ||
          node.align === null ||
          (Array.isArray(node.align) &&
            node.align.every(
              (align) =>
                align === null ||
                align === "center" ||
                align === "left" ||
                align === "right",
            )))
      );
    case "definition":
      return (
        hasValidMdastBase(node, ["identifier", "label", "title", "url"]) &&
        typeof node.identifier === "string" &&
        typeof node.url === "string" &&
        isOptionalNullableString(node.label) &&
        isOptionalNullableString(node.title)
      );
    case "footnoteDefinition":
      return (
        hasValidMdastBase(node, ["children", "identifier", "label"]) &&
        hasMdastChildren(node, mdastBlockOrDefinitionTypes) &&
        typeof node.identifier === "string" &&
        isOptionalNullableString(node.label)
      );
    case "footnoteReference":
      return (
        hasValidMdastBase(node, ["identifier", "label"]) &&
        typeof node.identifier === "string" &&
        isOptionalNullableString(node.label)
      );
    case "image":
      return (
        hasValidMdastBase(node, ["alt", "title", "url"]) &&
        typeof node.url === "string" &&
        isOptionalNullableString(node.alt) &&
        isOptionalNullableString(node.title)
      );
    case "imageReference":
      return (
        hasValidMdastBase(node, [
          "alt",
          "identifier",
          "label",
          "referenceType",
        ]) &&
        typeof node.identifier === "string" &&
        isOptionalNullableString(node.alt) &&
        isOptionalNullableString(node.label) &&
        (node.referenceType === "collapsed" ||
          node.referenceType === "full" ||
          node.referenceType === "shortcut")
      );
    case "link":
      return (
        hasValidMdastBase(node, ["children", "title", "url"]) &&
        hasMdastChildren(node, mdastPhrasingTypes) &&
        typeof node.url === "string" &&
        isOptionalNullableString(node.title)
      );
    case "linkReference":
      return (
        hasValidMdastBase(node, [
          "children",
          "identifier",
          "label",
          "referenceType",
        ]) &&
        hasMdastChildren(node, mdastPhrasingTypes) &&
        typeof node.identifier === "string" &&
        isOptionalNullableString(node.label) &&
        (node.referenceType === "collapsed" ||
          node.referenceType === "full" ||
          node.referenceType === "shortcut")
      );
    default:
      return false;
  }
}

const formattedContentSchema = z.custom<SerializedMessage["formatted"]>(
  (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const root = value as Record<string, unknown>;
    return (
      root.type === "root" &&
      hasValidMdastBase(root, ["children"]) &&
      hasMdastChildren(root)
    );
  },
  "must be a valid formatted-content root",
);

const serializedMessageSchema = z
  .object({
    _type: z.literal("chat:Message"),
    attachments: z.array(
      z
        .object({
          type: z.enum(["image", "file", "video", "audio"]),
          url: z.string().optional(),
          name: z.string().optional(),
          mimeType: z.string().optional(),
          size: z.number().finite().optional(),
          width: z.number().finite().optional(),
          height: z.number().finite().optional(),
          fetchMetadata: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
    ),
    author: z
      .object({
        userId: z.string(),
        userName: z.string(),
        fullName: z.string(),
        isBot: z.union([z.boolean(), z.literal("unknown")]),
        isMe: z.boolean(),
      })
      .strict(),
    formatted: formattedContentSchema,
    id: z.string().min(1),
    isMention: z.boolean().optional(),
    links: z
      .array(
        z
          .object({
            url: z.string(),
            title: z.string().optional(),
            description: z.string().optional(),
            imageUrl: z.string().optional(),
            siteName: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    metadata: z
      .object({
        dateSent: serializedDateSchema,
        edited: z.boolean(),
        editedAt: serializedDateSchema.optional(),
      })
      .strict(),
    raw: z.unknown(),
    text: z.string(),
    threadId: z.string().min(1),
  })
  .strict() satisfies z.ZodType<SerializedMessage>;

const serializedThreadSchema = z
  .object({
    _type: z.literal("chat:Thread"),
    adapterName: z.literal("slack"),
    channelId: z.string().min(1),
    channelVisibility: z
      .enum(["private", "workspace", "external", "unknown"])
      .optional(),
    currentMessage: serializedMessageSchema.optional(),
    id: z.string().min(1),
    isDM: z.boolean(),
  })
  .strict() satisfies z.ZodType<SerializedThread>;

const slackInstallationSchema = z
  .object({
    enterpriseId: z.string().optional(),
    isEnterpriseInstall: z.boolean().optional(),
    teamId: z.string().optional(),
  })
  .strict() satisfies z.ZodType<SlackInstallationContext>;

const slackConversationMessageMetadataBaseSchema = z.object({
  installation: slackInstallationSchema.optional(),
  message: serializedMessageSchema,
  platform: z.literal("slack"),
  route: slackConversationRouteSchema,
  thread: serializedThreadSchema,
});

const slackConversationMessageMetadataSchema = z.union([
  slackConversationMessageMetadataBaseSchema.strict(),
  slackConversationMessageMetadataBaseSchema
    .extend({
      kind: z.literal("resource_event"),
      resourceEvent: z
        .object({
          eventKey: z.string(),
          eventType: z.string(),
          namespace: z.string(),
          identifier: z.string(),
          subscriptionId: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

export type SlackConversationMessageMetadata = z.output<
  typeof slackConversationMessageMetadataSchema
>;

type SlackInboxTurnOptions = SlackTurnOptions & {
  ack: () => Promise<void>;
  isFinalAttempt: boolean;
};

interface SlackInboxTurnRuntime {
  handleNewMention(
    thread: ThreadImpl,
    message: Message,
    hooks: SlackInboxTurnOptions,
  ): Promise<void>;
  handleSubscribedMessage(
    thread: ThreadImpl,
    message: Message,
    hooks: SlackInboxTurnOptions,
  ): Promise<void>;
}

interface SlackResourceEventInboundInput {
  event: {
    eventKey: string;
    eventType: string;
    occurredAtMs: number;
    namespace: string;
    identifier: string;
  };
  subscription: {
    conversationId: string;
    destination: {
      channelId: string;
      platform: "slack";
      teamId: string;
    };
    id: string;
  };
  text: string;
}

export interface CreateSlackConversationWorkerOptions {
  crossActorMidRunMode?: CrossActorMidRunMode;
  getSlackAdapter: () => SlackAdapter;
  lookupSlackUser?: (
    teamId: string,
    userId: string,
  ) => Promise<SlackActorProfile | null | undefined>;
  resumeAwaitingContinuation: (
    conversationId: string,
    options: { shouldYield: () => boolean },
  ) => Promise<boolean>;
  conversationStore?: ConversationStore;
  runtime: SlackInboxTurnRuntime;
  state?: StateAdapter;
}

function requireSlackAuthorId(message: Message): string {
  const authorId = parseActorUserId(message.author.userId);
  if (!authorId) {
    throw new Error("Slack message requires an actor user id");
  }
  return authorId;
}

function parseSlackConversationId(
  conversationId: string,
): { channelId: string; threadTs: string } | undefined {
  const parts = conversationId.split(":");
  if (parts.length !== 3 || parts[0] !== "slack" || !parts[1] || !parts[2]) {
    return undefined;
  }
  return { channelId: parts[1], threadTs: parts[2] };
}

function slackSerializedThread(input: {
  channelId: string;
  message: SerializedMessage;
  threadTs: string;
}): z.output<typeof serializedThreadSchema> {
  return {
    _type: "chat:Thread",
    adapterName: "slack",
    channelId: input.channelId,
    currentMessage: input.message,
    id: `slack:${input.channelId}:${input.threadTs}`,
    isDM: input.channelId.startsWith("D"),
  };
}

/**
 * Serialize a synthetic resource-event mailbox message without a native Slack
 * message timestamp so Slack Web API calls cannot target the internal id.
 */
function slackSerializedResourceEventMessage(input: {
  channelId: string;
  eventType: string;
  id: string;
  text: string;
  threadTs: string;
  timestampIso: string;
}): SerializedMessage {
  return {
    _type: "chat:Message",
    attachments: [],
    author: {
      userId: RESOURCE_EVENT_SLACK_AUTHOR_ID,
      userName: "junior-event",
      fullName: "Junior event",
      isBot: true,
      isMe: false,
    },
    formatted: { type: "root", children: [] },
    id: input.id,
    metadata: {
      dateSent: input.timestampIso,
      edited: false,
    },
    raw: {
      channel: input.channelId,
      event_type: "resource_event",
      resource_event_type: input.eventType,
      thread_ts: input.threadTs,
      type: "message",
      user: RESOURCE_EVENT_SLACK_AUTHOR_ID,
    },
    text: input.text,
    threadId: `slack:${input.channelId}:${input.threadTs}`,
  };
}

/** Create a Slack mailbox record for a subscribed resource-event notification. */
export function createSlackResourceEventInboundMessage(
  input: SlackResourceEventInboundInput,
): InboundMessage {
  const slack = parseSlackConversationId(input.subscription.conversationId);
  if (!slack) {
    throw new Error(
      "Resource event delivery currently requires a Slack conversation",
    );
  }
  const destination = input.subscription.destination;
  if (destination.channelId !== slack.channelId) {
    throw new Error(
      "Resource event subscription destination does not match Slack conversation",
    );
  }
  const messageId = `resource-event-${input.subscription.id}-${input.event.eventKey}`;
  const timestampIso = new Date(input.event.occurredAtMs).toISOString();
  const message = slackSerializedResourceEventMessage({
    channelId: slack.channelId,
    eventType: input.event.eventType,
    id: messageId,
    text: input.text,
    threadTs: slack.threadTs,
    timestampIso,
  });
  const thread = slackSerializedThread({
    channelId: slack.channelId,
    message,
    threadTs: slack.threadTs,
  });
  return {
    conversationId: input.subscription.conversationId,
    createdAtMs: input.event.occurredAtMs,
    destination,
    inboundMessageId: `resource-event:${input.subscription.id}:${input.event.eventKey}`,
    delivery: "defer",
    replyDelivery: deliverReplyTo(destination),
    source: "resource_event",
    receivedAtMs: Date.now(),
    input: {
      text: input.text,
      authorId: RESOURCE_EVENT_SLACK_AUTHOR_ID,
      metadata: {
        kind: "resource_event",
        installation: {
          teamId: destination.teamId,
        },
        platform: "slack",
        route: "subscribed",
        thread,
        message,
        resourceEvent: {
          eventKey: input.event.eventKey,
          eventType: input.event.eventType,
          namespace: input.event.namespace,
          identifier: input.event.identifier,
          subscriptionId: input.subscription.id,
        },
      } satisfies SlackConversationMessageMetadata,
    },
  };
}

function getConnectedState(stateAdapter?: StateAdapter): StateAdapter {
  return stateAdapter ?? getStateAdapter();
}

/** Parse the serialized Slack message/thread envelope stored in the mailbox. */
function parseSlackMetadata(
  value: AgentInput["metadata"],
): SlackConversationMessageMetadata | undefined {
  const parsed = slackConversationMessageMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function compareInboundMessages(
  left: InboundMessage,
  right: InboundMessage,
): number {
  return (
    left.createdAtMs - right.createdAtMs ||
    left.receivedAtMs - right.receivedAtMs ||
    left.inboundMessageId.localeCompare(right.inboundMessageId)
  );
}

function routeForRecords(records: InboundMessage[]): SlackConversationRoute {
  return records.some((record) => {
    const metadata = parseSlackMetadata(record.input.metadata);
    if (!metadata) {
      throw new Error("Conversation mailbox record is not Slack metadata");
    }
    return metadata.route === "mention";
  })
    ? "mention"
    : "subscribed";
}

/** Rehydrate the Slack message payload before handing it back to runtime code. */
function restoreMessage(args: {
  adapter: SlackAdapter;
  record: InboundMessage;
}): Message {
  const metadata = parseSlackMetadata(args.record.input.metadata);
  if (!metadata) {
    throw new Error("Conversation mailbox record is not a Slack message");
  }

  const message = Message.fromJSON(metadata.message);
  message.attachments = message.attachments.map((attachment) =>
    args.adapter.rehydrateAttachment(attachment),
  );
  rehydrateAttachmentFetchers(message);
  return message;
}

async function bindSlackActorIdentities(args: {
  lookupSlackUser: (
    teamId: string,
    userId: string,
  ) => Promise<SlackActorProfile | null | undefined>;
  messages: Message[];
  teamId: string;
}): Promise<void> {
  const byAuthorId = new Map<string, Message[]>();
  for (const message of args.messages) {
    if (isResourceEventSlackMessage(message)) {
      continue;
    }
    const authorId = requireSlackAuthorId(message);
    byAuthorId.set(authorId, [...(byAuthorId.get(authorId) ?? []), message]);
  }

  await Promise.all(
    [...byAuthorId].map(async ([authorId, messages]) => {
      const profile = await args.lookupSlackUser(args.teamId, authorId);
      await Promise.all(
        messages.map((message) =>
          ensureSlackMessageActorIdentity(
            message,
            args.teamId,
            async () => profile,
          ),
        ),
      );
    }),
  );
}

function restoreThread(args: {
  adapter: SlackAdapter;
  isSubscribedContext: boolean;
  message: Message;
  state: StateAdapter;
  threadJson: SerializedThread;
}): ThreadImpl {
  const threadId = normalizeIncomingSlackThreadId(
    args.threadJson.id,
    args.message,
  );
  if (args.message.threadId !== threadId) {
    (args.message as unknown as { threadId: string }).threadId = threadId;
  }
  return new ThreadImpl({
    adapter: args.adapter,
    stateAdapter: args.state,
    id: threadId,
    channelId: args.threadJson.channelId,
    channelVisibility: args.threadJson.channelVisibility,
    currentMessage: args.message,
    initialMessage: args.message,
    isDM: args.threadJson.isDM,
    isSubscribedContext: args.isSubscribedContext,
  });
}

function getInstallation(records: InboundMessage[]): SlackInstallationContext {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const metadata = parseSlackMetadata(records[index]?.input.metadata);
    if (metadata?.installation) {
      return metadata.installation;
    }
  }
  return {};
}

function getPendingRecords(
  work: { execution: { pendingMessages: InboundMessage[] } } | undefined,
): InboundMessage[] {
  if (!work) {
    return [];
  }
  return work.execution.pendingMessages.sort(compareInboundMessages);
}

/** Build the worker run function for queued Slack conversation work. */
export function createSlackConversationWorker(
  options: CreateSlackConversationWorkerOptions,
): (context: ConversationWorkerContext) => Promise<ConversationWorkerResult> {
  const crossActorMidRunMode =
    options.crossActorMidRunMode ?? botConfig.crossActorMidRunMode;
  return async (context) => {
    const adapter = options.getSlackAdapter();
    const actorLookup = options.lookupSlackUser ?? lookupSlackUser;
    const state = getConnectedState(options.state);
    await state.connect();

    const records = getPendingRecords({
      execution: { pendingMessages: [...context.attempt.messages] },
    });
    if (records.length === 0) {
      const destination = requireSlackDestination(
        requireReplyDestination(
          context.replyDelivery,
          "Slack continuation recovery",
        ),
        "Slack continuation recovery",
      );
      await runWithSlackInstallation({
        adapter,
        installation: { teamId: destination.teamId },
        state,
        task: async () => {
          await options.resumeAwaitingContinuation(context.conversationId, {
            shouldYield: context.shouldYield,
          });
        },
      });
      return { status: "completed" };
    }

    const latestRecord = records[records.length - 1];
    if (!latestRecord) {
      return { status: "completed" };
    }

    const latestMetadata = parseSlackMetadata(latestRecord.input.metadata);
    if (!latestMetadata) {
      throw new Error(
        "Latest conversation mailbox record is not Slack metadata",
      );
    }

    if (!(await context.checkIn())) {
      return { status: "lost_lease" };
    }

    const turnResult = await runWithSlackInstallation({
      adapter,
      installation: getInstallation(records),
      state,
      task: async () => {
        const messages = records.map((record) =>
          restoreMessage({ adapter, record }),
        );
        const destination = requireSlackDestination(
          requireReplyDestination(
            context.replyDelivery,
            "Slack conversation work",
          ),
          "Slack conversation work",
        );
        await bindSlackActorIdentities({
          lookupSlackUser: actorLookup,
          messages,
          teamId: destination.teamId,
        });
        const latestMessage = messages[messages.length - 1];
        if (!latestMessage) {
          return;
        }
        const route = routeForRecords(records);
        const thread = restoreThread({
          adapter,
          isSubscribedContext: route === "subscribed",
          message: latestMessage,
          state,
          threadJson: latestMetadata.thread,
        });
        const skipped = messages.slice(0, -1);
        const messageContext: MessageContext = {
          skipped,
          totalSinceLastHandler: messages.length,
        };
        const activeAuthorId = requireSlackAuthorId(latestMessage);
        let initialMessagesAcked = false;
        const ack = async (): Promise<void> => {
          if (initialMessagesAcked) {
            return;
          }
          try {
            await context.attempt.ack();
            initialMessagesAcked = true;
          } catch {
            throw new TurnInputCommitLostError(
              `Conversation work lease lost before Slack inbox ack for ${context.conversationId}`,
            );
          }
        };
        // Only explicit interruptions enter the active turn. Deferred work
        // stays pending for a normal turn.
        const drainSteeringMessages = async (
          accept: (
            messages: SteeringCandidateMessage[],
          ) => Promise<readonly string[]>,
        ): Promise<void> => {
          await context.attempt.drain(async (pendingRecords) => {
            const candidates = pendingRecords
              .map((record) => ({
                inboundMessageId: record.inboundMessageId,
                message: restoreMessage({ adapter, record }),
              }))
              .filter(
                (candidate) =>
                  crossActorMidRunMode === "steer" ||
                  requireSlackAuthorId(candidate.message) === activeAuthorId ||
                  hasSteeringOverride(candidate.message.text),
              );
            return candidates.length > 0 ? await accept(candidates) : [];
          });
        };
        try {
          if (route === "mention") {
            await options.runtime.handleNewMention(thread, latestMessage, {
              conversationId: context.conversationId,
              destination,
              messageContext,
              drainSteeringMessages,
              ack,
              isFinalAttempt: context.attempt.isFinalAttempt,
              shouldYield: context.shouldYield,
            });
          } else {
            await options.runtime.handleSubscribedMessage(
              thread,
              latestMessage,
              {
                conversationId: context.conversationId,
                destination,
                messageContext,
                drainSteeringMessages,
                ack,
                isFinalAttempt: context.attempt.isFinalAttempt,
                shouldYield: context.shouldYield,
              },
            );
          }
        } catch (error) {
          if (isTurnInputDeferredError(error)) {
            return { status: "deferred" } satisfies ConversationWorkerResult;
          }
          if (isCooperativeTurnYieldError(error)) {
            return { status: "yielded" } satisfies ConversationWorkerResult;
          }
          if (isTurnInputCommitLostError(error)) {
            return { status: "lost_lease" } satisfies ConversationWorkerResult;
          }
          throw error;
        }
      },
    });
    if (
      turnResult?.status === "deferred" ||
      turnResult?.status === "yielded" ||
      turnResult?.status === "lost_lease"
    ) {
      return turnResult;
    }

    return { status: "completed" };
  };
}

/** Serialize a Slack message into the generic durable conversation mailbox. */
export function buildSlackInboundMessage(args: {
  conversationId: string;
  installation?: SlackInstallationContext;
  message: Message;
  receivedAtMs: number;
  route: SlackConversationRoute;
  thread: ThreadImpl;
}): InboundMessage {
  const authorId = requireSlackAuthorId(args.message);
  const destination = createSlackDestination({
    channelId: args.thread.channelId,
    teamId: args.installation?.teamId,
  });
  if (!destination) {
    throw new Error("Slack inbound message requires destination context");
  }
  const hasInterruptOverride = hasSteeringOverride(args.message.text);
  return {
    conversationId: args.conversationId,
    destination,
    inboundMessageId: [
      "slack",
      args.installation?.teamId ?? args.installation?.enterpriseId ?? "unknown",
      args.conversationId,
      args.message.id,
    ].join(":"),
    delivery:
      args.message.isMention || hasInterruptOverride ? "interrupt" : "defer",
    source: "slack",
    createdAtMs: args.message.metadata.dateSent.getTime(),
    receivedAtMs: args.receivedAtMs,
    input: {
      text: args.message.text || " ",
      authorId,
      attachments: args.message.attachments,
      metadata: {
        platform: "slack",
        route: args.route,
        installation: args.installation,
        thread: serializedThreadSchema.parse(args.thread.toJSON()),
        message: args.message.toJSON(),
      } satisfies SlackConversationMessageMetadata,
    },
    replyDelivery: deliverReplyTo(destination),
  };
}
