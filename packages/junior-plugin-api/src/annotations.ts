import { z } from "zod";
import type { PluginContext } from "./context";
import { objectAnnotationSchema } from "./object-annotations";
import { objectTypeSchema } from "./object-presentation";

function usesHttpProtocol(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Link an object to a Conversation when the owner has no typed object preview.
 * Keep a stable key, compact label, source URL, and optional short context or
 * status. Do not fetch a full object merely to save a link. Rich preview intent
 * belongs to objectAnnotationSchema, not a second set of resource-link fields.
 */
export const resourceLinkAnnotationSchema = z
  .object({
    kind: z.literal("resource_link"),
    objectType: objectTypeSchema.optional(),
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
  objectAnnotationSchema,
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

export const conversationSidebarIconSchema = z.enum([
  "circle-dot",
  "circle-dashed",
  "circle-x",
  "git-merge",
  "git-pull-request",
  "triangle-alert",
]);

export const conversationSidebarAnnotationSchema = z
  .object({
    icon: conversationSidebarIconSchema.optional(),
    objectType: objectTypeSchema.optional(),
    status: z.string().trim().min(1).max(100).optional(),
    key: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256),
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
  /** Sidebar annotations in display order. Put the newest annotation first. */
  annotationsByConversationId: Record<string, ConversationSidebarAnnotation[]>;
}
