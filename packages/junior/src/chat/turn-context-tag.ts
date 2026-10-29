/**
 * Canonical tag name for the runtime turn context block injected into Pi
 * messages. Shared between prompt assembly and turn context stripping to keep
 * both in sync without requiring the full prompt module.
 */
export const TURN_CONTEXT_TAG = "runtime-turn-context";

/** Turn context section that only session context includes. */
export const SESSION_CONTEXT_SECTION_TAG = "runtime";

/**
 * Turn context sections that are true only for the Turn that received them.
 * Context compaction removes them from the context of earlier Turns.
 */
export const REQUEST_CONTEXT_SECTION_TAG = {
  pluginContext: "plugin-context",
  conversationNotes: "conversation-notes",
  disabledTools: "disabled-tools",
} as const;
