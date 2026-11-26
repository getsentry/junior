import { getChatConfig } from "@/chat/config";

/**
 * Return the install-wide configuration defaults (empty object when none set).
 * Each call returns a copy, so a caller cannot change config.
 */
export function getConfigDefaults(): Record<string, unknown> {
  return structuredClone(getChatConfig().configDefaults);
}
