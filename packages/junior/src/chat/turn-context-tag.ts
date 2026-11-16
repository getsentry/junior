/**
 * Canonical tag name for the runtime turn context block injected into Pi
 * messages. Shared between prompt assembly and turn context stripping to keep
 * both in sync without requiring the full prompt module.
 */
export const TURN_CONTEXT_TAG = "runtime-turn-context";

/** Turn context section that only session context includes. */
export const SESSION_CONTEXT_SECTION_TAG = "runtime";

/**
 * Named system prompt sections that list what the model can use now: the
 * skills, MCP catalogs, tool guidance, Workspaces, and the tools that a Code
 * Mode script can call. A Turn sends a changed section in a later system
 * message (`systemSectionsUpdate`). The Turn context of older Turns held
 * copies of them, which context compaction drops.
 */
export const CAPABILITY_SECTION_TAG = {
  availableSkills: "available-skills",
  activeMcpCatalogs: "active-mcp-catalogs",
  toolGuidance: "tool-guidance",
  workspaces: "workspaces",
  scriptTools: "script-tools",
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
