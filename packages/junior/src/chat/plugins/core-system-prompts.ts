import type { PluginRegistration } from "@sentry/junior-plugin-api";
import { todosSystemPromptRegistration } from "@/chat/todos/prompt-rules";

/**
 * Return the prompt-only part of each core registration that has a
 * `systemPrompt` hook, in `coreRegistrations()` order. A build renders the
 * system prompts from these, so each one imports no runtime code.
 */
export function coreSystemPromptRegistrations(): PluginRegistration[] {
  return [todosSystemPromptRegistration];
}
