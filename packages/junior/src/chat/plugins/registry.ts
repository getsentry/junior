import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CapabilityProviderDefinition } from "@/chat/capabilities/catalog";
import type { CredentialBroker } from "@/chat/credentials/broker";
import { pluginRoots } from "@/chat/discovery";
import { logInfo, logWarn, setSpanAttributes } from "@/chat/logging";
import { parseInlinePluginManifest, parsePluginManifest } from "./manifest";
import { createOAuthBearerBroker } from "./auth/oauth-bearer-broker";
import { createApiHeadersBroker } from "./auth/api-headers-broker";
import {
  discoverInstalledPluginPackageContent,
  type InstalledPluginPackageContent,
  normalizePluginPackageNames,
} from "./package-discovery";
import type {
  InlinePluginManifestDefinition,
  PluginBrokerDeps,
  PluginCatalogConfig,
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
  pluginMigrationRoots: Map<string, string>;
  pluginsByName: Map<string, PluginDefinition>;
  signature: string;
}

interface PluginCatalogSource {
  inlineManifests: InlinePluginManifestDefinition[];
  manifestRoots: string[];
  packagedSkillRoots: string[];
  packagedContent: InstalledPluginPackageContent;
  signature: string;
}

interface PluginCatalogRuntimeState {
  loadedPluginState?: LoadedPluginState;
  pluginConfig?: PluginCatalogConfig;
}

export interface PluginCatalogRuntime {
  createBroker(provider: string, deps: PluginBrokerDeps): CredentialBroker;
  getCapabilityProviders(): CapabilityProviderDefinition[];
  getDefinition(provider: string): PluginDefinition | undefined;
  getDisplayName(provider: string): string | undefined;
  getForSkillPath(skillPath: string): PluginDefinition | undefined;
  getMcpProviders(): PluginDefinition[];
  getMigrationRoots(): { dir: string; pluginName: string }[];
  getOAuthConfig(provider: string): OAuthProviderConfig | undefined;
  getPackageContent(): InstalledPluginPackageContent;
  getProviders(): PluginDefinition[];
  getRuntimeDependencies(): PluginRuntimeDependency[];
  getRuntimePostinstall(): PluginRuntimePostinstallCommand[];
  getSignature(): string;
  getSkillRoots(): string[];
  isCapability(capability: string): boolean;
  isConfigKey(key: string): boolean;
  isProvider(provider: string): boolean;
  parseConfiguredInlineManifest(
    manifest: InlinePluginManifestDefinition["manifest"],
    dir: string,
  ): PluginDefinition["manifest"];
  setConfig(
    config: PluginCatalogConfig | undefined,
  ): PluginCatalogConfig | undefined;
}

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
    pluginMigrationRoots: new Map(),
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
  manifest: PluginDefinition["manifest"],
  pluginDir: string,
  skillsDir?: string,
  migrationsDir?: string,
): void {
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
        `Duplicate provider domain "${domain}" in plugin "${manifest.name}" already declared by plugin "${owner}". Use plugins.manifests in PluginCatalogConfig to change one plugin's domains or credentials.`,
      );
    }
  }

  const definition: PluginDefinition = {
    manifest,
    dir: pluginDir,
    ...(migrationsDir ? { migrationsDir } : {}),
    ...(skillsDir ? { skillsDir } : {}),
  };

  state.pluginDefinitions.push(definition);
  state.pluginsByName.set(manifest.name, definition);
  if (definition.migrationsDir) {
    state.pluginMigrationRoots.set(manifest.name, definition.migrationsDir);
  }

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

