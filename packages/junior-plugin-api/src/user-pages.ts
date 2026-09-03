/**
 * Core-rendered plugin user pages.
 *
 * Plugins own bounded data projection; Junior owns viewer authorization,
 * routing, response validation, and browser rendering.
 */
import { z } from "zod";
import type { PluginContext, User } from "./context.js";
import { nonBlankStringSchema } from "./schemas.js";

const userPageIdSchema = nonBlankStringSchema
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
const userPageLabelSchema = nonBlankStringSchema.max(80);
const userPageDescriptionSchema = nonBlankStringSchema.max(500);
const userPageNavigationSchema = z.enum(["primary", "profile"]);

const pluginUserPageMetricSchema = z
  .object({
    detail: nonBlankStringSchema.max(500).optional(),
    label: nonBlankStringSchema.max(80),
    tone: z.enum(["good", "neutral", "warning"]).optional(),
    value: nonBlankStringSchema.max(120),
  })
  .strict();

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
    metrics: z.array(pluginUserPageMetricSchema).max(6).optional(),
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
    navigation: userPageNavigationSchema,
    pluginDisplayName: nonBlankStringSchema.max(200),
    pluginName: nonBlankStringSchema.max(100),
  })
  .strict();

export const pluginUserPageLinksSchema = z.array(pluginUserPageLinkSchema);

/** Safe navigation metadata for one registered plugin user page. */
export type PluginUserPageLink = z.output<typeof pluginUserPageLinkSchema>;

/** Optional cursor token for one plugin user page reader. */
export const pluginUserPageCursorSchema = nonBlankStringSchema
  .max(1_000)
  .optional();

/** Optional filter token for one plugin user page reader. */
export const pluginUserPageFilterSchema = nonBlankStringSchema
  .max(64)
  .optional();

/** Optional free-text query for one plugin user page reader. */
export const pluginUserPageQuerySchema = z.string().trim().max(200).optional();

/** Validated query state passed to one plugin user page reader. */
export const pluginUserPageInputSchema = z
  .object({
    cursor: pluginUserPageCursorSchema,
    filter: pluginUserPageFilterSchema,
    limit: z.number().int().min(1).max(50),
    query: pluginUserPageQuerySchema,
  })
  .strict();

export type PluginUserPageInput = z.output<typeof pluginUserPageInputSchema>;

/** Trusted host context supplied while reading one plugin user page. */
export interface PluginUserPageContext extends PluginContext {
  viewer: User;
}

/** Navigation metadata and reader for one core-rendered plugin user page. */
export interface PluginUserPageDefinition {
  description: string;
  id: string;
  label: string;
  /** Dashboard navigation surface where this page is linked. */
  navigation?: "primary" | "profile";
  read(
    ctx: PluginUserPageContext,
    input: PluginUserPageInput,
  ): Promise<PluginUserPageContent> | PluginUserPageContent;
}
