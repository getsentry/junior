import { createHash } from "node:crypto";
import type { Platform } from "@sentry/junior-plugin-api";
import { getPluginSystemPromptContributions } from "@/chat/plugins/agent-hooks";
import {
  buildPluginSystemPromptContributions,
  buildSystemPrompt,
} from "@/chat/prompt";
import type { PromptMode } from "@/chat/system-prompt-rules";

/**
 * Build the system prompt of every Turn on this deployment for one platform
 * and Prompt mode: the core blocks, then the plugin `systemPrompt` guidance.
 */
export async function buildDeploymentSystemPrompt(
  platform: Platform,
  mode: PromptMode,
): Promise<string> {
  const pluginSystemPrompt = buildPluginSystemPromptContributions(
    await getPluginSystemPromptContributions(platform),
  );
  return [buildSystemPrompt(platform, mode), pluginSystemPrompt]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

/** Hash a system prompt, to compare prompts without storing their text. */
export function systemPromptHash(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
}
