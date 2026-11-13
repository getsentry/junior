/**
 * Link cards for Notion pages and databases.
 *
 * The viewer's own Notion MCP login reads the page with `notion-fetch`, so
 * Notion decides who sees the card. A viewer without a login or without
 * access gets the public web page card of the link, which shows only what
 * Notion shows anyone signed out. One cached read serves the access check,
 * the card, and the cover image.
 */
import {
  objectSummary,
  type ImageSourceContext,
  type ObjectAnnotation,
  type ObjectLinkContext,
  type PluginObjectLinkDefinition,
} from "@sentry/junior-plugin-api";
import * as z from "zod";

// Long enough that the access check, the card, and its cover share one
// read. A changed page shows within the card cache time.
const PAGE_READ_TTL_MS = 30_000;

const PAGE_ID_PATTERN =
  /(?:^|-)([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const DISPLAY_TYPES = {
  database: "Notion database",
  page: "Notion page",
} as const;

// `notion-fetch` returns JSON text. `null` means none, and a missing field
// means unknown.
const fetchedSchema = z.object({
  metadata: z.object({ type: z.string() }),
  title: z.string(),
  // A card needs only the title, so other fields are dropped when they
  // change shape.
  text: z.string().optional().catch(undefined),
  icon: z.unknown().optional(),
  cover: z.unknown().optional(),
  page_last_edited_at: z.iso
    .datetime({ offset: true })
    .optional()
    .catch(undefined),
});

const emojiIconSchema = z.object({
  type: z.literal("emoji"),
  emoji: z.string().min(1),
});
const coverSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("external"),
    external: z.object({ url: z.string() }),
  }),
  // Notion signs uploaded files for about an hour.
  z.object({ type: z.literal("file"), file: z.object({ url: z.string() }) }),
]);

/**
 * A cover image. An uploaded cover keeps only its address without the
 * signature, so no signed URL is stored: the image read asks Notion again.
 */
export type NotionCover =
  | { type: "external"; url: string }
  | { type: "file"; url: string };

/** What a card and its cover need from one page read. */
export interface NotionPage {
  cover?: NotionCover;
  editedAt?: string;
  id: string;
  summary?: string;
  title: string;
  type: keyof typeof DISPLAY_TYPES;
}

type ViewerReadContext = Pick<
  ObjectLinkContext | ImageSourceContext,
  "cache" | "viewer" | "viewerMcp"
>;

/** Return whether an image ref is a page id from `notionPageId`. */
export function isNotionPageId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

/** Return the page id of a Notion link. A peeked page `?p=` wins. */
export function notionPageId(url: URL): string | undefined {
  const segment = url.searchParams.get("p") ?? url.pathname.split("/").at(-1);
  const match = segment?.match(PAGE_ID_PATTERN)?.[1];
  return match?.replaceAll("-", "").toLowerCase();
}

function httpsUrl(value: string): URL | undefined {
  const url = URL.parse(value);
  return url?.protocol === "https:" ? url : undefined;
}

/** Read the cover with the signature dropped from an uploaded file. */
function parseCover(value: unknown): NotionCover | undefined {
  const cover = coverSchema.safeParse(value);
  if (!cover.success) return undefined;
  if (cover.data.type === "external") {
    const url = httpsUrl(cover.data.external.url);
    return url ? { type: "external", url: url.href } : undefined;
  }
  const url = httpsUrl(cover.data.file.url);
  return url
    ? { type: "file", url: `${url.origin}${url.pathname}` }
    : undefined;
}

