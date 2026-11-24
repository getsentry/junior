import type { Platform, PluginRegistration } from "@sentry/junior-plugin-api";
import {
  getPluginSystemPromptContributions,
  getRegistrations,
} from "@/chat/plugins/agent-hooks";
import {
  buildCoreSystemPromptSections,
  buildPluginSystemPromptContributions,
  readSystemPromptFilesForBuild,
  type SystemPromptFiles,
  type SystemPromptSection,
} from "@/chat/prompt";
import type { PromptMode } from "@/chat/system-prompt-rules";
import { isMissingVirtualModule } from "@/virtual-module";

/** The system prompt sections of every platform and Prompt mode. */
export type SystemPromptTable = Record<
  Platform,
  Record<PromptMode, SystemPromptSection[]>
>;

const SYSTEM_PROMPTS_MODULE = "#junior/system-prompts";

/** Block 9: the guidance of `plugins` for one platform, if they give any. */
async function buildPluginSections(
  plugins: readonly PluginRegistration[],
  platform: Platform,
): Promise<SystemPromptSection[]> {
  const text = buildPluginSystemPromptContributions(
    await getPluginSystemPromptContributions(plugins, platform),
  );
  return text ? [{ name: "plugins", text }] : [];
}

function buildModeSections(
  platform: Platform,
  mode: PromptMode,
  pluginSections: SystemPromptSection[],
  files?: SystemPromptFiles,
): SystemPromptSection[] {
  return [
    ...buildCoreSystemPromptSections(platform, mode, files),
    ...pluginSections,
  ];
}

async function buildPlatformSections(
  plugins: readonly PluginRegistration[],
  platform: Platform,
  files: SystemPromptFiles,
): Promise<Record<PromptMode, SystemPromptSection[]>> {
  const pluginSections = await buildPluginSections(plugins, platform);
  const sections = (mode: PromptMode) =>
    buildModeSections(platform, mode, pluginSections, files);
  return {
    automation: sections("automation"),
    child_agent: sections("child_agent"),
    conversation: sections("conversation"),
    lead: sections("lead"),
    thread: sections("thread"),
  };
}

/**
 * Build the system prompt sections of every platform and Prompt mode: the
 * core blocks, then the guidance of `plugins`. `juniorNitro` runs it once at
 * build. A plugin hook that fails, a `SOUL.md` or `WORLD.md` that exists but
 * can't be read, or an empty `SOUL.md` throws an error that names it.
 */
export async function buildSystemPromptTable(
  plugins: readonly PluginRegistration[],
): Promise<SystemPromptTable> {
  const files = readSystemPromptFilesForBuild();
  const [slack, local] = await Promise.all([
    buildPlatformSections(plugins, "slack", files),
    buildPlatformSections(plugins, "local", files),
  ]);
  return { slack, local };
}

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
    : buildModeSections(
        platform,
        mode,
        await buildPluginSections(getRegistrations(), platform),
      );
  return sections.map((section) => section.text).join("\n\n");
}
