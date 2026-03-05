import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CapabilityProviderDefinition } from "@/chat/capabilities/catalog";
import type { OAuthProviderConfig } from "@/chat/capabilities/jr-rpc-command";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { pluginRoots } from "@/chat/home";
import { logInfo, logWarn, setSpanAttributes } from "@/chat/observability";
import { createGitHubAppBroker } from "./github-app-broker";
import { createOAuthBearerBroker } from "./oauth-bearer-broker";
import type { GitHubAppCredentials, OAuthBearerCredentials, PluginBrokerDeps, PluginCredentials, PluginDefinition, PluginManifest } from "./types";

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SHORT_CAPABILITY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const SHORT_CONFIG_KEY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;

function parseBaseCredentialFields(
  data: Record<string, unknown>,
  name: string
): { apiDomains: string[]; authTokenEnv: string; authTokenPlaceholder?: string } {
  const rawDomains = data["api-domains"];
  if (!Array.isArray(rawDomains) || rawDomains.length === 0 || !rawDomains.every((d) => typeof d === "string" && d.trim())) {
    throw new Error(`Plugin ${name} credentials.api-domains must be a non-empty array of strings`);
  }
  const authTokenEnv = data["auth-token-env"];
  if (typeof authTokenEnv !== "string" || !authTokenEnv.trim()) {
    throw new Error(`Plugin ${name} credentials.auth-token-env must be a non-empty string`);
  }
  const authTokenPlaceholderRaw = data["auth-token-placeholder"];
  if (
    authTokenPlaceholderRaw !== undefined &&
    (typeof authTokenPlaceholderRaw !== "string" || !authTokenPlaceholderRaw.trim())
  ) {
    throw new Error(`Plugin ${name} credentials.auth-token-placeholder must be a non-empty string when provided`);
  }
  return {
    apiDomains: rawDomains as string[],
    authTokenEnv,
    ...(typeof authTokenPlaceholderRaw === "string"
      ? { authTokenPlaceholder: authTokenPlaceholderRaw.trim() }
      : {})
  };
}

function parseCredentials(data: Record<string, unknown>, name: string): PluginCredentials {
  const type = data.type;
  if (type === "oauth-bearer") {
    const base = parseBaseCredentialFields(data, name);
    return { type: "oauth-bearer", ...base } satisfies OAuthBearerCredentials;
  }

  if (type === "github-app") {
    const base = parseBaseCredentialFields(data, name);
    const appIdEnv = data["app-id-env"];
    if (typeof appIdEnv !== "string" || !appIdEnv.trim()) {
      throw new Error(`Plugin ${name} credentials.app-id-env must be a non-empty string`);
    }
    const privateKeyEnv = data["private-key-env"];
    if (typeof privateKeyEnv !== "string" || !privateKeyEnv.trim()) {
      throw new Error(`Plugin ${name} credentials.private-key-env must be a non-empty string`);
    }
    const installationIdEnv = data["installation-id-env"];
    if (typeof installationIdEnv !== "string" || !installationIdEnv.trim()) {
      throw new Error(`Plugin ${name} credentials.installation-id-env must be a non-empty string`);
    }
    return { type: "github-app", ...base, appIdEnv, privateKeyEnv, installationIdEnv } satisfies GitHubAppCredentials;
  }

  throw new Error(`Plugin ${name} has unsupported credentials.type: "${type}"`);
}

function parseManifest(raw: string, dir: string): PluginManifest {
  const data = parseYaml(raw) as Record<string, unknown>;

  const name = data.name;
  if (typeof name !== "string" || !PLUGIN_NAME_RE.test(name)) {
    throw new Error(`Invalid plugin name in ${dir}: "${name}"`);
  }

  const description = data.description;
  if (typeof description !== "string" || !description.trim()) {
    throw new Error(`Invalid plugin description in ${dir}`);
  }

  // Capabilities are declared as short names (e.g. "issues.read") and
  // qualified with the plugin name prefix (e.g. "sentry.api").
  const rawCapabilities = data.capabilities;
  if (!Array.isArray(rawCapabilities) || rawCapabilities.length === 0) {
    throw new Error(`Plugin ${name} must declare at least one capability`);
  }
  const capabilities: string[] = [];
  for (const cap of rawCapabilities) {
    if (typeof cap !== "string" || !SHORT_CAPABILITY_RE.test(cap)) {
      throw new Error(`Invalid capability token "${cap}" in plugin ${name}`);
    }
    capabilities.push(`${name}.${cap}`);
  }

  // Config keys are declared as short names (e.g. "org") and
  // qualified with the plugin name prefix (e.g. "sentry.org").
  const rawConfigKeys = data["config-keys"];
  if (!Array.isArray(rawConfigKeys)) {
    throw new Error(`Plugin ${name} must declare config-keys`);
  }
  const configKeys: string[] = [];
  for (const key of rawConfigKeys) {
    if (typeof key !== "string" || !SHORT_CONFIG_KEY_RE.test(key)) {
      throw new Error(`Invalid config key "${key}" in plugin ${name}`);
    }
    configKeys.push(`${name}.${key}`);
  }

  const credentialsRaw = data.credentials;
  if (!credentialsRaw || typeof credentialsRaw !== "object" || Array.isArray(credentialsRaw)) {
    throw new Error(`Plugin ${name} must declare credentials`);
  }
  const credentials = parseCredentials(credentialsRaw as Record<string, unknown>, name);

  const manifest: PluginManifest = {
    name: name as string,
    description: description as string,
    capabilities,
    configKeys,
    credentials
  };

  const oauthRaw = data.oauth as Record<string, unknown> | undefined;
  if (oauthRaw) {
    const oauthFields = ["client-id-env", "client-secret-env", "authorize-endpoint", "token-endpoint", "scope"] as const;
    for (const field of oauthFields) {
      if (typeof oauthRaw[field] !== "string" || !(oauthRaw[field] as string).trim()) {
        throw new Error(`Plugin ${name} oauth.${field} must be a non-empty string`);
      }
    }
    manifest.oauth = {
      clientIdEnv: oauthRaw["client-id-env"] as string,
      clientSecretEnv: oauthRaw["client-secret-env"] as string,
      authorizeEndpoint: oauthRaw["authorize-endpoint"] as string,
      tokenEndpoint: oauthRaw["token-endpoint"] as string,
      scope: oauthRaw.scope as string
    };
  }

  const targetRaw = data.target as Record<string, unknown> | undefined;
  if (targetRaw) {
    if (targetRaw.type !== "repo") {
      throw new Error(`Plugin ${name} target.type must be "repo"`);
    }
    const rawConfigKey = targetRaw["config-key"];
    if (typeof rawConfigKey !== "string" || !rawConfigKey.trim()) {
      throw new Error(`Plugin ${name} target.config-key must be a non-empty string`);
    }
    const qualifiedKey = `${name}.${rawConfigKey}`;
    if (!configKeys.includes(qualifiedKey)) {
      throw new Error(`Plugin ${name} target.config-key "${rawConfigKey}" must be listed in config-keys`);
    }
    manifest.target = { type: "repo", configKey: qualifiedKey };
  }

  return manifest;
}