// Text that is not body prose: headings, rules, code fences, and lines that
// hold only a block tag such as `<p />` or `<callout ...>`.
const SKIPPED_LINE = /^(#|---|```|<\/?[a-z-]+(\s[^>]*)?\/?>$)/i;

/**
 * Return the first body paragraph of a page as plain text. Notion returns
 * the body as Notion-flavored Markdown inside `<content>`.
 */
function pageSummary(text: string | undefined): string | undefined {
  const body = text?.match(/<content>([\s\S]*?)<\/content>/)?.[1] ?? "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || SKIPPED_LINE.test(line)) continue;
    const plain = line
      .replace(/<[^>]+>/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^([-*+]|\d+\.)\s+/, "")
      .replace(/[*_~`]/g, "")
      .replaceAll("\\", "");
    const summary = objectSummary(plain);
    if (summary) return summary;
  }
  return undefined;
}

function parseJsonText(content: Array<{ type: string; text?: string }>) {
  const text = content.find((part) => part.type === "text")?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Call `notion-fetch` as the viewer. Nothing without a login or access. */
async function notionFetch(
  ctx: ViewerReadContext,
  id: string,
): Promise<z.output<typeof fetchedSchema> | undefined> {
  const result = await ctx.viewerMcp.callTool({
    name: "notion-fetch",
    arguments: { id },
  });
  // Notion answers a page that the viewer cannot open with an error.
  if (result.status !== "success") return undefined;
  return fetchedSchema.safeParse(
    result.structuredContent ?? parseJsonText(result.content),
  ).data;
}

async function fetchPage(
  ctx: ViewerReadContext,
  id: string,
): Promise<NotionPage | null> {
  const page = await notionFetch(ctx, id);
  const type = page?.metadata.type;
  if (!page || (type !== "page" && type !== "database")) return null;
  const icon = emojiIconSchema.safeParse(page.icon);
  const title = page.title.trim() || "Untitled";
  const cover = parseCover(page.cover);
  return {
    id,
    type,
    // Notion puts an emoji icon at the start of the title.
    title:
      icon.success && !title.startsWith(icon.data.emoji)
        ? `${icon.data.emoji} ${title}`
        : title,
    ...(type === "page" ? { summary: pageSummary(page.text) } : undefined),
    ...(page.page_last_edited_at
      ? { editedAt: page.page_last_edited_at }
      : undefined),
    ...(cover ? { cover } : undefined),
  };
}

/**
 * Read one page as the viewer, through the plugin cache. Nothing when the
 * viewer has no Notion login or cannot open the page.
 */
export async function readViewerPage(
  ctx: ViewerReadContext,
  id: string,
): Promise<NotionPage | undefined> {
  // Each viewer has their own entry: a page holds only what they can see.
  const page = await ctx.cache.getOrLoad(
    `page:${ctx.viewer.id}:${id}`,
    async () => ({ value: await fetchPage(ctx, id), ttlMs: PAGE_READ_TTL_MS }),
  );
  return page ?? undefined;
}

/**
 * Read the address of an uploaded cover again, uncached, because Notion
 * signs it for a short time. Nothing when the cover changed.
 */
export async function readSignedCoverUrl(
  ctx: ViewerReadContext,
  page: NotionPage,
): Promise<string | undefined> {
  const cover = coverSchema.safeParse((await notionFetch(ctx, page.id))?.cover);
  if (!cover.success || cover.data.type !== "file") return undefined;
  const url = httpsUrl(cover.data.file.url);
  return url && `${url.origin}${url.pathname}` === page.cover?.url
    ? url.href
    : undefined;
}

async function canViewNotionLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<boolean> {
  const id = notionPageId(url);
  return !!id && !!(await readViewerPage(ctx, id));
}

async function resolveNotionLink(
  ctx: ObjectLinkContext,
  url: URL,
): Promise<ObjectAnnotation | undefined> {
  const id = notionPageId(url);
  const page = id && (await readViewerPage(ctx, id));
  if (!page) return undefined;
  const editedAtMs = page.editedAt ? Date.parse(page.editedAt) : Number.NaN;
  return {
    kind: "object",
    objectType: "document",
    key: page.id,
    label: page.title.slice(0, 80),
    title: page.title.slice(0, 512),
    url: url.href,
    displayType: DISPLAY_TYPES[page.type],
    sourceUpdatedAt: page.editedAt,
    facts: {
      type: "document",
      summary: page.summary,
      modifiedAt: page.editedAt,
      thumbnailUrl: page.cover
        ? ctx.imagePath(
            page.id,
            Number.isFinite(editedAtMs) ? String(editedAtMs) : undefined,
          )
        : undefined,
    },
  };
}

/** Notion page and database links that resolve to document cards. */
export const notionPageLinks: PluginObjectLinkDefinition = {
  filters: [
    { host: "notion.so" },
    { host: "www.notion.so" },
    { host: "app.notion.com" },
    { host: "*.notion.site" },
  ],
  canView: canViewNotionLink,
  objectType: "document",
  resolve: resolveNotionLink,
  webPageFallback: true,
};
