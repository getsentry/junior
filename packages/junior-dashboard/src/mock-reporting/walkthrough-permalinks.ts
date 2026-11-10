import type { WalkthroughDocument } from "@sentry/junior/api/schema";

/**
 * Add the GitHub permalink that Junior would store with each excerpt: the
 * first cited line at the head commit, or at the base commit for base-side
 * citations.
 */
export function withMockPermalinks(
  document: WalkthroughDocument,
): WalkthroughDocument {
  const layers = new Map(document.layers.map((layer) => [layer.pr, layer]));
  return {
    ...document,
    excerpts: document.excerpts.map((excerpt) => {
      const layer = layers.get(excerpt.pr);
      if (!layer) return excerpt;
      const sha = excerpt.side === "head" ? layer.headSha : layer.baseSha;
      return {
        ...excerpt,
        url: `https://github.com/${document.repository}/blob/${sha}/${excerpt.path}#L${excerpt.start}`,
      };
    }),
  };
}
