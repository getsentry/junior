import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CapabilityProviderDefinition } from "@/chat/capabilities/catalog";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { pluginRoots } from "@/chat/home";
import { logInfo, logWarn, setSpanAttributes } from "@/chat/observability";
import { createGitHubAppBroker } from "./github-app-broker";
import { parsePluginManifest } from "./manifest";
import { createOAuthBearerBroker } from "./oauth-bearer-broker";
import { discoverInstalledPluginPackageContent } from "./package-discovery";
import type {
  GitHubAppCredentials,
  OAuthBearerCredentials,
  PluginBrokerDeps,
  PluginDefinition,
  OAuthProviderConfig,
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "./types";

// --- Sync phase: module-level initialization ---

const pluginDefinitions: PluginDefinition[] = [];
const capabilityToPlugin = new Map<string, PluginDefinition>();
const pluginConfigKeys = new Set<string>();
const pluginsByName = new Map<string, PluginDefinition>();
const packageSkillRoots = new Set<string>();

let pluginsLoaded = false;

function registerPluginManifest(raw: string, pluginDir: string): void {
  const manifest = parsePluginManifest(raw, pluginDir);

  if (pluginsByName.has(manifest.name)) {
    return;
  }

  for (const cap of manifest.capabilities) {
    if (capabilityToPlugin.has(cap)) {
      throw new Error(
        `Duplicate capability "${cap}" in plugin "${manifest.name}"`,
      );
    }
  }

  const definition: PluginDefinition = {
    manifest,
    dir: pluginDir,
    skillsDir: path.join(pluginDir, "skills"),
  };

  pluginDefinitions.push(definition);
  pluginsByName.set(manifest.name, definition);

  for (const cap of manifest.capabilities) {
    capabilityToPlugin.set(cap, definition);
  }
  for (const key of manifest.configKeys) {
    pluginConfigKeys.add(key);
  }
}

function loadPlugins(): void {
  if (pluginsLoaded) return;
  pluginsLoaded = true;

  const packagedContent = discoverInstalledPluginPackageContent();
  const localRoots = pluginRoots();
  const roots = [...localRoots, ...packagedContent.manifestRoots];
  for (const pluginsRoot of roots) {
    let entries: string[];
    let rootStat: ReturnType<typeof statSync>;
    try {
      rootStat = statSync(pluginsRoot);
    } catch (error) {
      logWarn(
        "plugin_root_read_failed",
        {},
        {
          "file.directory": pluginsRoot,
          "error.message":
            error instanceof Error ? error.message : String(error),
        },
        "Failed to read plugin root",
      );
      continue;
    }
    if (rootStat.isDirectory()) {
      const manifestPath = path.join(pluginsRoot, "plugin.yaml");
      let hasRootManifest = false;
      try {
        hasRootManifest = statSync(manifestPath).isFile();
      } catch {
        hasRootManifest = false;
      }
      if (hasRootManifest) {
        const rawRootManifest = readFileSync(manifestPath, "utf8");
        registerPluginManifest(rawRootManifest, pluginsRoot);
        continue;
      }
    }
    try {
      entries = readdirSync(pluginsRoot);
    } catch (error) {
      logWarn(
        "plugin_root_read_failed",
        {},
        {
          "file.directory": pluginsRoot,
          "error.message":
            error instanceof Error ? error.message : String(error),
        },
        "Failed to read plugin root",
      );
      continue;
    }

    for (const entry of entries.sort()) {
      const pluginDir = path.join(pluginsRoot, entry);
      try {
        const stat = statSync(pluginDir);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      const manifestPath = path.join(pluginDir, "plugin.yaml");
      let raw: string;
      try {
        raw = readFileSync(manifestPath, "utf8");
      } catch {
        continue; // No manifest — skip
      }

      registerPluginManifest(raw, pluginDir);
    }
  }

  for (const skillRoot of packagedContent.skillRoots) {
    packageSkillRoots.add(skillRoot);
  }

  logInfo(
    "plugins_loaded",
    {},
    {
      "file.directories": [...localRoots, ...packagedContent.manifestRoots],
      "app.plugin.count": pluginDefinitions.length,
      "app.plugin.names": pluginDefinitions
        .map((plugin) => plugin.manifest.name)
        .sort(),
      "app.plugin.package_skill_roots": [...packageSkillRoots].sort(),
    },
    "Loaded plugins",
  );
}

function ensurePluginsLoaded(): void {
  loadPlugins();
}

export function resetPluginRegistryForTests(): void {
  pluginDefinitions.length = 0;
  capabilityToPlugin.clear();
  pluginConfigKeys.clear();
  pluginsByName.clear();
  packageSkillRoots.clear();
  pluginsLoaded = false;
}

loadPlugins();

// --- Sync exports ---

export function getPluginCapabilityProviders(): CapabilityProviderDefinition[] {
  ensurePluginsLoaded();
  return pluginDefinitions.map((plugin) => ({
    provider: plugin.manifest.name,
    capabilities: [...plugin.manifest.capabilities],
    configKeys: [...plugin.manifest.configKeys],
    ...(plugin.manifest.target
      ? { target: { ...plugin.manifest.target } }
      : {}),
  }));
}

export function getPluginProviders(): PluginDefinition[] {
  ensurePluginsLoaded();
  return [...pluginDefinitions];
}

export function getPluginRuntimeDependencies(): PluginRuntimeDependency[] {
  ensurePluginsLoaded();
  const seen = new Set<string>();
  const deps: PluginRuntimeDependency[] = [];
  for (const plugin of pluginDefinitions) {
    for (const dep of plugin.manifest.runtimeDependencies ?? []) {
      const key =
        dep.type === "npm"
          ? `${dep.type}:${dep.package}:${dep.version}`
          : "package" in dep
            ? `${dep.type}:package:${dep.package}`
            : `${dep.type}:url:${dep.url}:${dep.sha256}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      deps.push(dep);
    }
  }

  return deps.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type.localeCompare(right.type);
    }
    const leftIdentity =
      "package" in left
        ? `package:${left.package}`
        : `url:${left.url}:${left.sha256}`;
    const rightIdentity =
      "package" in right
        ? `package:${right.package}`
        : `url:${right.url}:${right.sha256}`;
    if (leftIdentity !== rightIdentity) {
      return leftIdentity.localeCompare(rightIdentity);
    }
    if (left.type === "npm" && right.type === "npm") {
      return left.version.localeCompare(right.version);
    }
    return 0;
  });
}

export function getPluginRuntimePostinstall(): PluginRuntimePostinstallCommand[] {
  ensurePluginsLoaded();
  const commands: PluginRuntimePostinstallCommand[] = [];
  for (const plugin of pluginDefinitions) {
    for (const command of plugin.manifest.runtimePostinstall ?? []) {
      commands.push({
        cmd: command.cmd,
        ...(command.args ? { args: [...command.args] } : {}),
        ...(command.sudo !== undefined ? { sudo: command.sudo } : {}),
      });
    }
  }

  return commands;
}

export function getPluginOAuthConfig(
  provider: string,
): OAuthProviderConfig | undefined {
  ensurePluginsLoaded();
  const plugin = pluginsByName.get(provider);
  if (!plugin?.manifest.oauth) return undefined;
  const oauth = plugin.manifest.oauth;
  return {
    clientIdEnv: oauth.clientIdEnv,
    clientSecretEnv: oauth.clientSecretEnv,
    authorizeEndpoint: oauth.authorizeEndpoint,
    tokenEndpoint: oauth.tokenEndpoint,
    ...(oauth.scope ? { scope: oauth.scope } : {}),
    ...(oauth.authorizeParams
      ? { authorizeParams: { ...oauth.authorizeParams } }
      : {}),
    ...(oauth.tokenAuthMethod
      ? { tokenAuthMethod: oauth.tokenAuthMethod }
      : {}),
    ...(oauth.tokenExtraHeaders
      ? { tokenExtraHeaders: { ...oauth.tokenExtraHeaders } }
      : {}),
    callbackPath: `/api/oauth/callback/${plugin.manifest.name}`,
  };
}

export function getPluginSkillRoots(): string[] {
  ensurePluginsLoaded();
  return [
    ...new Set([
      ...pluginDefinitions.map((plugin) => plugin.skillsDir),
      ...packageSkillRoots,
    ]),
  ];
}

export function isPluginProvider(provider: string): boolean {
  ensurePluginsLoaded();
  return pluginsByName.has(provider);
}

export function isPluginCapability(capability: string): boolean {
  ensurePluginsLoaded();
  return capabilityToPlugin.has(capability);
}

export function isPluginConfigKey(key: string): boolean {
  ensurePluginsLoaded();
  return pluginConfigKeys.has(key);
}

// --- Broker creation ---

export function createPluginBroker(
  provider: string,
  deps: PluginBrokerDeps,
): CredentialBroker {
  ensurePluginsLoaded();
  const plugin = pluginsByName.get(provider);
  if (!plugin) {
    throw new Error(`Unknown plugin provider: "${provider}"`);
  }

  const { credentials, name } = plugin.manifest;
  if (!credentials) {
    throw new Error(`Provider "${name}" has no credentials configured`);
  }
  let broker: CredentialBroker;

  if (credentials.type === "oauth-bearer") {
    broker = createOAuthBearerBroker(plugin.manifest, credentials, deps);
  } else if (credentials.type === "github-app") {
    broker = createGitHubAppBroker(plugin.manifest, credentials);
  } else {
    throw new Error(`Unsupported credentials type for plugin "${name}"`);
  }

  setSpanAttributes({
    "app.plugin.name": name,
    "app.plugin.capabilities": plugin.manifest.capabilities,
    "app.plugin.has_oauth": Boolean(plugin.manifest.oauth),
  });

  return broker;
}
