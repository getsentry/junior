import type { Platform, PluginRegistration } from "@sentry/junior-plugin-api";
import { coreSystemPromptRegistrations } from "@/chat/plugins/core-system-prompts";
import { getPluginSystemPromptContributions } from "@/chat/plugins/system-prompt-hook";
import {
  buildCoreSystemPromptSections,
  buildPluginSystemPromptContributions,
  readSystemPromptFilesForBuild,
  type SystemPromptFiles,
  type SystemPromptSection,
} from "@/chat/prompt";
import type { PromptMode } from "@/chat/system-prompt-rules";

// A build imports this module, so it must not import `@/chat/config` or
// anything else that reads runtime configuration when it loads.

/** The system prompt sections of every platform and Prompt mode. */
export type SystemPromptTable = Record<
  Platform,
  Record<PromptMode, SystemPromptSection[]>
>;

/** Block 9: the guidance of `plugins` for one platform, if they give any. */
export async function buildPluginSections(
  plugins: readonly PluginRegistration[],
  platform: Platform,
): Promise<SystemPromptSection[]> {
  const text = buildPluginSystemPromptContributions(
    await getPluginSystemPromptContributions(plugins, platform),
  );
  return text ? [{ name: "plugins", text }] : [];
}

/** The core blocks for one platform and Prompt mode, then `pluginSections`. */
export function buildModeSections(args: {
  platform: Platform;
  mode: PromptMode;
  botName: string;
  pluginSections: SystemPromptSection[];
  files?: SystemPromptFiles;
}): SystemPromptSection[] {
  return [
    ...buildCoreSystemPromptSections(
      args.platform,
      args.mode,
      args.botName,
      args.files,
    ),
    ...args.pluginSections,
  ];
}

async function buildPlatformSections(
  plugins: readonly PluginRegistration[],
  platform: Platform,
  botName: string,
  files: SystemPromptFiles,
): Promise<Record<PromptMode, SystemPromptSection[]>> {
  const pluginSections = await buildPluginSections(plugins, platform);
  const sections = (mode: PromptMode) =>
    buildModeSections({ platform, mode, botName, pluginSections, files });
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
 * core blocks with `botName`, then the guidance of `plugins` and of core
 * registrations. `juniorNitro` runs it once at build. A plugin hook that
 * fails, a `SOUL.md` or `WORLD.md` that exists but can't be read, or an empty
 * `SOUL.md` throws an error that names it.
 */
export async function buildSystemPromptTable(
  plugins: readonly PluginRegistration[],
  botName: string,
): Promise<SystemPromptTable> {
  const files = readSystemPromptFilesForBuild();
  // The same registrations, in the same order, as the runtime has.
  const registrations = [...plugins, ...coreSystemPromptRegistrations()];
  const [slack, local] = await Promise.all([
    buildPlatformSections(registrations, "slack", botName, files),
    buildPlatformSections(registrations, "local", botName, files),
  ]);
  return { slack, local };
}