// --- Sync phase: module-level initialization ---

const pluginDefinitions: PluginDefinition[] = [];
const capabilityToPlugin = new Map<string, PluginDefinition>();
const pluginConfigKeys = new Set<string>();
const pluginsByName = new Map<string, PluginDefinition>();

let pluginsLoaded = false;

function loadPlugins(): void {
  if (pluginsLoaded) return;
  pluginsLoaded = true;

  const roots = pluginRoots();
  for (const pluginsRoot of roots) {
    let entries: string[];
    try {
      entries = readdirSync(pluginsRoot);
    } catch (error) {
      logWarn("plugin_root_read_failed", {}, {
        "file.directory": pluginsRoot,
        "error.message": error instanceof Error ? error.message : String(error)
      }, "Failed to read plugin root");
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

      const manifest = parseManifest(raw, pluginDir);

      if (pluginsByName.has(manifest.name)) {
        continue;
      }

      for (const cap of manifest.capabilities) {
        if (capabilityToPlugin.has(cap)) {
          throw new Error(`Duplicate capability "${cap}" in plugin "${manifest.name}"`);
        }
      }

      const definition: PluginDefinition = {
        manifest,
        dir: pluginDir,
        skillsDir: path.join(pluginDir, "skills")
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
  }

  logInfo(
    "plugins_loaded",
    {},
    {
      "file.directories": roots,
      "app.plugin.count": pluginDefinitions.length,
      "app.plugin.names": pluginDefinitions.map((plugin) => plugin.manifest.name).sort()
    },
    "Loaded plugins"
  );
}

loadPlugins();

// --- Sync exports ---

export function getPluginCapabilityProviders(): CapabilityProviderDefinition[] {
  return pluginDefinitions.map((plugin) => ({
    provider: plugin.manifest.name,
    capabilities: [...plugin.manifest.capabilities],
    configKeys: [...plugin.manifest.configKeys],
    ...(plugin.manifest.target ? { target: { ...plugin.manifest.target } } : {})
  }));
}

export function getPluginProviders(): PluginDefinition[] {
  return [...pluginDefinitions];
}

export function getPluginOAuthConfig(provider: string): OAuthProviderConfig | undefined {
  const plugin = pluginsByName.get(provider);
  if (!plugin?.manifest.oauth) return undefined;
  const oauth = plugin.manifest.oauth;
  return {
    clientIdEnv: oauth.clientIdEnv,
    clientSecretEnv: oauth.clientSecretEnv,
    authorizeEndpoint: oauth.authorizeEndpoint,
    tokenEndpoint: oauth.tokenEndpoint,
    scope: oauth.scope,
    callbackPath: `/api/oauth/callback/${plugin.manifest.name}`
  };
}

export function getPluginSkillRoots(): string[] {
  return pluginDefinitions.map((plugin) => plugin.skillsDir);
}

export function isPluginProvider(provider: string): boolean {
  return pluginsByName.has(provider);
}

export function isPluginCapability(capability: string): boolean {
  return capabilityToPlugin.has(capability);
}

export function isPluginConfigKey(key: string): boolean {
  return pluginConfigKeys.has(key);
}

// --- Broker creation ---

export function createPluginBroker(
  provider: string,
  deps: PluginBrokerDeps
): CredentialBroker {
  const plugin = pluginsByName.get(provider);
  if (!plugin) {
    throw new Error(`Unknown plugin provider: "${provider}"`);
  }

  const { credentials, name } = plugin.manifest;
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
    "app.plugin.has_oauth": Boolean(plugin.manifest.oauth)
  });

  return broker;
}
