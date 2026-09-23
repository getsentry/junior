import {
  messageCardRefSchema,
  annotationCard,
} from "@/chat/conversations/cards";
import { ownedObjectAnnotationSchema } from "@sentry/junior-plugin-api";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { listConversationAnnotations } from "@/chat/plugins/annotations";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Select saved annotation snapshots without changing their objects or posting a message. */
export function createAttachCardsTool(conversationId: string) {
  return zodTool({
    approvalMode: "auto",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    executionMode: "sequential",
    description:
      "Attach saved annotations to your next reply. Omit refs to list available objects. Use returned plugin/key references. Create and update tools already attach cards; do not repeat their fields in prose. Set show=false to omit selected cards. This does not fetch objects or send a separate message.",
    inputSchema: z
      .object({
        refs: z.array(messageCardRefSchema).min(1).max(5).optional(),
        show: z.boolean().optional(),
      })
      .strict(),
    outputSchema: z.object({
      available: z
        .array(
          z.object({
            plugin: z.string(),
            key: z.string(),
            title: z.string(),
            url: z.string().nullable(),
          }),
        )
        .optional(),
      cards: z.array(ownedObjectAnnotationSchema),
      removedCards: z.array(messageCardRefSchema).optional(),
    }),
    async execute({ refs, show }) {
      const annotations = (
        await listConversationAnnotations(getDb(), conversationId)
      ).map(annotationCard);
      if (!refs)
        return {
          cards: [],
          available: annotations.map(({ plugin, key, title, url }) => ({
            plugin,
            key,
            title,
            url,
          })),
        };
      const cards = refs.map((ref) => {
        const annotation = annotations.find(
          (value) => value.plugin === ref.plugin && value.key === ref.key,
        );
        if (!annotation)
          throw new ToolInputError(
            "Object annotation is not available in this Conversation. Call attachCards without refs to list available objects.",
          );
        return annotation;
      });
      return show === false
        ? {
            cards: [],
            removedCards: cards.map(({ plugin, key }) => ({ plugin, key })),
          }
        : { cards };
    },
  });
}
