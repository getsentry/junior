import type { Platform, PromptMode } from "@sentry/junior-plugin-api";
import { getPluginSystemPromptContributions } from "@/chat/plugins/agent-hooks";
import {
  buildPluginSystemPromptContributions,
  buildSystemPrompt,
} from "@/chat/prompt";

/**
 * Build the system prompt of every Turn on this deployment for one platform
 * and Prompt mode: the core blocks, then the plugin `systemPrompt` guidance.
 */
export async function buildDeploymentSystemPrompt(
  platform: Platform,
  mode: PromptMode,
): Promise<string> {
  const pluginSystemPrompt = buildPluginSystemPromptContributions(
    await getPluginSystemPromptContributions(platform, mode),
  );
  return [buildSystemPrompt(platform, mode), pluginSystemPrompt]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
