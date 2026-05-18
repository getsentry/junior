import {
  resolveEnabledChatPlatforms,
  SUPPORTED_CHAT_PLATFORMS,
  type ChatPlatform,
} from "@/chat/platforms";
import { getPluginProviders } from "@/chat/plugins/registry";
import { discoverSkills } from "@/chat/skills";

export interface JuniorPlatformOptions {
  plugins: readonly string[];
  skills?: readonly string[];
  configDefaults?: Record<string, unknown>;
}

export type JuniorPlatformOptionsMap = Partial<
  Record<ChatPlatform, JuniorPlatformOptions>
>;

export interface PlatformRuntimeConfig {
  pluginNames?: readonly string[];
  skillNames?: readonly string[];
  configDefaults?: Record<string, unknown>;
}

export type PlatformRuntimeConfigMap = Partial<
  Record<ChatPlatform, PlatformRuntimeConfig>
>;

interface ResolvedPlatformConfig {
  enabledPlatforms: ChatPlatform[];
  platformConfigs: PlatformRuntimeConfigMap;
}

function normalizeNameList(input: readonly string[]): string[] {
  const names = new Set<string>();
  for (const raw of input) {
    const name = raw.trim().toLowerCase();
    if (!name) {
      continue;
    }
    names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function assertSamePlatforms(
  left: readonly ChatPlatform[],
  right: readonly ChatPlatform[],
): void {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  if (
    leftSorted.length !== rightSorted.length ||
    leftSorted.some((platform, index) => platform !== rightSorted[index])
  ) {
    throw new Error(
      "enabledPlatforms must match platforms keys when platforms is configured",
    );
  }
}

/** Resolve platform enablement and per-platform runtime configuration. */
export function resolvePlatformConfig(input: {
  enabledPlatforms?: readonly string[];
  platforms?: JuniorPlatformOptionsMap;
}): ResolvedPlatformConfig {
  if (!input.platforms) {
    const enabledPlatforms = resolveEnabledChatPlatforms(
      input.enabledPlatforms,
      "enabledPlatforms",
    );
    return {
      enabledPlatforms,
      platformConfigs: Object.fromEntries(
        enabledPlatforms.map((platform) => [platform, {}]),
      ),
    };
  }

  const platformConfigs: PlatformRuntimeConfigMap = {};
  const enabledPlatforms: ChatPlatform[] = [];

  for (const rawPlatform of Object.keys(input.platforms).sort()) {
    const platform = rawPlatform.trim().toLowerCase();
    if (!SUPPORTED_CHAT_PLATFORMS.includes(platform as ChatPlatform)) {
      throw new Error(
        `platforms must contain only: ${SUPPORTED_CHAT_PLATFORMS.join(", ")}`,
      );
    }

    const config = (input.platforms as Record<string, JuniorPlatformOptions>)[
      rawPlatform
    ];
    if (!config || typeof config !== "object") {
      throw new Error(`platforms.${platform} must be an object`);
    }
    if (!Array.isArray(config.plugins)) {
      throw new Error(
        `platforms.${platform}.plugins must be an array of plugin names`,
      );
    }
    if (config.skills !== undefined && !Array.isArray(config.skills)) {
      throw new Error(
        `platforms.${platform}.skills must be an array of skill names`,
      );
    }
    enabledPlatforms.push(platform as ChatPlatform);
    platformConfigs[platform as ChatPlatform] = {
      pluginNames: normalizeNameList(config.plugins),
      ...(config.skills
        ? {
            skillNames: normalizeNameList(config.skills),
          }
        : {}),
      ...(config.configDefaults
        ? { configDefaults: { ...config.configDefaults } }
        : {}),
    };
  }

  if (enabledPlatforms.length === 0) {
    throw new Error(
      `platforms must contain at least one platform: ${SUPPORTED_CHAT_PLATFORMS.join(", ")}`,
    );
  }

  if (input.enabledPlatforms) {
    assertSamePlatforms(
      resolveEnabledChatPlatforms(input.enabledPlatforms, "enabledPlatforms"),
      enabledPlatforms,
    );
  }

  return { enabledPlatforms, platformConfigs };
}

/** Validate configured platform plugin and skill names against installed content. */
export async function validatePlatformConfig(
  platformConfigs: PlatformRuntimeConfigMap,
): Promise<void> {
  const knownPlugins = new Set(
    getPluginProviders().map((plugin) => plugin.manifest.name),
  );
  const knownSkills = new Map(
    (await discoverSkills()).map((skill) => [skill.name, skill]),
  );

  for (const platform of SUPPORTED_CHAT_PLATFORMS) {
    const config = platformConfigs[platform];
    if (!config?.pluginNames) {
      continue;
    }
    const pluginNames = new Set(config.pluginNames);
    for (const pluginName of pluginNames) {
      if (!knownPlugins.has(pluginName)) {
        throw new Error(
          `platforms.${platform}.plugins contains unknown plugin "${pluginName}"`,
        );
      }
    }
    for (const skillName of config.skillNames ?? []) {
      const skill = knownSkills.get(skillName);
      if (!skill) {
        throw new Error(
          `platforms.${platform}.skills contains unknown skill "${skillName}"`,
        );
      }
      if (skill.pluginProvider && !pluginNames.has(skill.pluginProvider)) {
        throw new Error(
          `platforms.${platform}.skills includes "${skillName}" from plugin "${skill.pluginProvider}", but platforms.${platform}.plugins does not include "${skill.pluginProvider}"`,
        );
      }
    }
  }
}
