import { parse as parseYaml } from "yaml";
import type {
  GitHubAppCredentials,
  OAuthBearerCredentials,
  PluginCredentials,
  PluginManifest,
  PluginNpmRuntimeDependency,
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
  PluginSystemRuntimeDependency,
  PluginSystemRuntimeDependencyFromUrl
} from "./types";

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SHORT_CAPABILITY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const SHORT_CONFIG_KEY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const AUTH_TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const API_DOMAIN_RE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUNTIME_POSTINSTALL_CMD_RE = /^[A-Za-z0-9._/-]+$/;
const RESERVED_AUTHORIZE_PARAM_KEYS = new Set(["client_id", "scope", "state", "redirect_uri", "response_type"]);
const FORBIDDEN_API_HEADER_NAMES = new Set(["authorization"]);
const FORBIDDEN_TOKEN_HEADER_NAMES = new Set(["authorization"]);

function toRecord(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

function requireStringField(record: Record<string, unknown>, field: string, errorMessage: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(errorMessage);
  }
  return value.trim();
}

function requireEnvVarField(record: Record<string, unknown>, field: string, pluginName: string): string {
  const value = requireStringField(record, field, `Plugin ${pluginName} ${field} must be a non-empty string`);
  if (!AUTH_TOKEN_ENV_RE.test(value)) {
    throw new Error(`Plugin ${pluginName} ${field} must be an uppercase env var name`);
  }
  return value;
}

function requireHttpsUrlField(record: Record<string, unknown>, field: string, pluginName: string): string {
  const value = requireStringField(record, field, `Plugin ${pluginName} oauth.${field} must be a non-empty string`);
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
  const domain = typeof rawDomain === "string" ? rawDomain.trim().toLowerCase() : "";
  if (!domain) {
    throw new Error(`Plugin ${name} credentials.api-domains entries must be non-empty strings`);
  }
  if (!API_DOMAIN_RE.test(domain)) {
    throw new Error(`Plugin ${name} credentials.api-domains entries must be valid domain names`);
  }
  return domain;
}

function parseStringMap(
  data: unknown,
  errorLabel: string,
  options: { reservedKeys?: Set<string>; forbiddenKeys?: Set<string> } = {}
): Record<string, string> | undefined {
  if (data === undefined) {
    return undefined;
  }
  const record = toRecord(data, `${errorLabel} must be an object when provided`);
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
  name: string
): {
  apiDomains: string[];
  apiHeaders?: Record<string, string>;
  authTokenEnv: string;
  authTokenPlaceholder?: string;
} {
  const rawDomains = data["api-domains"];
  if (!Array.isArray(rawDomains) || rawDomains.length === 0) {
    throw new Error(`Plugin ${name} credentials.api-domains must be a non-empty array of strings`);
  }
  const apiDomains = rawDomains.map((rawDomain) => normalizeApiDomain(rawDomain, name));
  const apiHeaders = parseStringMap(data["api-headers"], `Plugin ${name} credentials.api-headers`, {
    forbiddenKeys: FORBIDDEN_API_HEADER_NAMES
  });
  const authTokenEnv = requireEnvVarField(data, "auth-token-env", name);
  const authTokenPlaceholderRaw = data["auth-token-placeholder"];
  if (
    authTokenPlaceholderRaw !== undefined &&
    (typeof authTokenPlaceholderRaw !== "string" || !authTokenPlaceholderRaw.trim())
  ) {
    throw new Error(`Plugin ${name} credentials.auth-token-placeholder must be a non-empty string when provided`);
  }
  return {
    apiDomains,
    ...(apiHeaders ? { apiHeaders } : {}),
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
    const appIdEnv = requireEnvVarField(data, "app-id-env", name);
    const privateKeyEnv = requireEnvVarField(data, "private-key-env", name);
    const installationIdEnv = requireEnvVarField(data, "installation-id-env", name);
    return {
      type: "github-app",
      ...base,
      appIdEnv,
      privateKeyEnv,
      installationIdEnv
    } satisfies GitHubAppCredentials;
  }

  throw new Error(`Plugin ${name} has unsupported credentials.type: "${type}"`);
}

