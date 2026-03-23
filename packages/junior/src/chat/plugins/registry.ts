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

interface LoadedPluginState {
  capabilityToPlugin: Map<string, PluginDefinition>;
  packageSkillRoots: Set<string>;
  pluginConfigKeys: Set<string>;
  pluginDefinitions: PluginDefinition[];
  pluginsByName: Map<string, PluginDefinition>;
  signature: string;
}

interface PluginCatalogSource {
  manifestRoots: string[];
  packagedSkillRoots: string[];
  signature: string;
}

let loadedPluginState: LoadedPluginState | undefined;

function getLoggedPluginNames(): Set<string> {
  const globalState = globalThis as typeof globalThis & {
    __juniorLoggedPluginNames?: Set<string>;
  };
  globalState.__juniorLoggedPluginNames ??= new Set<string>();
  return globalState.__juniorLoggedPluginNames;
}

function createLoadedPluginState(signature: string): LoadedPluginState {
  return {
    signature,
    pluginDefinitions: [],
    capabilityToPlugin: new Map(),
    pluginConfigKeys: new Set(),
    pluginsByName: new Map(),
    packageSkillRoots: new Set(),
  };
}

function registerPluginManifest(
  state: LoadedPluginState,
  raw: string,
  pluginDir: string,
): void {
  const manifest = parsePluginManifest(raw, pluginDir);

  if (state.pluginsByName.has(manifest.name)) {
    return;
  }

  for (const cap of manifest.capabilities) {
    if (state.capabilityToPlugin.has(cap)) {
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

  state.pluginDefinitions.push(definition);
  state.pluginsByName.set(manifest.name, definition);

  for (const cap of manifest.capabilities) {
    state.capabilityToPlugin.set(cap, definition);
  }
  for (const key of manifest.configKeys) {
    state.pluginConfigKeys.add(key);
  }
}

function normalizePluginRoots(roots: string[]): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const normalized = path.resolve(root);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    resolved.push(normalized);
  }

  return resolved;
}

function getExtraPluginRoots(): string[] {
  const raw = process.env.JUNIOR_EXTRA_PLUGIN_ROOTS?.trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return normalizePluginRoots(
          parsed.filter((value): value is string => typeof value === "string"),
        );
      }
    } catch {
      return [];
    }
  }

  return normalizePluginRoots(
    raw
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function getPluginCatalogSource(): PluginCatalogSource {
  const packagedContent = discoverInstalledPluginPackageContent();
  const localRoots = normalizePluginRoots([
    ...pluginRoots(),
    ...getExtraPluginRoots(),
  ]);
  const manifestRoots = normalizePluginRoots([
    ...localRoots,
    ...packagedContent.manifestRoots,
  ]);
  const packagedSkillRoots = normalizePluginRoots(packagedContent.skillRoots);

  return {
    manifestRoots,
    packagedSkillRoots,
    signature: JSON.stringify({
      manifestRoots,
      packagedSkillRoots,
      packageNames: [...packagedContent.packageNames].sort(),
    }),
  };
}

function buildLoadedPluginState(
  source: PluginCatalogSource,
): LoadedPluginState {
  const state = createLoadedPluginState(source.signature);

  for (const skillRoot of source.packagedSkillRoots) {
    state.packageSkillRoots.add(skillRoot);
  }

  const roots = source.manifestRoots;
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
        registerPluginManifest(state, rawRootManifest, pluginsRoot);
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

      registerPluginManifest(state, raw, pluginDir);
    }
  }

  return state;
}

function logLoadedPlugins(state: LoadedPluginState): void {
  const loggedPluginNames = getLoggedPluginNames();
  for (const plugin of [...state.pluginDefinitions].sort((left, right) =>
    left.manifest.name.localeCompare(right.manifest.name),
  )) {
    if (loggedPluginNames.has(plugin.manifest.name)) {
      continue;
    }
    loggedPluginNames.add(plugin.manifest.name);
    logInfo(
      "plugin_loaded",
      {},
      {
        "app.plugin.name": plugin.manifest.name,
        "app.plugin.capability_count": plugin.manifest.capabilities.length,
        "app.plugin.config_key_count": plugin.manifest.configKeys.length,
        "app.plugin.has_mcp": Boolean(plugin.manifest.mcp),
        "file.directory": plugin.dir,
        "file.skill_directory": plugin.skillsDir,
      },
      "Loaded plugin",
    );
  }
}

function ensurePluginsLoaded(): LoadedPluginState {
  const source = getPluginCatalogSource();
  if (loadedPluginState?.signature === source.signature) {
    return loadedPluginState;
  }

  const state = buildLoadedPluginState(source);
  loadedPluginState = state;
  logLoadedPlugins(state);
  return state;
}

// --- Sync exports ---

export function getPluginCapabilityProviders(): CapabilityProviderDefinition[] {
  const state = ensurePluginsLoaded();
  return state.pluginDefinitions.map((plugin) => ({
    provider: plugin.manifest.name,
    capabilities: [...plugin.manifest.capabilities],
    configKeys: [...plugin.manifest.configKeys],
    ...(plugin.manifest.target
      ? { target: { ...plugin.manifest.target } }
      : {}),
  }));
}

export function getPluginProviders(): PluginDefinition[] {
  return [...ensurePluginsLoaded().pluginDefinitions];
}

export function getPluginMcpProviders(): PluginDefinition[] {
  return ensurePluginsLoaded().pluginDefinitions.filter((plugin) =>
    Boolean(plugin.manifest.mcp),
  );
}

export function getPluginRuntimeDependencies(): PluginRuntimeDependency[] {
  const state = ensurePluginsLoaded();
  const seen = new Set<string>();
  const deps: PluginRuntimeDependency[] = [];
  for (const plugin of state.pluginDefinitions) {
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
  const state = ensurePluginsLoaded();
  const commands: PluginRuntimePostinstallCommand[] = [];
  for (const plugin of state.pluginDefinitions) {
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
  const plugin = ensurePluginsLoaded().pluginsByName.get(provider);
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
  const state = ensurePluginsLoaded();
  return [
    ...new Set([
      ...state.pluginDefinitions.map((plugin) => plugin.skillsDir),
      ...state.packageSkillRoots,
    ]),
  ];
}

export function getPluginForSkillPath(
  skillPath: string,
): PluginDefinition | undefined {
  const state = ensurePluginsLoaded();
  const resolvedSkillPath = path.resolve(skillPath);

  return state.pluginDefinitions.find((plugin) => {
    const resolvedSkillsDir = path.resolve(plugin.skillsDir);
    return (
      resolvedSkillPath === resolvedSkillsDir ||
      resolvedSkillPath.startsWith(`${resolvedSkillsDir}${path.sep}`)
    );
  });
}

export function getPluginDefinition(
  provider: string,
): PluginDefinition | undefined {
  return ensurePluginsLoaded().pluginsByName.get(provider);
}

export function isPluginProvider(provider: string): boolean {
  return ensurePluginsLoaded().pluginsByName.has(provider);
}

export function isPluginCapability(capability: string): boolean {
  return ensurePluginsLoaded().capabilityToPlugin.has(capability);
}

export function isPluginConfigKey(key: string): boolean {
  return ensurePluginsLoaded().pluginConfigKeys.has(key);
}

// --- Broker creation ---

export function createPluginBroker(
  provider: string,
  deps: PluginBrokerDeps,
): CredentialBroker {
  const plugin = ensurePluginsLoaded().pluginsByName.get(provider);
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
