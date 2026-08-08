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
            path: z.string().trim().min(1).max(500),
          })
          .strict(),
      )
      .max(32),
    textBytes: z.number().int().nonnegative().optional(),
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

function wrapCode(value: string): string {
  return "`" + value + "`";
}

function agentsInstructionsPreview(content: {
  directory?: string;
  sources: Array<{ path: string }>;
}): string | undefined {
  if (content.directory?.trim()) {
    return wrapCode(content.directory.trim());
  }
  const path = content.sources[0]?.path.trim();
  return path ? wrapCode(path) : undefined;
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
    const sourcePaths = event.sources.map((source) => source.path);
    const descriptionParts = [
      ...(event.directory
        ? [`Directory: ${wrapCode(event.directory)}`]
        : []),
      ...(sourcePaths.length > 0
        ? [
            `Sources: ${sourcePaths.map((path) => wrapCode(path)).join(", ")}`,
          ]
        : []),
      ...(typeof event.textBytes === "number"
        ? [`${event.textBytes} bytes`]
        : []),
    ];
    return {
      icon: "brain",
      title,
      ...(preview ? { preview } : {}),
      details: [
        {
          title,
          ...(descriptionParts.length > 0
            ? { description: descriptionParts.join(" · ") }
            : {}),
          metadata: [event.action, ...sourcePaths.slice(0, 6)],
        },
      ],
    };
  },
});

const NATIVE_EVENT_DEFINITIONS: readonly PluginConversationEventDefinition[] = [
  authenticationLinkedEvent,
  authenticationUnlinkedEvent,
  agentsInstructionsUpdatedEvent,
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
