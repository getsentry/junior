import type { WalkthroughDocument } from "@sentry/junior/api/schema";

/**
 * Add the GitHub permalink that the GitHub plugin would store with each hunk:
 * the first added line at the head commit, or the first removed line at the
 * base commit when the hunk only removes.
 */
export function withMockPermalinks(
  document: WalkthroughDocument,
): WalkthroughDocument {
  const layers = new Map(document.layers.map((layer) => [layer.pr, layer]));
  return {
    ...document,
    hunks: document.hunks.map((hunk) => {
      const layer = layers.get(hunk.pr);
      const line =
        hunk.lines.find((l) => l.kind === "add") ??
        hunk.lines.find((l) => l.kind === "remove");
      if (!layer || !line) return hunk;
      const [sha, number] =
        line.kind === "add"
          ? [layer.headSha, line.newLine]
          : [layer.baseSha, line.oldLine];
      return {
        ...hunk,
        url: `https://github.com/${document.repository}/blob/${sha}/${hunk.path}#L${number}`,
      };
    }),
  };
}
