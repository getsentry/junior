import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { CapabilityProviderDefinition } from "@/chat/capabilities/catalog";
import type { CredentialBroker } from "@/chat/credentials/broker";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { pluginRoots } from "@/chat/home";
import { logInfo, logWarn, setSpanAttributes } from "@/chat/observability";
import { createGitHubAppBroker } from "./github-app-broker";
import { createOAuthBearerBroker } from "./oauth-bearer-broker";
import { discoverInstalledPluginPackageContent } from "./package-discovery";
import type {
  GitHubAppCredentials,
  OAuthBearerCredentials,
  PluginBrokerDeps,
  PluginCredentials,
  PluginDefinition,
  PluginManifest,
  PluginNpmRuntimeDependency,
  OAuthProviderConfig,
  PluginRuntimePostinstallCommand,
  PluginSystemRuntimeDependencyFromUrl,
  PluginSystemRuntimeDependency,
  PluginRuntimeDependency,
} from "./types";

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SHORT_CAPABILITY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const SHORT_CONFIG_KEY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const AUTH_TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const API_DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUNTIME_POSTINSTALL_CMD_RE = /^[A-Za-z0-9._/-]+$/;
const RESERVED_AUTHORIZE_PARAM_KEYS = new Set([
  "client_id",
  "scope",
  "state",
  "redirect_uri",
  "response_type",
]);
const FORBIDDEN_API_HEADER_NAMES = new Set(["authorization"]);
const FORBIDDEN_TOKEN_HEADER_NAMES = new Set(["authorization"]);

function toRecord(
  value: unknown,
  errorMessage: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

function requireStringField(
  record: Record<string, unknown>,
  field: string,
  errorMessage: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(errorMessage);
  }
  return value.trim();
}

function requireEnvVarField(
  record: Record<string, unknown>,
  field: string,
  pluginName: string,
): string {
  const value = requireStringField(
    record,
    field,
    `Plugin ${pluginName} ${field} must be a non-empty string`,
  );
  if (!AUTH_TOKEN_ENV_RE.test(value)) {
    throw new Error(
      `Plugin ${pluginName} ${field} must be an uppercase env var name`,
    );
  }
  return value;
}

