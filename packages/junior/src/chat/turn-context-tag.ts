/**
 * Canonical tag name for the runtime turn context block injected into Pi
 * messages. Shared between prompt assembly and turn context stripping to keep
 * both in sync without requiring the full prompt module.
 */
export const TURN_CONTEXT_TAG = "runtime-turn-context";
