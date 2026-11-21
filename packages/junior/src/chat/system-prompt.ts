import type { Platform } from "@sentry/junior-plugin-api";
import { getPluginSystemPromptContributions } from "@/chat/plugins/agent-hooks";
import {
  buildPluginSystemPromptContributions,
  buildSystemPrompt,
} from "@/chat/prompt";
import {
  buildReplyLengthReminder,
  type PromptMode,
} from "@/chat/system-prompt-rules";

/**
 * Build the system prompt of every Turn on this deployment for one platform
 * and Prompt mode: the core blocks, the plugin `systemPrompt` guidance, then
 * the reply length reminder.
 */
export async function buildDeploymentSystemPrompt(
  platform: Platform,
  mode: PromptMode,
): Promise<string> {
  const pluginSystemPrompt = buildPluginSystemPromptContributions(
    await getPluginSystemPromptContributions(platform),
  );
  return [
    buildSystemPrompt(platform, mode),
    pluginSystemPrompt,
    buildReplyLengthReminder(mode),
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
