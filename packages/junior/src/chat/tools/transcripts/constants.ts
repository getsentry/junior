import { Type } from "@sinclair/typebox";

/**
 * Core transcript tools join SQL conversation metadata to thread-state bodies.
 * Visibility is derived from the active runtime source before transcript state
 * is read; Slack links are source affordances and stay best effort.
 */
export const DEFAULT_LIST_LIMIT = 10;
export const DEFAULT_SEARCH_LIMIT = 10;
export const DEFAULT_READ_LIMIT = 100;
export const MAX_LIMIT = 50;
export const MAX_READ_LIMIT = 1000;
export const MAX_SCAN_LIMIT = 1000;
export const MAX_EXCERPT_CHARS = 500;
export const MAX_READ_CHARS = 40_000;
export const TRANSCRIPT_UNAVAILABLE_ERROR =
  "Transcript was not found or is not available from the current source context.";

export const includeLinksInput = Type.Optional(
  Type.Boolean({
    description:
      "Whether to include best-effort source links for returned transcripts and messages when the source supports them. Defaults to true.",
  }),
);
