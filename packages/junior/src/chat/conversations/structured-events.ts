import {
  conversationEventPresentationSchema,
  defineConversationEvent,
  type ConversationEventPresentation,
  type PluginConversationEventDefinition,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

/** Reserved namespace for Junior-owned conversation metadata events. */
export const JUNIOR_NATIVE_EVENT_NAMESPACE = "junior" as const;

const authenticationEventContentSchema = z
  .object({
    accountLabel: z.string().trim().min(1).max(120).optional(),
    actorId: z.string().min(1),
    authorizationId: z.string().min(1).optional(),
    provider: z.string().regex(/^[a-z][a-z0-9-]*$/),
    providerLabel: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

const agentsInstructionsUpdatedContentSchema = z
  .object({
    action: z.enum(["loaded", "replaced", "cleared"]),
    directory: z.string().trim().min(1).max(500).optional(),
    fingerprint: z.string().trim().min(1).max(128),
    sources: z
      .array(
        z
          .object({
            content: z
              .string()
              .min(1)
              .max(32 * 1024),
            path: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(32),
    textBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

const conversationForkedContentSchema = z
  .object({
    sourceConversationId: z.string().min(1),
    throughSeq: z.number().int().nonnegative(),
    sourceMessageId: z.string().min(1).optional(),
  })
  .strict();

function providerTitle(content: {
  provider: string;
  providerLabel?: string;
}): string {
  return content.providerLabel?.trim() || content.provider;
}

function agentsInstructionsTitle(
  action: "loaded" | "replaced" | "cleared",
): string {
  if (action === "loaded") return "Loaded AGENTS.md";
  if (action === "replaced") return "Updated AGENTS.md";
  return "Cleared AGENTS.md";
}

function sourceFilename(sourcePath: string): string {
  return sourcePath.split("/").at(-1) || sourcePath;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kilobytes = bytes / 1024;
  return `${Number.isInteger(kilobytes) ? kilobytes : kilobytes.toFixed(1)} KB`;
}

function agentsInstructionsPreview(content: {
  sources: Array<{ content: string; path: string }>;
  textBytes?: number;
}): string | undefined {
  const source = content.sources[0];
  if (!source) return undefined;
  const filename = sourceFilename(source.path);
  const label =
    content.sources.length === 1
      ? filename
      : `${content.sources.length} AGENTS.md files`;
  return typeof content.textBytes === "number"
    ? `${label} · ${formatBytes(content.textBytes)}`
    : label;
}

/** Junior-owned account-link transcript event. */
export const authenticationLinkedEvent = defineConversationEvent({
  name: "authentication_linked",
  version: 1,
  schema: authenticationEventContentSchema,
  renderEvent(event) {
    const provider = providerTitle(event);
    return {
      icon: "link",
      title: `${provider} connected`,
      ...(event.accountLabel
        ? { preview: `Connected as \`${event.accountLabel}\`` }
        : {}),
      details: [
        {
          title: `${provider} connected`,
          ...(event.accountLabel
            ? { description: `Connected as \`${event.accountLabel}\`` }
            : {}),
          metadata: [event.provider],
        },
      ],
    };
  },
});

/** Junior-owned account-unlink transcript event. */
export const authenticationUnlinkedEvent = defineConversationEvent({
  name: "authentication_unlinked",
  version: 1,
  schema: authenticationEventContentSchema,
  renderEvent(event) {
    const provider = providerTitle(event);
    return {
      icon: "key",
      title: `${provider} disconnected`,
      details: [
        {
          title: `${provider} disconnected`,
          metadata: [event.provider],
        },
      ],
    };
  },
});

/** Junior-owned AGENTS.md bootstrap transition for the dashboard timeline. */
export const agentsInstructionsUpdatedEvent = defineConversationEvent({
  name: "agents_instructions_updated",
  version: 1,
  schema: agentsInstructionsUpdatedContentSchema,
  renderEvent(event) {
    const title = agentsInstructionsTitle(event.action);
    const preview = agentsInstructionsPreview(event);
    return {
      icon: "brain",
      title,
      ...(preview ? { preview } : {}),
      ...(event.sources.length > 0
        ? {
            details: event.sources.map((source) => ({
              title: sourceFilename(source.path),
              content: source.content,
            })),
          }
        : {}),
    };
  },
});

/** Junior-owned backlink for a conversation forked from an earlier cutoff. */
export const conversationForkedEvent = defineConversationEvent({
  name: "conversation_forked",
  version: 1,
  schema: conversationForkedContentSchema,
  renderEvent(event) {
    return {
      icon: "activity",
      title: "Forked conversation",
      preview: `From ${event.sourceConversationId} through seq ${event.throughSeq}`,
      details: [
        {
          title: "Forked conversation",
          description: event.sourceMessageId
            ? `Source message \`${event.sourceMessageId}\` in \`${event.sourceConversationId}\``
            : `Source conversation \`${event.sourceConversationId}\``,
          metadata: [`seq ${event.throughSeq}`],
        },
      ],
    };
  },
});

const NATIVE_EVENT_DEFINITIONS: readonly PluginConversationEventDefinition[] = [
  authenticationLinkedEvent,
  authenticationUnlinkedEvent,
  agentsInstructionsUpdatedEvent,
  conversationForkedEvent,
];

/** Resolve a registered Junior-native conversation event definition. */
export function getJuniorNativeEventDefinition(args: {
  name: string;
  version: number;
}): PluginConversationEventDefinition | undefined {
  return NATIVE_EVENT_DEFINITIONS.find(
    (definition) =>
      definition.eventName === args.name && definition.version === args.version,
  );
}

/** Render one Junior-native event through its active definition. */
export function renderJuniorNativeConversationEvent(args: {
  content: Record<string, unknown>;
  name: string;
  namespace: string;
  version: number;
}): ConversationEventPresentation | undefined {
  if (args.namespace !== JUNIOR_NATIVE_EVENT_NAMESPACE) return undefined;
  const definition = getJuniorNativeEventDefinition(args);
  if (!definition) return undefined;
  const presentation = definition.renderEvent(definition.parse(args.content));
  return presentation === undefined
    ? undefined
    : conversationEventPresentationSchema.parse(presentation);
}