function registerYamlPluginManifest(
  state: LoadedPluginState,
  raw: string,
  pluginDir: string,
  config: PluginCatalogConfig | undefined,
): void {
  const manifest = parsePluginManifest(raw, pluginDir, config);
  const candidateSkillsDir = path.join(pluginDir, "skills");
  const hasSkillsDir = (() => {
    try {
      return statSync(candidateSkillsDir).isDirectory();
    } catch {
      return false;
    }
  })();
  // Declarative manifests are manifest-only; code registrations claim migrations.
  registerPluginManifest(
    state,
    manifest,
    pluginDir,
    hasSkillsDir ? candidateSkillsDir : undefined,
  );
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

function getPluginCatalogSource(
  runtime: PluginCatalogRuntimeState,
): PluginCatalogSource {
  const packagedContent = discoverConfiguredPluginPackageContent(
    runtime.pluginConfig,
  );
  const localRoots = normalizePluginRoots(pluginRoots());
  const manifestRoots = normalizePluginRoots([
    ...localRoots,
    ...packagedContent.manifestRoots,
  ]);
  const packagedSkillRoots = normalizePluginRoots(packagedContent.skillRoots);

  const inlineManifests = runtime.pluginConfig?.inlineManifests ?? [];
  return {
    inlineManifests,
    manifestRoots,
    packagedSkillRoots,
    packagedContent,
    signature: JSON.stringify({
      inlineManifests,
      manifestRoots,
      packages: packagedContent.packages
        .map((pkg) => ({
          dir: path.resolve(pkg.dir),
          hasMigrationsDir: pkg.hasMigrationsDir,
          hasSkillsDir: pkg.hasSkillsDir,
          packageName: pkg.packageName,
        }))
        .sort((left, right) =>
          left.packageName.localeCompare(right.packageName),
        ),
      packagedSkillRoots,
      packageNames: [...packagedContent.packageNames].sort(),
      pluginConfig: runtime.pluginConfig ?? {},
    }),
  };
}

function normalizePluginCatalogConfig(
  config: PluginCatalogConfig | undefined,
): PluginCatalogConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    inlineManifests: config.inlineManifests
      ? structuredClone(config.inlineManifests)
      : undefined,
    packages: normalizePluginPackageNames(config.packages),
    ...(config.manifests
      ? { manifests: structuredClone(config.manifests) }
      : {}),
  };
}

function clonePluginCatalogConfig(
  config: PluginCatalogConfig | undefined,
): PluginCatalogConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    ...(config.inlineManifests
      ? { inlineManifests: structuredClone(config.inlineManifests) }
      : {}),
    packages: [...(config.packages ?? [])],
    ...(config.manifests
      ? { manifests: structuredClone(config.manifests) }
      : {}),
  };
}

function packageContentByName(
  packagedContent: InstalledPluginPackageContent,
  packageName: string,
):
  | { dir: string; hasMigrationsDir: boolean; hasSkillsDir: boolean }
  | undefined {
  return packagedContent.packages.find(
    (pkg) => pkg.packageName === packageName,
  );
}

function registerInlineManifests(
  state: LoadedPluginState,
  source: PluginCatalogSource,
  config: PluginCatalogConfig | undefined,
): void {
  const migrationOwners = new Map<string, string>();
  for (const definition of source.inlineManifests) {
    const pkg = definition.packageName
      ? packageContentByName(source.packagedContent, definition.packageName)
      : undefined;
    const dir = pkg?.dir ?? process.cwd();
    const skillsDir = pkg?.hasSkillsDir
      ? path.join(pkg.dir, "skills")
      : undefined;
    const migrationsDir =
      pkg?.hasMigrationsDir &&
      statSync(path.join(pkg.dir, "migrations"), {
        throwIfNoEntry: false,
      })?.isDirectory()
        ? path.join(pkg.dir, "migrations")
        : undefined;
    const manifest = parseInlinePluginManifest(
      definition.manifest,
      dir,
      config,
    );
    if (migrationsDir) {
      const owner = migrationOwners.get(migrationsDir);
      if (owner) {
        throw new Error(
          `Plugin "${manifest.name}" cannot share migrations directory with plugin "${owner}"`,
        );
      }
      migrationOwners.set(migrationsDir, manifest.name);
    }
    registerPluginManifest(state, manifest, dir, skillsDir, migrationsDir);
  }
}

function discoverConfiguredPluginPackageContent(
  config: PluginCatalogConfig | undefined,
): InstalledPluginPackageContent {
  return discoverInstalledPluginPackageContent(process.cwd(), {
    packageNames: config?.packages,
  });
}

function buildLoadedPluginState(
  source: PluginCatalogSource,
  config: PluginCatalogConfig | undefined,
): LoadedPluginState {
  const state = createLoadedPluginState(source.signature);

  for (const skillRoot of source.packagedSkillRoots) {
    state.packageSkillRoots.add(skillRoot);
  }

  registerInlineManifests(state, source, config);

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
        registerYamlPluginManifest(state, rawRootManifest, pluginsRoot, config);
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

      registerYamlPluginManifest(state, raw, pluginDir, config);
    }
  }

  for (const name of Object.keys(config?.manifests ?? {})) {
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
        ...(plugin.skillsDir
          ? { "app.file.skill_directory": plugin.skillsDir }
          : {}),
      },
      "Loaded plugin",
    );
  }
}

