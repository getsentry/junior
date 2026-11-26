import type { Platform } from "@sentry/junior-plugin-api";
import { botConfig } from "@/chat/config";
import { getRegistrations } from "@/chat/plugins/hooks/registry";
import type { PromptMode } from "@/chat/system-prompt-rules";
import {
  buildModeSections,
  buildPluginSections,
  type SystemPromptTable,
} from "@/chat/system-prompt-table";
import { isMissingVirtualModule } from "@/virtual-module";

const SYSTEM_PROMPTS_MODULE = "#junior/system-prompts";

/** Tell whether this code runs in a `juniorNitro()` build. */
async function hasVirtualConfig(): Promise<boolean> {
  try {
    await import("#junior/config");
    return true;
  } catch (error) {
    if (!isMissingVirtualModule(error, "#junior/config")) {
      throw error;
    }
    return false;
  }
}

async function readBuiltSystemPromptTable(): Promise<
  SystemPromptTable | undefined
> {
  try {
    const mod: { systemPrompts: SystemPromptTable } =
      await import("#junior/system-prompts");
    return mod.systemPrompts;
  } catch (error) {
    if (!isMissingVirtualModule(error, SYSTEM_PROMPTS_MODULE)) {
      throw error;
    }
    // A build that bundles `#junior/config` must also bundle the system
    // prompts. Without this check, it would run plugin hooks per Turn.
    if (await hasVirtualConfig()) {
      throw new Error(
        `${SYSTEM_PROMPTS_MODULE} is missing from this juniorNitro() build`,
        { cause: error },
      );
    }
    return undefined;
  }
}

/**
 * Give the system prompt of every Turn on this deployment for one platform
 * and Prompt mode. A `juniorNitro()` build reads it from the table that the
 * build made, and throws if the table is missing. With no build, such as in
 * `nitro dev`, the CLI and tests, it builds the sections of that platform and
 * mode from the registered plugins.
 */
export async function buildDeploymentSystemPrompt(
  platform: Platform,
  mode: PromptMode,
): Promise<string> {
  const built = await readBuiltSystemPromptTable();
  const sections = built
    ? built[platform][mode]
    : buildModeSections({
        platform,
        mode,
        botName: botConfig.userName,
        pluginSections: await buildPluginSections(getRegistrations(), platform),
      });
  return sections.map((section) => section.text).join("\n\n");
}
