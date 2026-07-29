/**
 * Core-rendered plugin user pages.
 *
 * Plugins own bounded data projection; Junior owns viewer authorization,
 * routing, response validation, and browser rendering.
 */
import { z } from "zod";
import type { LocalActor, PluginContext, SlackActor } from "./context";
import { nonBlankStringSchema } from "./schemas";

const userPageIdSchema = nonBlankStringSchema
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
const userPageLabelSchema = nonBlankStringSchema.max(80);
const userPageDescriptionSchema = nonBlankStringSchema.max(500);

const pluginUserPageMetadataSchema = z
  .object({
    label: nonBlankStringSchema.max(80),
    value: nonBlankStringSchema.max(500),
  })
  .strict();

const pluginUserPageActionSchema = z
  .object({
    confirmation: nonBlankStringSchema.max(500).optional(),
    href: nonBlankStringSchema
      .max(500)
      .regex(/^\/api\/plugins\/[a-z][a-z0-9-]*(?:\/|$)/),
    label: nonBlankStringSchema.max(80),
    method: z.literal("DELETE"),
    tone: z.enum(["danger", "neutral"]).optional(),
  })
  .strict();

const pluginUserPageRecordSchema = z
  .object({
    actions: z.array(pluginUserPageActionSchema).max(4).optional(),
    description: nonBlankStringSchema.max(1_000).optional(),
    id: nonBlankStringSchema.max(128),
    metadata: z.array(pluginUserPageMetadataSchema).max(8).optional(),
    title: nonBlankStringSchema.max(4_000),
  })
  .strict();

/** Bounded list content returned by a plugin-owned user page. */
export const pluginUserPageContentSchema = z
  .object({
    emptyText: nonBlankStringSchema.max(500).optional(),
    nextCursor: nonBlankStringSchema.max(1_000).optional(),
    records: z.array(pluginUserPageRecordSchema).max(100),
    searchPlaceholder: nonBlankStringSchema.max(120).optional(),
    type: z.literal("list"),
  })
  .strict();

/** Validated content for the current core-rendered list page type. */
export type PluginUserPageContent = z.output<
  typeof pluginUserPageContentSchema
>;

export const pluginUserPageLinkSchema = z
  .object({
    description: userPageDescriptionSchema,
    id: userPageIdSchema,
    label: userPageLabelSchema,
    pluginDisplayName: nonBlankStringSchema.max(200),
    pluginName: nonBlankStringSchema.max(100),
  })
  .strict();

export const pluginUserPageLinksSchema = z.array(pluginUserPageLinkSchema);

/** Safe navigation metadata for one registered plugin user page. */
export type PluginUserPageLink = z.output<typeof pluginUserPageLinkSchema>;

/** Validated query state passed to one plugin user page reader. */
export const pluginUserPageInputSchema = z
  .object({
    cursor: nonBlankStringSchema.max(1_000).optional(),
    limit: z.number().int().min(1).max(50),
    query: z.string().trim().max(200).optional(),
  })
  .strict();

export type PluginUserPageInput = z.output<typeof pluginUserPageInputSchema>;

/** Runtime-owned actor shapes that may belong to an authenticated viewer. */
export type PluginUserPageActor = SlackActor | LocalActor;

/** Trusted host context supplied while reading one plugin user page. */
export interface PluginUserPageContext extends PluginContext {
  viewer: {
    actors: PluginUserPageActor[];
    email: string;
  };
}

/** Navigation metadata and reader for one core-rendered plugin user page. */
export interface PluginUserPageDefinition {
  description: string;
  id: string;
  label: string;
  read(
    ctx: PluginUserPageContext,
    input: PluginUserPageInput,
  ): Promise<PluginUserPageContent> | PluginUserPageContent;
}