function requireHttpsUrlField(
  record: Record<string, unknown>,
  field: string,
  pluginName: string,
): string {
  const value = requireStringField(
    record,
    field,
    `Plugin ${pluginName} oauth.${field} must be a non-empty string`,
  );
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Plugin ${pluginName} oauth.${field} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Plugin ${pluginName} oauth.${field} must use https`);
  }
  return value;
}

function normalizeApiDomain(rawDomain: unknown, name: string): string {
  const domain =
    typeof rawDomain === "string" ? rawDomain.trim().toLowerCase() : "";
  if (!domain) {
    throw new Error(
      `Plugin ${name} credentials.api-domains entries must be non-empty strings`,
    );
  }
  if (!API_DOMAIN_RE.test(domain)) {
    throw new Error(
      `Plugin ${name} credentials.api-domains entries must be valid domain names`,
    );
  }
  return domain;
}

function parseStringMap(
  data: unknown,
  errorLabel: string,
  options: { reservedKeys?: Set<string>; forbiddenKeys?: Set<string> } = {},
): Record<string, string> | undefined {
  if (data === undefined) {
    return undefined;
  }
  const record = toRecord(
    data,
    `${errorLabel} must be an object when provided`,
  );
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (!key) {
      throw new Error(`${errorLabel} keys must be non-empty strings`);
    }
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      throw new Error(`${errorLabel}.${key} must be a non-empty string`);
    }
    const normalizedKey = key.toLowerCase();
    if (options.reservedKeys?.has(normalizedKey)) {
      throw new Error(`${errorLabel}.${key} is reserved by the runtime`);
    }
    if (options.forbiddenKeys?.has(normalizedKey)) {
      throw new Error(`${errorLabel}.${key} is not allowed`);
    }
    if (seen.has(normalizedKey)) {
      throw new Error(`${errorLabel}.${key} is duplicated`);
    }
    seen.add(normalizedKey);
    result[key] = rawValue.trim();
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseBaseCredentialFields(
  data: Record<string, unknown>,
  name: string,
): {
  apiDomains: string[];
  apiHeaders?: Record<string, string>;
  authTokenEnv: string;
  authTokenPlaceholder?: string;
} {
  const rawDomains = data["api-domains"];
  if (!Array.isArray(rawDomains) || rawDomains.length === 0) {
    throw new Error(
      `Plugin ${name} credentials.api-domains must be a non-empty array of strings`,
    );
  }
  const apiDomains = rawDomains.map((rawDomain) =>
    normalizeApiDomain(rawDomain, name),
  );
  const apiHeaders = parseStringMap(
    data["api-headers"],
    `Plugin ${name} credentials.api-headers`,
    { forbiddenKeys: FORBIDDEN_API_HEADER_NAMES },
  );
  const authTokenEnv = requireEnvVarField(data, "auth-token-env", name);
  const authTokenPlaceholderRaw = data["auth-token-placeholder"];
  if (
    authTokenPlaceholderRaw !== undefined &&
    (typeof authTokenPlaceholderRaw !== "string" ||
      !authTokenPlaceholderRaw.trim())
  ) {
    throw new Error(
      `Plugin ${name} credentials.auth-token-placeholder must be a non-empty string when provided`,
    );
  }
  return {
    apiDomains,
    ...(apiHeaders ? { apiHeaders } : {}),
    authTokenEnv,
    ...(typeof authTokenPlaceholderRaw === "string"
      ? { authTokenPlaceholder: authTokenPlaceholderRaw.trim() }
      : {}),
  };
}

function parseCredentials(
  data: Record<string, unknown>,
  name: string,
): PluginCredentials {
  const type = data.type;
  if (type === "oauth-bearer") {
    const base = parseBaseCredentialFields(data, name);
    return { type: "oauth-bearer", ...base } satisfies OAuthBearerCredentials;
  }

  if (type === "github-app") {
    const base = parseBaseCredentialFields(data, name);
    const appIdEnv = requireEnvVarField(data, "app-id-env", name);
    const privateKeyEnv = requireEnvVarField(data, "private-key-env", name);
    const installationIdEnv = requireEnvVarField(
      data,
      "installation-id-env",
      name,
    );
    return {
      type: "github-app",
      ...base,
      appIdEnv,
      privateKeyEnv,
      installationIdEnv,
    } satisfies GitHubAppCredentials;
  }

  throw new Error(`Plugin ${name} has unsupported credentials.type: "${type}"`);
}

function parseRuntimeDependencies(
  data: unknown,
  name: string,
): PluginRuntimeDependency[] | undefined {
  if (data === undefined) {
    return undefined;
  }

  if (!Array.isArray(data)) {
    throw new Error(`Plugin ${name} runtime-dependencies must be an array`);
  }

  const parsed: PluginRuntimeDependency[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Plugin ${name} runtime-dependencies entries must be objects`,
      );
    }

    const record = entry as Record<string, unknown>;
    const type = record.type;
    const packageName = record.package;
    const packageUrl = record.url;
    const version = record.version;
    const sha256 = record.sha256;
    if (typeof type !== "string" || (type !== "npm" && type !== "system")) {
      throw new Error(
        `Plugin ${name} runtime dependency type must be "npm" or "system"`,
      );
    }
    const normalizedPackage =
      typeof packageName === "string" ? packageName.trim() : "";
    const normalizedUrl =
      typeof packageUrl === "string" ? packageUrl.trim() : "";
    if (type === "npm") {
      if (!normalizedPackage) {
        throw new Error(
          `Plugin ${name} runtime dependency package must be a non-empty string`,
        );
      }
      if (packageUrl !== undefined || sha256 !== undefined) {
        throw new Error(
          `Plugin ${name} npm runtime dependencies must only include package/version fields`,
        );
      }
      const normalizedVersion =
        typeof version === "string" ? version.trim() : "latest";
      if (!normalizedVersion) {
        throw new Error(
          `Plugin ${name} runtime dependency version must be a non-empty string when provided`,
        );
      }
      const dedupeKey = `${type}:${normalizedPackage}:${normalizedVersion}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      parsed.push({
        type: "npm",
        package: normalizedPackage,
        version: normalizedVersion,
      } satisfies PluginNpmRuntimeDependency);
      continue;
    }

    if (version !== undefined) {
      throw new Error(
        `Plugin ${name} system runtime dependencies must not include a version`,
      );
    }

    if (normalizedPackage && normalizedUrl) {
      throw new Error(
        `Plugin ${name} system runtime dependencies must specify either package or url, not both`,
      );
    }
    if (!normalizedPackage && !normalizedUrl) {
      throw new Error(
        `Plugin ${name} system runtime dependencies must specify package or url`,
      );
    }

    if (normalizedPackage) {
      if (sha256 !== undefined) {
        throw new Error(
          `Plugin ${name} system runtime dependency package entries must not include sha256`,
        );
      }
      const dedupeKey = `${type}:package:${normalizedPackage}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      parsed.push({
        type: "system",
        package: normalizedPackage,
      } satisfies PluginSystemRuntimeDependency);
      continue;
    }

    if (!/^https:\/\//i.test(normalizedUrl)) {
      throw new Error(
        `Plugin ${name} system runtime dependency url must be an https URL`,
      );
    }
    const normalizedSha256 =
      typeof sha256 === "string" ? sha256.trim().toLowerCase() : "";
    if (!/^[a-f0-9]{64}$/.test(normalizedSha256)) {
      throw new Error(
        `Plugin ${name} system runtime dependency url entries must include a valid sha256`,
      );
    }
    const dedupeKey = `${type}:url:${normalizedUrl}:${normalizedSha256}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    parsed.push({
      type: "system",
      url: normalizedUrl,
      sha256: normalizedSha256,
    } satisfies PluginSystemRuntimeDependencyFromUrl);
  }

  return parsed.length > 0 ? parsed : undefined;
}

function parseRuntimePostinstall(
  data: unknown,
  name: string,
): PluginRuntimePostinstallCommand[] | undefined {
  if (data === undefined) {
    return undefined;
  }

  if (!Array.isArray(data)) {
    throw new Error(`Plugin ${name} runtime-postinstall must be an array`);
  }

  const parsed: PluginRuntimePostinstallCommand[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `Plugin ${name} runtime-postinstall entries must be objects`,
      );
    }
    const record = entry as Record<string, unknown>;
    const cmd = typeof record.cmd === "string" ? record.cmd.trim() : "";
    if (!cmd) {
      throw new Error(
        `Plugin ${name} runtime-postinstall cmd must be a non-empty string`,
      );
    }
    if (!RUNTIME_POSTINSTALL_CMD_RE.test(cmd)) {
      throw new Error(
        `Plugin ${name} runtime-postinstall cmd must be a single executable token (letters, digits, ., _, /, -)`,
      );
    }

    const argsRaw = record.args;
    if (
      argsRaw !== undefined &&
      (!Array.isArray(argsRaw) ||
        !argsRaw.every((arg) => typeof arg === "string"))
    ) {
      throw new Error(
        `Plugin ${name} runtime-postinstall args must be an array of strings when provided`,
      );
    }

    const sudoRaw = record.sudo;
    if (sudoRaw !== undefined && typeof sudoRaw !== "boolean") {
      throw new Error(
        `Plugin ${name} runtime-postinstall sudo must be a boolean when provided`,
      );
    }

    const normalizedArgs = Array.isArray(argsRaw)
      ? argsRaw.map((arg) => arg.trim()).filter((arg) => arg.length > 0)
      : undefined;

    parsed.push({
      cmd,
      ...(normalizedArgs && normalizedArgs.length > 0
        ? { args: normalizedArgs }
        : {}),
      ...(typeof sudoRaw === "boolean" ? { sudo: sudoRaw } : {}),
    });
  }

  return parsed.length > 0 ? parsed : undefined;
}

function parseManifest(raw: string, dir: string): PluginManifest {
  const data = toRecord(
    parseYaml(raw),
    `Invalid plugin manifest in ${dir}: expected an object`,
  );

  const rawName = data.name;
  if (typeof rawName !== "string" || !PLUGIN_NAME_RE.test(rawName)) {
    throw new Error(`Invalid plugin name in ${dir}: "${rawName}"`);
  }
  const name = rawName;

  const rawDescription = data.description;
  if (typeof rawDescription !== "string" || !rawDescription.trim()) {
    throw new Error(`Invalid plugin description in ${dir}`);
  }
  const description = rawDescription;

  // Capabilities are declared as short names (e.g. "issues.read") and
  // qualified with the plugin name prefix (e.g. "sentry.api").
  const rawCapabilities = data.capabilities;
  if (rawCapabilities !== undefined && !Array.isArray(rawCapabilities)) {
    throw new Error(
      `Plugin ${name} capabilities must be an array when provided`,
    );
  }
  const capabilities: string[] = [];
  for (const cap of rawCapabilities ?? []) {
    if (typeof cap !== "string" || !SHORT_CAPABILITY_RE.test(cap)) {
      throw new Error(`Invalid capability token "${cap}" in plugin ${name}`);
    }
    capabilities.push(`${name}.${cap}`);
  }

  // Config keys are declared as short names (e.g. "org") and
  // qualified with the plugin name prefix (e.g. "sentry.org").
  const rawConfigKeys = data["config-keys"];
  if (rawConfigKeys !== undefined && !Array.isArray(rawConfigKeys)) {
    throw new Error(
      `Plugin ${name} config-keys must be an array when provided`,
    );
  }
  const configKeys: string[] = [];
  for (const key of rawConfigKeys ?? []) {
    if (typeof key !== "string" || !SHORT_CONFIG_KEY_RE.test(key)) {
      throw new Error(`Invalid config key "${key}" in plugin ${name}`);
    }
    configKeys.push(`${name}.${key}`);
  }

  const credentialsRaw = data.credentials;
  if (credentialsRaw !== undefined) {
    toRecord(
      credentialsRaw,
      `Plugin ${name} credentials must be an object when provided`,
    );
  }
  const credentials = credentialsRaw
    ? parseCredentials(credentialsRaw as Record<string, unknown>, name)
    : undefined;

  const runtimeDependencies = parseRuntimeDependencies(
    data["runtime-dependencies"],
    name,
  );
  const runtimePostinstall = parseRuntimePostinstall(
    data["runtime-postinstall"],
    name,
  );

  const manifest: PluginManifest = {
    name,
    description,
    capabilities,
    configKeys,
    ...(credentials ? { credentials } : {}),
    ...(runtimeDependencies ? { runtimeDependencies } : {}),
    ...(runtimePostinstall ? { runtimePostinstall } : {}),
  };

  const oauthRaw = data.oauth
    ? toRecord(data.oauth, `Plugin ${name} oauth must be an object`)
    : undefined;
  if (oauthRaw) {
    if (!credentials) {
      throw new Error(`Plugin ${name} oauth requires credentials`);
    }
    if (credentials.type !== "oauth-bearer") {
      throw new Error(
        `Plugin ${name} oauth requires credentials.type "oauth-bearer"`,
      );
    }
    const authorizeParams = parseStringMap(
      oauthRaw["authorize-params"],
      `Plugin ${name} oauth.authorize-params`,
      { reservedKeys: RESERVED_AUTHORIZE_PARAM_KEYS },
    );
    const tokenExtraHeaders = parseStringMap(
      oauthRaw["token-extra-headers"],
      `Plugin ${name} oauth.token-extra-headers`,
      { forbiddenKeys: FORBIDDEN_TOKEN_HEADER_NAMES },
    );
    const tokenAuthMethodRaw = oauthRaw["token-auth-method"];
    let tokenAuthMethod: "body" | "basic" | undefined;
    if (tokenAuthMethodRaw !== undefined) {
      const parsedTokenAuthMethod = requireStringField(
        oauthRaw,
        "token-auth-method",
        `Plugin ${name} oauth.token-auth-method must be a non-empty string`,
      );
      if (
        parsedTokenAuthMethod !== "body" &&
        parsedTokenAuthMethod !== "basic"
      ) {
        throw new Error(
          `Plugin ${name} oauth.token-auth-method must be "body" or "basic"`,
        );
      }
      tokenAuthMethod = parsedTokenAuthMethod;
    }
    manifest.oauth = {
      clientIdEnv: requireEnvVarField(oauthRaw, "client-id-env", name),
      clientSecretEnv: requireEnvVarField(oauthRaw, "client-secret-env", name),
      authorizeEndpoint: requireHttpsUrlField(
        oauthRaw,
        "authorize-endpoint",
        name,
      ),
      tokenEndpoint: requireHttpsUrlField(oauthRaw, "token-endpoint", name),
      ...(oauthRaw.scope !== undefined
        ? {
            scope: requireStringField(
              oauthRaw,
              "scope",
              `Plugin ${name} oauth.scope must be a non-empty string`,
            ),
          }
        : {}),
      ...(authorizeParams ? { authorizeParams } : {}),
      ...(tokenAuthMethod ? { tokenAuthMethod } : {}),
      ...(tokenExtraHeaders ? { tokenExtraHeaders } : {}),
    };
  }

  const targetRaw = data.target
    ? toRecord(data.target, `Plugin ${name} target must be an object`)
    : undefined;
  if (targetRaw) {
    if (targetRaw.type !== "repo") {
      throw new Error(`Plugin ${name} target.type must be "repo"`);
    }
    const rawConfigKey = targetRaw["config-key"];
    if (typeof rawConfigKey !== "string" || !rawConfigKey.trim()) {
      throw new Error(
        `Plugin ${name} target.config-key must be a non-empty string`,
      );
    }
    if (!SHORT_CONFIG_KEY_RE.test(rawConfigKey)) {
      throw new Error(
        `Plugin ${name} target.config-key "${rawConfigKey}" is invalid`,
      );
    }
    const qualifiedKey = `${name}.${rawConfigKey}`;
    if (!configKeys.includes(qualifiedKey)) {
      throw new Error(
        `Plugin ${name} target.config-key "${rawConfigKey}" must be listed in config-keys`,
      );
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
const packageSkillRoots = new Set<string>();

let pluginsLoaded = false;

function registerPluginManifest(raw: string, pluginDir: string): void {
  const manifest = parseManifest(raw, pluginDir);

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

loadPlugins();

// --- Sync exports ---

export function getPluginCapabilityProviders(): CapabilityProviderDefinition[] {
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
  return [...pluginDefinitions];
}

export function getPluginRuntimeDependencies(): PluginRuntimeDependency[] {
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
  return [
    ...new Set([
      ...pluginDefinitions.map((plugin) => plugin.skillsDir),
      ...packageSkillRoots,
    ]),
  ];
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
  deps: PluginBrokerDeps,
): CredentialBroker {
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
