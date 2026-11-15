/**
 * Canonical tag name for the runtime turn context block injected into Pi
 * messages. Shared between prompt assembly and turn context stripping to keep
 * both in sync without requiring the full prompt module.
 */
export const TURN_CONTEXT_TAG = "runtime-turn-context";

/** Turn context section that only session context includes. */
export const SESSION_CONTEXT_SECTION_TAG = "runtime";

/**
 * Turn context section with the tools a Code Mode script can call. A Turn
 * adds it only when it differs from the latest copy in history, and context
 * compaction keeps only that latest copy.
 */
export const SCRIPT_TOOLS_SECTION_TAG = "script-tools";

/**
 * Turn context sections that list what the model can use now. A Turn adds
 * one only when it differs from the latest copy in history, and context
 * compaction keeps only that latest copy.
 */
export const CAPABILITY_SECTION_TAG = {
  availableSkills: "available-skills",
  activeMcpCatalogs: "active-mcp-catalogs",
  toolGuidance: "tool-guidance",
  workspaces: "workspaces",
} as const;

/** One capability section tag. */
export type CapabilitySectionTag =
  (typeof CAPABILITY_SECTION_TAG)[keyof typeof CAPABILITY_SECTION_TAG];

/**
 * Turn context sections that are true only for the Turn that received them.
 * Context compaction removes them from the context of earlier Turns.
 */
export const REQUEST_CONTEXT_SECTION_TAG = {
  pluginContext: "plugin-context",
  conversationNotes: "conversation-notes",
  disabledTools: "disabled-tools",
  userCustomization: "user-customization",
} as const;