function ensurePluginsLoaded(
  runtime: PluginCatalogRuntimeState,
): LoadedPluginState {
  const source = getPluginCatalogSource(runtime);
  if (runtime.loadedPluginState?.signature === source.signature) {
    return runtime.loadedPluginState;
  }

  const state = buildLoadedPluginState(source, runtime.pluginConfig);
  runtime.loadedPluginState = state;
  logLoadedPlugins(state);
  return state;
}

/** Create an isolated plugin catalog runtime for explicit app wiring. */
export function createPluginCatalogRuntime(): PluginCatalogRuntime {
  const runtime: PluginCatalogRuntimeState = {};
  return {
    setConfig(config) {
      const previousConfig = clonePluginCatalogConfig(runtime.pluginConfig);
      runtime.pluginConfig = normalizePluginCatalogConfig(config);
      return previousConfig;
    },
    parseConfiguredInlineManifest(manifest, dir) {
      return parseInlinePluginManifest(manifest, dir, runtime.pluginConfig);
    },
    getPackageContent() {
      return discoverConfiguredPluginPackageContent(runtime.pluginConfig);
    },
    getSignature() {
      return ensurePluginsLoaded(runtime).signature;
    },
    getCapabilityProviders() {
      const state = ensurePluginsLoaded(runtime);
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
    },
    getProviders() {
      return [...ensurePluginsLoaded(runtime).pluginDefinitions];
    },
    getMigrationRoots() {
      const state = ensurePluginsLoaded(runtime);
      return [...state.pluginMigrationRoots.entries()]
        .map(([pluginName, dir]) => ({ pluginName, dir }))
        .sort((left, right) => left.pluginName.localeCompare(right.pluginName));
    },
    getMcpProviders() {
      return ensurePluginsLoaded(runtime).pluginDefinitions.filter((plugin) =>
        Boolean(plugin.manifest.mcp),
      );
    },
    getRuntimeDependencies() {
      const state = ensurePluginsLoaded(runtime);
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
    },
    getRuntimePostinstall() {
      const state = ensurePluginsLoaded(runtime);
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
    },
    getOAuthConfig(provider) {
      const plugin = ensurePluginsLoaded(runtime).pluginsByName.get(provider);
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
        ...(oauth.treatEmptyScopeAsUnreported
          ? { treatEmptyScopeAsUnreported: true }
          : {}),
        callbackPath: `/api/oauth/callback/${plugin.manifest.name}`,
      };
    },
    getSkillRoots() {
      const state = ensurePluginsLoaded(runtime);
      return [
        ...new Set([
          ...state.pluginDefinitions.flatMap((plugin) =>
            plugin.skillsDir ? [plugin.skillsDir] : [],
          ),
          ...state.packageSkillRoots,
        ]),
      ];
    },
    getForSkillPath(skillPath) {
      const state = ensurePluginsLoaded(runtime);
      const resolvedSkillPath = path.resolve(skillPath);

      return state.pluginDefinitions.find((plugin) => {
        if (!plugin.skillsDir) {
          return false;
        }
        const resolvedSkillsDir = path.resolve(plugin.skillsDir);
        return (
          resolvedSkillPath === resolvedSkillsDir ||
          resolvedSkillPath.startsWith(`${resolvedSkillsDir}${path.sep}`)
        );
      });
    },
    getDefinition(provider) {
      return ensurePluginsLoaded(runtime).pluginsByName.get(provider);
    },
    getDisplayName(provider) {
      return ensurePluginsLoaded(runtime).pluginsByName.get(provider)?.manifest
        .displayName;
    },
    isProvider(provider) {
      return ensurePluginsLoaded(runtime).pluginsByName.has(provider);
    },
    isCapability(capability) {
      return ensurePluginsLoaded(runtime).capabilityToPlugin.has(capability);
    },
    isConfigKey(key) {
      return ensurePluginsLoaded(runtime).pluginConfigKeys.has(key);
    },
    createBroker(provider, deps) {
      const plugin = ensurePluginsLoaded(runtime).pluginsByName.get(provider);
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
      } else {
        broker = createOAuthBearerBroker(plugin.manifest, credentials, deps);
      }

      setSpanAttributes({
        "app.plugin.name": name,
        "app.plugin.capabilities": plugin.manifest.capabilities,
        "app.plugin.has_oauth": Boolean(plugin.manifest.oauth),
      });

      return broker;
    },
  };
}
