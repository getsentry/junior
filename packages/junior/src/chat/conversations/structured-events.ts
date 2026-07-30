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

function providerTitle(content: {
  provider: string;
  providerLabel?: string;
}): string {
  return content.providerLabel?.trim() || content.provider;
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

const NATIVE_EVENT_DEFINITIONS: readonly PluginConversationEventDefinition[] =
  [authenticationLinkedEvent, authenticationUnlinkedEvent];

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
  return conversationEventPresentationSchema.parse(
    definition.renderEvent(definition.parse(args.content)),
  );
}