function parseRuntimeDependencies(data: unknown, name: string): PluginRuntimeDependency[] | undefined {
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
      throw new Error(`Plugin ${name} runtime-dependencies entries must be objects`);
    }

    const record = entry as Record<string, unknown>;
    const type = record.type;
    const packageName = record.package;
    const packageUrl = record.url;
    const version = record.version;
    const sha256 = record.sha256;
    if (typeof type !== "string" || (type !== "npm" && type !== "system")) {
      throw new Error(`Plugin ${name} runtime dependency type must be "npm" or "system"`);
    }
    const normalizedPackage = typeof packageName === "string" ? packageName.trim() : "";
    const normalizedUrl = typeof packageUrl === "string" ? packageUrl.trim() : "";
    if (type === "npm") {
      if (!normalizedPackage) {
        throw new Error(`Plugin ${name} runtime dependency package must be a non-empty string`);
      }
      if (packageUrl !== undefined || sha256 !== undefined) {
        throw new Error(`Plugin ${name} npm runtime dependencies must only include package/version fields`);
      }
      const normalizedVersion = typeof version === "string" ? version.trim() : "latest";
      if (!normalizedVersion) {
        throw new Error(`Plugin ${name} runtime dependency version must be a non-empty string when provided`);
      }
      const dedupeKey = `${type}:${normalizedPackage}:${normalizedVersion}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      parsed.push({
        type: "npm",
        package: normalizedPackage,
        version: normalizedVersion
      } satisfies PluginNpmRuntimeDependency);
      continue;
    }

    if (version !== undefined) {
      throw new Error(`Plugin ${name} system runtime dependencies must not include a version`);
    }

    if (normalizedPackage && normalizedUrl) {
      throw new Error(`Plugin ${name} system runtime dependencies must specify either package or url, not both`);
    }
    if (!normalizedPackage && !normalizedUrl) {
      throw new Error(`Plugin ${name} system runtime dependencies must specify package or url`);
    }

    if (normalizedPackage) {
      if (sha256 !== undefined) {
        throw new Error(`Plugin ${name} system runtime dependency package entries must not include sha256`);
      }
      const dedupeKey = `${type}:package:${normalizedPackage}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      parsed.push({
        type: "system",
        package: normalizedPackage
      } satisfies PluginSystemRuntimeDependency);
      continue;
    }

    if (!/^https:\/\//i.test(normalizedUrl)) {
      throw new Error(`Plugin ${name} system runtime dependency url must be an https URL`);
    }
    const normalizedSha256 = typeof sha256 === "string" ? sha256.trim().toLowerCase() : "";
    if (!/^[a-f0-9]{64}$/.test(normalizedSha256)) {
      throw new Error(`Plugin ${name} system runtime dependency url entries must include a valid sha256`);
    }
    const dedupeKey = `${type}:url:${normalizedUrl}:${normalizedSha256}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    parsed.push({
      type: "system",
      url: normalizedUrl,
      sha256: normalizedSha256
    } satisfies PluginSystemRuntimeDependencyFromUrl);
  }

  return parsed.length > 0 ? parsed : undefined;
}

function parseRuntimePostinstall(data: unknown, name: string): PluginRuntimePostinstallCommand[] | undefined {
  if (data === undefined) {
    return undefined;
  }

  if (!Array.isArray(data)) {
    throw new Error(`Plugin ${name} runtime-postinstall must be an array`);
  }

  const parsed: PluginRuntimePostinstallCommand[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Plugin ${name} runtime-postinstall entries must be objects`);
    }
    const record = entry as Record<string, unknown>;
    const cmd = typeof record.cmd === "string" ? record.cmd.trim() : "";
    if (!cmd) {
      throw new Error(`Plugin ${name} runtime-postinstall cmd must be a non-empty string`);
    }
    if (!RUNTIME_POSTINSTALL_CMD_RE.test(cmd)) {
      throw new Error(
        `Plugin ${name} runtime-postinstall cmd must be a single executable token (letters, digits, ., _, /, -)`
      );
    }

    const argsRaw = record.args;
    if (argsRaw !== undefined && (!Array.isArray(argsRaw) || !argsRaw.every((arg) => typeof arg === "string"))) {
      throw new Error(`Plugin ${name} runtime-postinstall args must be an array of strings when provided`);
    }

    const sudoRaw = record.sudo;
    if (sudoRaw !== undefined && typeof sudoRaw !== "boolean") {
      throw new Error(`Plugin ${name} runtime-postinstall sudo must be a boolean when provided`);
    }

    const normalizedArgs = Array.isArray(argsRaw)
      ? argsRaw.map((arg) => arg.trim()).filter((arg) => arg.length > 0)
      : undefined;

    parsed.push({
      cmd,
      ...(normalizedArgs && normalizedArgs.length > 0 ? { args: normalizedArgs } : {}),
      ...(typeof sudoRaw === "boolean" ? { sudo: sudoRaw } : {})
    });
  }

  return parsed.length > 0 ? parsed : undefined;
}

