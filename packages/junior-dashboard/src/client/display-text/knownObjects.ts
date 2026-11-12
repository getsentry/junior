import {
  annotationCard,
  type ConversationDetailReport,
  type OwnedObjectAnnotation,
} from "@sentry/junior/api/schema";

import { parseMarkdownBlocks } from "./codeBlocks";
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

const STANDALONE_URL_RE = /^<?(https?:\/\/[^\s<>]+?)>?$/;

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
            const bare = STANDALONE_URL_RE.exec(paragraph.trim())?.[1];
            return bare !== undefined && objectUrlKey(bare) === key;
          }),
    )
  );
}
