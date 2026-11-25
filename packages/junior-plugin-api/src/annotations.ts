import * as z from "zod";
import type { PluginContext } from "./context";
import {
  ownedObjectAnnotationSchema,
  savedObjectAnnotationSchema,
  type ObjectSubject,
} from "./object-annotations";
import { objectTypeSchema } from "./object-presentation";

function usesHttpProtocol(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const httpUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine(usesHttpProtocol, "URL must use HTTP or HTTPS.");

/**
 * Link an object to a Conversation by its link alone, such as a link that a
 * person attached. Junior stores no title for it: the title would show to
 * readers who cannot open the object. Its card reads the object live.
 */
export const resourceLinkAnnotationSchema = z
  .object({
    kind: z.literal("resource_link"),
    objectType: objectTypeSchema.optional(),
    key: z.string().trim().min(1).max(256),
    url: httpUrlSchema,
  })
  .strict();

/** Core-known annotation shapes that plugins may attach to a conversation. */
export const conversationAnnotationInputSchema = z.discriminatedUnion("kind", [
  resourceLinkAnnotationSchema,
  savedObjectAnnotationSchema,
]);
export type ConversationAnnotationInput = z.output<
  typeof conversationAnnotationInputSchema
>;
export type ConversationAnnotation = ConversationAnnotationInput & {
  plugin: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * The label and the link of an object that Junior cannot read for the
 * viewer, such as when the viewer has no access or the provider is down.
 * The plugin makes the label from the link. An object without a link, such
 * as an Automation of an install without a dashboard, has no `url`.
 */
const annotationLabelSchema = resourceLinkAnnotationSchema.extend({
  label: z.string().trim().min(1).max(256),
  plugin: z.string().min(1),
  url: httpUrlSchema.nullable(),
});

/**
 * An Annotation as one viewer sees it: the live card of its object, else
 * only its label and its link.
 */
export const liveAnnotationSchema = z
  .discriminatedUnion("kind", [
    annotationLabelSchema,
    ownedObjectAnnotationSchema,
  ])
  .and(
    z.object({
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
  );
export type LiveAnnotation = z.output<typeof liveAnnotationSchema>;

export interface PluginAnnotations {
  upsert(annotation: ConversationAnnotationInput): Promise<void>;
  remove(kind: ConversationAnnotationInput["kind"], key: string): Promise<void>;
  list(): Promise<ConversationAnnotation[]>;
}
export interface PluginConversationAnnotations {
  forConversation(conversationId: string): PluginAnnotations;
  /**
   * Tell Junior that the provider changed one object, such as a merge.
   * Junior marks each Conversation that annotates the object as changed, so
   * an open page reads its live card again. It writes no Annotation. Call
   * it only when the object changed, not for each event about it.
   */
  objectChanged(subject: ObjectSubject): Promise<void>;
}

export const conversationSidebarIconSchema = z.enum([
  "circle-dot",
  "circle-dashed",
  "circle-x",
  "git-merge",
  "git-pull-request",
  "triangle-alert",
]);

/**
 * One linked object on a Conversation row. `label` is the short chip text.
 * `title` and `url` are the saved object's own, for rows with room for a
 * card; leave them out when the plugin has not saved them. `imageUrl` is a
 * public image that previews the object, such as the first screenshot of a
 * code change.
 */
export const conversationSidebarAnnotationSchema = z
  .object({
    icon: conversationSidebarIconSchema.optional(),
    objectType: objectTypeSchema.optional(),
    status: z.string().trim().min(1).max(100).optional(),
    key: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256),
    title: z.string().trim().min(1).max(512).optional(),
    url: httpUrlSchema.optional(),
    imageUrl: httpUrlSchema.optional(),
  })
  .strict();
export type ConversationSidebarAnnotation = z.output<
  typeof conversationSidebarAnnotationSchema
>;

export interface ConversationSidebarHookContext extends PluginContext {
  /**
   * The annotations of this plugin as the viewer sees them, keyed by
   * candidate conversation.
   */
  annotationsByConversationId: Record<string, LiveAnnotation[]>;
  conversationIds: string[];
}

export interface ConversationSidebarResult {
  /** Sidebar annotations in display order. Put the newest annotation first. */
  annotationsByConversationId: Record<string, ConversationSidebarAnnotation[]>;
}
