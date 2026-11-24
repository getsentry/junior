import {
  promptMessageSchema,
  type Platform,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { runPluginHooksAtOnce } from "@/chat/plugins/hook-runner";
import { createPluginLogger } from "@/chat/plugins/logging";
import {
  PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS,
  toPromptContributionContext,
  type PluginPromptContributionContext,
} from "@/chat/plugins/prompt";

const systemPromptMessageArraySchema = z.array(promptMessageSchema);

/**
 * Collect the guidance of `plugins` for the static system prompts of one
 * platform, in plugin name order, so a build and the runtime give the same
 * text. Every Prompt mode on the platform reuses it. A hook gets no database
 * or cache. A hook that throws, returns invalid guidance, or goes over the
 * guidance budget throws an error that names its plugin, so the build fails.
 */
export async function getPluginSystemPromptContributions(
  plugins: readonly PluginRegistration[],
  platform: Platform,
): Promise<PluginPromptContributionContext[]> {
  const contributions: PluginPromptContributionContext[] = [];
  let totalChars = 0;
  const ordered = [...plugins].sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  );
  const outcomes = await runPluginHooksAtOnce(ordered, (plugin) => {
    const hook = plugin.hooks?.systemPrompt;
    const name = plugin.manifest.name;
    return (
      hook &&
      (() =>
        hook({
          plugin: { name },
          log: createPluginLogger(name),
          platform,
        }))
    );
  });
  for (const outcome of outcomes) {
    const pluginName = outcome.plugin.manifest.name;
    const failure = `Plugin "${pluginName}" systemPrompt hook failed for ${platform}`;
    if ("error" in outcome) {
      throw new Error(failure, { cause: outcome.error });
    }
    const result = systemPromptMessageArraySchema.safeParse(outcome.value);
    if (!result.success) {
      throw new Error(`${failure}: invalid guidance`, { cause: result.error });
    }
    const acceptedContributions = result.data.map((message, index) =>
      toPromptContributionContext({
        hookName: "systemPrompt",
        index,
        message,
        pluginName,
      }),
    );
    totalChars += acceptedContributions.reduce(
      (sum, contribution) => sum + contribution.text.length,
      0,
    );
    if (totalChars > PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS) {
      throw new Error(
        `${failure}: plugin guidance is over ${PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS} characters`,
      );
    }
    contributions.push(...acceptedContributions);
  }
  return contributions;
}
