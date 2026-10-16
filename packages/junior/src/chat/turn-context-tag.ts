/**
 * Canonical tag name for the runtime turn context block injected into Pi
 * messages. Shared between prompt assembly and turn context stripping to keep
 * both in sync without requiring the full prompt module.
 */
export const TURN_CONTEXT_TAG = "runtime-turn-context";

/**
 * Tag of the Conversation notes block inside the runtime turn context. Action
 * review evidence reads it to label notes as context, not as a person.
 */
export const CONVERSATION_NOTES_TAG = "conversation-notes";
