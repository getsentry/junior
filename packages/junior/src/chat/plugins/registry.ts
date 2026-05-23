import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CapabilityProviderDefinition } from "@/chat/capabilities/catalog";
import type { CredentialBroker } from "@/chat/credentials/broker";
import { pluginRoots } from "@/chat/discovery";
import { logInfo, logWarn, setSpanAttributes } from "@/chat/logging";
import { createGitHubAppBroker } from "./auth/github-app-broker";
import { parsePluginManifest } from "./manifest";
import { createOAuthBearerBroker } from "./auth/oauth-bearer-broker";
import { createApiHeadersBroker } from "./auth/api-headers-broker";
import {
  discoverInstalledPluginPackageContent,
  type InstalledPluginPackageContent,
  normalizePluginPackageNames,
} from "./package-discovery";
import type {
  PluginBrokerDeps,
  PluginConfig,
  PluginDefinition,
  OAuthProviderConfig,
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
} from "./types";

interface LoadedPluginState {
  capabilityToPlugin: Map<string, PluginDefinition>;
  domainToPlugin: Map<string, string>;
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
let pluginConfig: PluginConfig | undefined;

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
    domainToPlugin: new Map(),
    pluginConfigKeys: new Set(),
    pluginsByName: new Map(),
    packageSkillRoots: new Set(),
  };
}

function providerDomains(manifest: PluginDefinition["manifest"]): string[] {
  return [
    ...new Set([
      ...(manifest.credentials?.domains ?? []),
      ...(manifest.domains ?? []),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

function registerPluginManifest(
  state: LoadedPluginState,
  raw: string,
  pluginDir: string,
): void {
  const manifest = parsePluginManifest(raw, pluginDir, pluginConfig);

  if (state.pluginsByName.has(manifest.name)) {
    throw new Error(`Duplicate plugin name "${manifest.name}"`);
  }

  for (const cap of manifest.capabilities) {
    if (state.capabilityToPlugin.has(cap)) {
      throw new Error(
        `Duplicate capability "${cap}" in plugin "${manifest.name}"`,
      );
    }
  }

  for (const domain of providerDomains(manifest)) {
    const owner = state.domainToPlugin.get(domain);
    if (owner) {
      throw new Error(
        `Duplicate provider domain "${domain}" in plugin "${manifest.name}" already declared by plugin "${owner}". Use plugins.manifests in PluginConfig to change one plugin's domains or credentials.`,
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
  for (const domain of providerDomains(manifest)) {
    state.domainToPlugin.set(domain, manifest.name);
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

function getPluginCatalogSource(): PluginCatalogSource {
  const packagedContent = discoverConfiguredPluginPackageContent();
  const localRoots = normalizePluginRoots(pluginRoots());
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
      pluginConfig: pluginConfig ?? {},
    }),
  };
}

function normalizePluginConfig(
  config: PluginConfig | undefined,
): PluginConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    packages: normalizePluginPackageNames(config.packages),
    ...(config.manifests
      ? { manifests: structuredClone(config.manifests) }
      : {}),
  };
}

function clonePluginConfig(
  config: PluginConfig | undefined,
): PluginConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    packages: [...(config.packages ?? [])],
    ...(config.manifests
      ? { manifests: structuredClone(config.manifests) }
      : {}),
  };
}

function discoverConfiguredPluginPackageContent(): InstalledPluginPackageContent {
  return discoverInstalledPluginPackageContent(process.cwd(), {
    packageNames: pluginConfig?.packages,
  });
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
          "exception.message":
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
          "exception.message":
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

  for (const name of Object.keys(pluginConfig?.manifests ?? {})) {
    if (!state.pluginsByName.has(name)) {
      throw new Error(
        `plugins.manifests.${name} does not match a loaded plugin`,
      );
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
        "app.file.skill_directory": plugin.skillsDir,
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

/** Set install-wide plugin configuration and return the previous value for rollback. */
export function setPluginConfig(
  config: PluginConfig | undefined,
): PluginConfig | undefined {
  const previousConfig = clonePluginConfig(pluginConfig);
  pluginConfig = normalizePluginConfig(config);
  return previousConfig;
}

/** Return installed plugin package content from the active plugin configuration. */
export function getPluginPackageContent(): InstalledPluginPackageContent {
  return discoverConfiguredPluginPackageContent();
}

/** Return the current plugin catalog signature used for cache invalidation. */
export function getPluginCatalogSignature(): string {
  return ensurePluginsLoaded().signature;
}

export function getPluginCapabilityProviders(): CapabilityProviderDefinition[] {
  const state = ensurePluginsLoaded();
  return state.pluginDefinitions.map((plugin) => ({
    provider: plugin.manifest.name,
    capabilities: [...plugin.manifest.capabilities],
    configKeys: [...plugin.manifest.configKeys],
    ...(plugin.manifest.target
      ? {
          target: {
            ...plugin.manifest.target,
            ...(plugin.manifest.target.commandFlags
              ? { commandFlags: [...plugin.manifest.target.commandFlags] }
              : {}),
          },
        }
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
  if (!credentials && !plugin.manifest.apiHeaders) {
    throw new Error(
      `Provider "${name}" has no credentials or API headers configured`,
    );
  }
  let broker: CredentialBroker;

  if (!credentials) {
    broker = createApiHeadersBroker(plugin.manifest);
  } else if (credentials.type === "oauth-bearer") {
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