export function parsePluginManifest(raw: string, dir: string): PluginManifest {
  const data = toRecord(parseYaml(raw), `Invalid plugin manifest in ${dir}: expected an object`);

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

  const rawCapabilities = data.capabilities;
  if (rawCapabilities !== undefined && !Array.isArray(rawCapabilities)) {
    throw new Error(`Plugin ${name} capabilities must be an array when provided`);
  }
  const capabilities: string[] = [];
  for (const cap of rawCapabilities ?? []) {
    if (typeof cap !== "string" || !SHORT_CAPABILITY_RE.test(cap)) {
      throw new Error(`Invalid capability token "${cap}" in plugin ${name}`);
    }
    capabilities.push(`${name}.${cap}`);
  }

  const rawConfigKeys = data["config-keys"];
  if (rawConfigKeys !== undefined && !Array.isArray(rawConfigKeys)) {
    throw new Error(`Plugin ${name} config-keys must be an array when provided`);
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
    toRecord(credentialsRaw, `Plugin ${name} credentials must be an object when provided`);
  }
  const credentials = credentialsRaw ? parseCredentials(credentialsRaw as Record<string, unknown>, name) : undefined;

  const runtimeDependencies = parseRuntimeDependencies(data["runtime-dependencies"], name);
  const runtimePostinstall = parseRuntimePostinstall(data["runtime-postinstall"], name);

  const manifest: PluginManifest = {
    name,
    description,
    capabilities,
    configKeys,
    ...(credentials ? { credentials } : {}),
    ...(runtimeDependencies ? { runtimeDependencies } : {}),
    ...(runtimePostinstall ? { runtimePostinstall } : {})
  };

  const oauthRaw = data.oauth ? toRecord(data.oauth, `Plugin ${name} oauth must be an object`) : undefined;
  if (oauthRaw) {
    if (!credentials) {
      throw new Error(`Plugin ${name} oauth requires credentials`);
    }
    if (credentials.type !== "oauth-bearer") {
      throw new Error(`Plugin ${name} oauth requires credentials.type "oauth-bearer"`);
    }
    const authorizeParams = parseStringMap(oauthRaw["authorize-params"], `Plugin ${name} oauth.authorize-params`, {
      reservedKeys: RESERVED_AUTHORIZE_PARAM_KEYS
    });
    const tokenExtraHeaders = parseStringMap(
      oauthRaw["token-extra-headers"],
      `Plugin ${name} oauth.token-extra-headers`,
      { forbiddenKeys: FORBIDDEN_TOKEN_HEADER_NAMES }
    );
    const tokenAuthMethodRaw = oauthRaw["token-auth-method"];
    let tokenAuthMethod: "body" | "basic" | undefined;
    if (tokenAuthMethodRaw !== undefined) {
      const parsedTokenAuthMethod = requireStringField(
        oauthRaw,
        "token-auth-method",
        `Plugin ${name} oauth.token-auth-method must be a non-empty string`
      );
      if (parsedTokenAuthMethod !== "body" && parsedTokenAuthMethod !== "basic") {
        throw new Error(`Plugin ${name} oauth.token-auth-method must be "body" or "basic"`);
      }
      tokenAuthMethod = parsedTokenAuthMethod;
    }
    manifest.oauth = {
      clientIdEnv: requireEnvVarField(oauthRaw, "client-id-env", name),
      clientSecretEnv: requireEnvVarField(oauthRaw, "client-secret-env", name),
      authorizeEndpoint: requireHttpsUrlField(oauthRaw, "authorize-endpoint", name),
      tokenEndpoint: requireHttpsUrlField(oauthRaw, "token-endpoint", name),
      ...(oauthRaw.scope !== undefined
        ? {
            scope: requireStringField(oauthRaw, "scope", `Plugin ${name} oauth.scope must be a non-empty string`)
          }
        : {}),
      ...(authorizeParams ? { authorizeParams } : {}),
      ...(tokenAuthMethod ? { tokenAuthMethod } : {}),
      ...(tokenExtraHeaders ? { tokenExtraHeaders } : {})
    };
  }

  const targetRaw = data.target ? toRecord(data.target, `Plugin ${name} target must be an object`) : undefined;
  if (targetRaw) {
    if (targetRaw.type !== "repo") {
      throw new Error(`Plugin ${name} target.type must be "repo"`);
    }
    const rawConfigKey = targetRaw["config-key"];
    if (typeof rawConfigKey !== "string" || !rawConfigKey.trim()) {
      throw new Error(`Plugin ${name} target.config-key must be a non-empty string`);
    }
    if (!SHORT_CONFIG_KEY_RE.test(rawConfigKey)) {
      throw new Error(`Plugin ${name} target.config-key "${rawConfigKey}" is invalid`);
    }
    const qualifiedKey = `${name}.${rawConfigKey}`;
    if (!configKeys.includes(qualifiedKey)) {
      throw new Error(`Plugin ${name} target.config-key "${rawConfigKey}" must be listed in config-keys`);
    }
    manifest.target = { type: "repo", configKey: qualifiedKey };
  }

  return manifest;
}
