/**
 * The leading capability sections of a Conversation: the sections of the
 * system prompt, saved once by the first Turn that builds them.
 */
import { getConversationEventStore } from "@/chat/db";

/**
 * Load the capability sections of the Conversation's leading system message,
 * or none before the first Turn that builds them.
 */
export async function loadLeadingSystemSections(
  conversationId: string,
): Promise<Record<string, string> | undefined> {
  const [first] = await getConversationEventStore().loadEventsOfType(
    conversationId,
    "leading_system_sections",
  );
  return first?.data.type === "leading_system_sections"
    ? Object.fromEntries(
        first.data.sections.map((section) => [section.name, section.text]),
      )
    : undefined;
}

/** Save the leading capability sections once; a later write is a no-op. */
export async function recordLeadingSystemSections(args: {
  conversationId: string;
  sections: Record<string, string>;
}): Promise<void> {
  await getConversationEventStore().append(args.conversationId, [
    {
      idempotencyKey: "leading_system_sections",
      data: {
        type: "leading_system_sections",
        sections: Object.entries(args.sections).map(([name, text]) => ({
          name,
          text,
        })),
      },
      createdAtMs: Date.now(),
    },
  ]);
}
