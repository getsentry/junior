import {
  annotationCard,
  type ConversationDetailReport,
  type OwnedObjectAnnotation,
} from "@sentry/junior/api/schema";

import { MARKDOWN_FENCE, parseMarkdownBlocks } from "./codeBlocks";
import { slackLinksToMarkdown } from "./links";

/** Saved objects that display text can show for a link, by `objectUrlKey`. */
export type KnownObjects = ReadonlyMap<string, OwnedObjectAnnotation>;

/**
 * Return the key that matches a link to the canonical URL that a plugin saved
 * on an Annotation. Only a trailing slash is dropped: a link to a comment or
 * to another page of the object is a different link.
 */
export function objectUrlKey(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * Index the Annotations of a Conversation by URL. The first Annotation for a
 * URL wins, so the newest saved one shows.
 */
export function knownObjectsFromAnnotations(
  annotations: ConversationDetailReport["annotations"],
): KnownObjects {
  const objects = new Map<string, OwnedObjectAnnotation>();
  for (const annotation of annotations ?? []) {
    const key = annotation.url ? objectUrlKey(annotation.url) : undefined;
    if (key && !objects.has(key)) objects.set(key, annotationCard(annotation));
  }
  return objects;
}

// Four spaces of indent make a code block, so they do not count.
const STANDALONE_URL_RE = /^ {0,3}<?(https?:\/\/[^\s<>]+?)>?\s*$/;

/**
 * Return whether a bare URL for `url` is alone in a paragraph of display
 * text. The Markdown renderer shows that URL as the full object card, so a
 * surface can hide its own card for the same object. Code fences do not
 * count.
 */
export function textHasStandaloneUrl(text: string, url: string): boolean {
  const key = objectUrlKey(url);
  return (
    key !== undefined &&
    parseMarkdownBlocks(text).some(
      (block) =>
        !block.fenced &&
        block.language === "markdown" &&
        slackLinksToMarkdown(block.code)
          .split(/\n[ \t]*\n/)
          .some((paragraph) => {
            const bare = STANDALONE_URL_RE.exec(
              paragraph.replace(/^\n+/, ""),
            )?.[1];
            return bare !== undefined && objectUrlKey(bare) === key;
          }),
    )
  );
}

/**
 * Split display text into its prose and the bare URLs that stand alone in a
 * paragraph, in their order. The Markdown renderer shows each such URL as an
 * object card, so a clamped preview clamps only the prose and shows the
 * cards in full after it. Code fences stay in the prose.
 */
export function splitStandaloneUrls(text: string): {
  prose: string;
  urls: string[];
} {
  const urls: string[] = [];
  const parts: string[] = [];
  const keepProse = (prose: string) => {
    const kept = prose.split(/\n[ \t]*\n/).filter((paragraph) => {
      const bare = STANDALONE_URL_RE.exec(
        slackLinksToMarkdown(paragraph).replace(/^\n+/, ""),
      )?.[1];
      if (bare) urls.push(bare);
      return !bare && paragraph.trim();
    });
    if (kept.length > 0) parts.push(kept.join("\n\n").trim());
  };
  let cursor = 0;
  for (const fence of text.matchAll(MARKDOWN_FENCE)) {
    keepProse(text.slice(cursor, fence.index));
    parts.push(fence[0]);
    cursor = fence.index + fence[0].length;
  }
  keepProse(text.slice(cursor));
  return { prose: parts.join("\n\n"), urls };
}
