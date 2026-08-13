import { z } from "zod";
import type { PluginContext } from "./context";

function usesHttpProtocol(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export const resourceLinkAnnotationSchema = z
  .object({
    kind: z.literal("resource_link"),
    key: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256),
    url: z
      .string()
      .url()
      .max(2_048)
      .refine(usesHttpProtocol, "URL must use HTTP or HTTPS."),
    description: z.string().trim().min(1).max(512).optional(),
    status: z.enum(["open", "draft", "closed", "merged", "warning"]).optional(),
  })
  .strict();

/** Core-known annotation shapes that plugins may attach to a conversation. */
export const conversationAnnotationInputSchema = z.discriminatedUnion("kind", [
  resourceLinkAnnotationSchema,
]);
export type ConversationAnnotationInput = z.output<
  typeof conversationAnnotationInputSchema
>;
export type ConversationAnnotation = ConversationAnnotationInput & {
  plugin: string;
  createdAt: string;
  updatedAt: string;
};
export interface PluginAnnotations {
  upsert(annotation: ConversationAnnotationInput): Promise<void>;
  remove(kind: ConversationAnnotationInput["kind"], key: string): Promise<void>;
  list(): Promise<ConversationAnnotation[]>;
}
export interface PluginConversationAnnotations {
  forConversation(conversationId: string): PluginAnnotations;
}

export const conversationSidebarAnnotationSchema = z
  .object({
    key: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256),
    status: resourceLinkAnnotationSchema.shape.status,
  })
  .strict();
export type ConversationSidebarAnnotation = z.output<
  typeof conversationSidebarAnnotationSchema
>;

export interface ConversationSidebarHookContext extends PluginContext {
  /** Stored annotations owned by this plugin, keyed by candidate conversation. */
  annotationsByConversationId: Record<string, ConversationAnnotation[]>;
  conversationIds: string[];
}

export interface ConversationSidebarResult {
  annotationsByConversationId: Record<
    string,
    ConversationSidebarAnnotation[]
  >;
}
