import {
  logError,
  logException,
  logInfo,
  logWarn,
  setSpanAttributes,
  setSpanStatus,
  setTags,
  withSpan
} from "./chunk-OXCKLXL3.js";
import {
  botConfig,
  getSlackBotToken,
  getStateAdapter
} from "./chunk-ZVUOP46C.js";

// src/chat/plugins/registry.ts
import { readFileSync, readdirSync, statSync } from "fs";
import path2 from "path";
import { parse as parseYaml } from "yaml";

// src/chat/home.ts
import path from "path";
function homeDir() {
  return path.resolve(process.cwd());
}
function dataDir() {
  return path.join(homeDir(), "data");
}
function soulPath() {
  return path.join(dataDir(), "SOUL.md");
}
function skillsDir() {
  return path.join(homeDir(), "skills");
}
function pluginsDir() {
  return path.join(homeDir(), "plugins");
}

// src/chat/plugins/github-app-broker.ts
import { createPrivateKey, createSign, randomUUID } from "crypto";
var MAX_LEASE_MS = 60 * 60 * 1e3;
function normalizeTargetScope(target) {
  const owner = target?.owner?.trim().toLowerCase();
  const repo = target?.repo?.trim().toLowerCase();
  if (!owner || !repo) {
    return "all";
  }
  return `${owner}/${repo}`;
}
function base64Url(input) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function normalizePrivateKey(raw) {
  let normalized = raw.trim();
  if (normalized.startsWith('"') && normalized.endsWith('"') || normalized.startsWith("'") && normalized.endsWith("'")) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/\r\n/g, "\n");
  if (normalized.includes("\\n")) {
    normalized = normalized.replace(/\\n/g, "\n");
  }
  if (!normalized.includes("-----BEGIN")) {
    try {
      const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
      if (decoded.includes("-----BEGIN")) {
        normalized = decoded;
      }
    } catch {
    }
  }
  return normalized;
}
function getPrivateKey(envName) {
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(`Missing ${envName}`);
  }
  const normalized = normalizePrivateKey(raw);
  let key;
  try {
    key = createPrivateKey({ key: normalized, format: "pem" });
  } catch {
    throw new Error(
      `Invalid ${envName}: expected a PEM-encoded RSA private key (raw PEM, escaped newlines, or base64-encoded PEM)`
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error(`Invalid ${envName}: GitHub App signing requires an RSA private key`);
  }
  return key;
}
function createAppJwt(appId, privateKeyEnv) {
  const now = Math.floor(Date.now() / 1e3);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(getPrivateKey(privateKeyEnv)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${signingInput}.${signature}`;
}
async function githubRequest(apiBase, path6, params) {
  const response = await fetch(`${apiBase}${path6}`, {
    method: params.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${params.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...params.body ? { "Content-Type": "application/json" } : {}
    },
    ...params.body ? { body: JSON.stringify(params.body) } : {}
  });
  const text = await response.text();
  let parsed = void 0;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = void 0;
    }
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string" ? parsed.message : `GitHub API error ${response.status}`;
    throw new Error(message);
  }
  return parsed;
}
function capabilityToPermissions(capability, pluginName) {
  if (capability === `${pluginName}.issues.read`) {
    return { issues: "read" };
  }
  if (capability === `${pluginName}.issues.write` || capability === `${pluginName}.issues.comment` || capability === `${pluginName}.labels.write`) {
    return { issues: "write" };
  }
  throw new Error(`Unsupported GitHub capability: ${capability}`);
}
function createGitHubAppBroker(manifest, credentials) {
  const tokenCache = /* @__PURE__ */ new Map();
  const provider = manifest.name;
  const { apiDomains, authTokenEnv, appIdEnv, privateKeyEnv, installationIdEnv } = credentials;
  const apiBase = `https://${apiDomains[0]}`;
  const placeholder = "ghp_host_managed_credential";
  return {
    async issue(input) {
      const permissions = capabilityToPermissions(input.capability, provider);
      const appId = process.env[appIdEnv];
      if (!appId) {
        throw new Error(`Missing ${appIdEnv}`);
      }
      const installationIdRaw = process.env[installationIdEnv]?.trim();
      if (!installationIdRaw) {
        throw new Error(`Missing ${installationIdEnv}`);
      }
      const installationId = Number(installationIdRaw);
      if (!Number.isFinite(installationId)) {
        throw new Error(`Invalid ${installationIdEnv}`);
      }
      const targetScope = normalizeTargetScope(input.target);
      const cacheKey = `${installationId}:${input.capability}:${targetScope}`;
      const cached = tokenCache.get(cacheKey);
      const now = Date.now();
      if (cached && cached.expiresAt - now > 2 * 60 * 1e3) {
        return {
          id: randomUUID(),
          provider,
          capability: input.capability,
          env: { [authTokenEnv]: placeholder },
          headerTransforms: apiDomains.map((domain) => ({
            domain,
            headers: {
              Authorization: `Bearer ${cached.token}`
            }
          })),
          expiresAt: new Date(cached.expiresAt).toISOString(),
          metadata: {
            installationId: String(cached.installationId),
            targetScope,
            reason: input.reason
          }
        };
      }
      const appJwt = createAppJwt(appId, privateKeyEnv);
      const repositoryName = input.target?.repo?.trim().toLowerCase();
      const tokenRequestBody = {
        permissions
      };
      if (repositoryName) {
        tokenRequestBody.repositories = [repositoryName];
      }
      const accessTokenResponse = await githubRequest(
        apiBase,
        `/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          token: appJwt,
          body: tokenRequestBody
        }
      );
      const providerExpiresAtMs = Date.parse(accessTokenResponse.expires_at);
      const expiresAtMs = Math.min(providerExpiresAtMs, Date.now() + MAX_LEASE_MS);
      tokenCache.set(cacheKey, {
        installationId,
        token: accessTokenResponse.token,
        expiresAt: expiresAtMs
      });
      return {
        id: randomUUID(),
        provider,
        capability: input.capability,
        env: { [authTokenEnv]: placeholder },
        headerTransforms: apiDomains.map((domain) => ({
          domain,
          headers: {
            Authorization: `Bearer ${accessTokenResponse.token}`
          }
        })),
        expiresAt: new Date(expiresAtMs).toISOString(),
        metadata: {
          installationId: String(installationId),
          targetScope,
          reason: input.reason
        }
      };
    }
  };
}

// src/chat/plugins/oauth-bearer-broker.ts
import { randomUUID as randomUUID2 } from "crypto";

// src/chat/credentials/broker.ts
var CredentialUnavailableError = class extends Error {
  provider;
  constructor(provider, message) {
    super(message);
    this.name = "CredentialUnavailableError";
    this.provider = provider;
  }
};

// src/chat/plugins/oauth-bearer-broker.ts
var MAX_LEASE_MS2 = 60 * 60 * 1e3;
var REFRESH_BUFFER_MS = 5 * 60 * 1e3;
var AUTH_TOKEN_PLACEHOLDER = "host_managed_credential";
async function refreshAccessToken(refreshToken, oauth) {
  const clientId = process.env[oauth.clientIdEnv]?.trim();
  const clientSecret = process.env[oauth.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(`Missing ${oauth.clientIdEnv} or ${oauth.clientSecretEnv} for token refresh`);
  }
  const response = await fetch(oauth.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }
  const data = await response.json();
  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error("Token refresh returned malformed response");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in
  };
}
function createOAuthBearerBroker(manifest, credentials, deps) {
  const provider = manifest.name;
  const supportedCapabilities = new Set(manifest.capabilities);
  const { apiDomains, authTokenEnv } = credentials;
  function buildLease(token, capability, expiresAtMs, reason) {
    return {
      id: randomUUID2(),
      provider,
      capability,
      env: { [authTokenEnv]: AUTH_TOKEN_PLACEHOLDER },
      headerTransforms: apiDomains.map((domain) => ({
        domain,
        headers: { Authorization: `Bearer ${token}` }
      })),
      expiresAt: new Date(expiresAtMs).toISOString(),
      metadata: { reason }
    };
  }
  return {
    async issue(input) {
      if (!supportedCapabilities.has(input.capability)) {
        throw new Error(`Unsupported ${provider} capability: ${input.capability}`);
      }
      if (input.requesterId && deps.userTokenStore) {
        const stored = await deps.userTokenStore.get(input.requesterId, provider);
        if (stored) {
          const now = Date.now();
          if (stored.expiresAt - now < REFRESH_BUFFER_MS && stored.refreshToken && manifest.oauth) {
            try {
              const refreshed = await refreshAccessToken(stored.refreshToken, manifest.oauth);
              const expiresAt = Date.now() + refreshed.expiresIn * 1e3;
              await deps.userTokenStore.set(input.requesterId, provider, {
                accessToken: refreshed.accessToken,
                refreshToken: refreshed.refreshToken,
                expiresAt
              });
              const leaseExpiry = Math.min(expiresAt, Date.now() + MAX_LEASE_MS2);
              return buildLease(refreshed.accessToken, input.capability, leaseExpiry, input.reason);
            } catch {
              if (stored.expiresAt > Date.now()) {
                const leaseExpiry = Math.min(stored.expiresAt, Date.now() + MAX_LEASE_MS2);
                return buildLease(stored.accessToken, input.capability, leaseExpiry, input.reason);
              }
              throw new CredentialUnavailableError(
                provider,
                `Your ${provider} connection has expired.`
              );
            }
          }
          if (stored.expiresAt > Date.now()) {
            const leaseExpiry = Math.min(stored.expiresAt, Date.now() + MAX_LEASE_MS2);
            return buildLease(stored.accessToken, input.capability, leaseExpiry, input.reason);
          }
          throw new CredentialUnavailableError(
            provider,
            `Your ${provider} connection has expired.`
          );
        }
        throw new CredentialUnavailableError(
          provider,
          `No ${provider} credentials available.`
        );
      }
      const envToken = process.env[authTokenEnv]?.trim();
      if (envToken) {
        const expiresAtMs = Date.now() + MAX_LEASE_MS2;
        return buildLease(envToken, input.capability, expiresAtMs, input.reason);
      }
      throw new CredentialUnavailableError(
        provider,
        `No ${provider} credentials available.`
      );
    }
  };
}

// src/chat/plugins/registry.ts
var PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
var SHORT_CAPABILITY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
var SHORT_CONFIG_KEY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
function parseBaseCredentialFields(data, name) {
  const rawDomains = data["api-domains"];
  if (!Array.isArray(rawDomains) || rawDomains.length === 0 || !rawDomains.every((d) => typeof d === "string" && d.trim())) {
    throw new Error(`Plugin ${name} credentials.api-domains must be a non-empty array of strings`);
  }
  const authTokenEnv = data["auth-token-env"];
  if (typeof authTokenEnv !== "string" || !authTokenEnv.trim()) {
    throw new Error(`Plugin ${name} credentials.auth-token-env must be a non-empty string`);
  }
  return { apiDomains: rawDomains, authTokenEnv };
}
function parseCredentials(data, name) {
  const type = data.type;
  if (type === "oauth-bearer") {
    const base = parseBaseCredentialFields(data, name);
    return { type: "oauth-bearer", ...base };
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
    return { type: "github-app", ...base, appIdEnv, privateKeyEnv, installationIdEnv };
  }
  throw new Error(`Plugin ${name} has unsupported credentials.type: "${type}"`);
}
function parseManifest(raw, dir) {
  const data = parseYaml(raw);
  const name = data.name;
  if (typeof name !== "string" || !PLUGIN_NAME_RE.test(name)) {
    throw new Error(`Invalid plugin name in ${dir}: "${name}"`);
  }
  const description = data.description;
  if (typeof description !== "string" || !description.trim()) {
    throw new Error(`Invalid plugin description in ${dir}`);
  }
  const rawCapabilities = data.capabilities;
  if (!Array.isArray(rawCapabilities) || rawCapabilities.length === 0) {
    throw new Error(`Plugin ${name} must declare at least one capability`);
  }
  const capabilities = [];
  for (const cap of rawCapabilities) {
    if (typeof cap !== "string" || !SHORT_CAPABILITY_RE.test(cap)) {
      throw new Error(`Invalid capability token "${cap}" in plugin ${name}`);
    }
    capabilities.push(`${name}.${cap}`);
  }
  const rawConfigKeys = data["config-keys"];
  if (!Array.isArray(rawConfigKeys)) {
    throw new Error(`Plugin ${name} must declare config-keys`);
  }
  const configKeys = [];
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
  const credentials = parseCredentials(credentialsRaw, name);
  const manifest = {
    name,
    description,
    capabilities,
    configKeys,
    credentials
  };
  const oauthRaw = data.oauth;
  if (oauthRaw) {
    const oauthFields = ["client-id-env", "client-secret-env", "authorize-endpoint", "token-endpoint", "scope"];
    for (const field of oauthFields) {
      if (typeof oauthRaw[field] !== "string" || !oauthRaw[field].trim()) {
        throw new Error(`Plugin ${name} oauth.${field} must be a non-empty string`);
      }
    }
    manifest.oauth = {
      clientIdEnv: oauthRaw["client-id-env"],
      clientSecretEnv: oauthRaw["client-secret-env"],
      authorizeEndpoint: oauthRaw["authorize-endpoint"],
      tokenEndpoint: oauthRaw["token-endpoint"],
      scope: oauthRaw.scope
    };
  }
  const targetRaw = data.target;
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
var pluginDefinitions = [];
var capabilityToPlugin = /* @__PURE__ */ new Map();
var pluginConfigKeys = /* @__PURE__ */ new Set();
var pluginsByName = /* @__PURE__ */ new Map();
var pluginsLoaded = false;
function loadPlugins() {
  if (pluginsLoaded) return;
  pluginsLoaded = true;
  const pluginsRoot = pluginsDir();
  let entries;
  try {
    entries = readdirSync(pluginsRoot);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    const pluginDir = path2.join(pluginsRoot, entry);
    try {
      const stat = statSync(pluginDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = path2.join(pluginDir, "plugin.yaml");
    let raw;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch {
      continue;
    }
    const manifest = parseManifest(raw, pluginDir);
    if (pluginsByName.has(manifest.name)) {
      throw new Error(`Duplicate plugin name: "${manifest.name}"`);
    }
    for (const cap of manifest.capabilities) {
      if (capabilityToPlugin.has(cap)) {
        throw new Error(`Duplicate capability "${cap}" in plugin "${manifest.name}"`);
      }
    }
    const definition = {
      manifest,
      dir: pluginDir,
      skillsDir: path2.join(pluginDir, "skills")
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
loadPlugins();
function getPluginCapabilityProviders() {
  return pluginDefinitions.map((plugin) => ({
    provider: plugin.manifest.name,
    capabilities: [...plugin.manifest.capabilities],
    configKeys: [...plugin.manifest.configKeys],
    ...plugin.manifest.target ? { target: { ...plugin.manifest.target } } : {}
  }));
}
function getPluginProviders() {
  return [...pluginDefinitions];
}
function getPluginOAuthConfig(provider) {
  const plugin = pluginsByName.get(provider);
  if (!plugin?.manifest.oauth) return void 0;
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
function getPluginSkillRoots() {
  return pluginDefinitions.map((plugin) => plugin.skillsDir);
}
function isPluginProvider(provider) {
  return pluginsByName.has(provider);
}
function createPluginBroker(provider, deps) {
  const plugin = pluginsByName.get(provider);
  if (!plugin) {
    throw new Error(`Unknown plugin provider: "${provider}"`);
  }
  const { credentials, name } = plugin.manifest;
  let broker;
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

// src/chat/capabilities/catalog.ts
var CAPABILITY_PROVIDERS = [
  ...getPluginCapabilityProviders()
];
var capabilityToProvider = /* @__PURE__ */ new Map();
var configKeySet = /* @__PURE__ */ new Set();
var startupCatalogLogged = false;
for (const provider of CAPABILITY_PROVIDERS) {
  for (const capability of provider.capabilities) {
    if (capabilityToProvider.has(capability)) {
      throw new Error(`Duplicate capability registration for "${capability}"`);
    }
    capabilityToProvider.set(capability, provider);
  }
  for (const configKey of provider.configKeys) {
    configKeySet.add(configKey);
  }
}
function getCapabilityProvider(capability) {
  return capabilityToProvider.get(capability);
}
function isKnownCapability(capability) {
  return capabilityToProvider.has(capability);
}
function isKnownConfigKey(key) {
  return configKeySet.has(key);
}
function listCapabilityProviders() {
  return CAPABILITY_PROVIDERS.map((provider) => ({
    ...provider,
    capabilities: [...provider.capabilities],
    configKeys: [...provider.configKeys]
  }));
}
function logCapabilityCatalogLoadedOnce() {
  if (startupCatalogLogged) {
    return;
  }
  startupCatalogLogged = true;
  const providers = listCapabilityProviders();
  const capabilityNames = providers.flatMap((provider) => provider.capabilities).sort();
  const configKeys = [...new Set(providers.flatMap((provider) => provider.configKeys))].sort();
  logInfo(
    "capability_catalog_loaded",
    {},
    {
      "app.capability.providers": providers.map((provider) => provider.provider),
      "app.capability.count": capabilityNames.length,
      "app.capability.names": capabilityNames,
      "app.config.key_count": configKeys.length,
      "app.config.keys": configKeys
    },
    "Loaded capability provider catalog"
  );
}

// src/chat/capabilities/router.ts
var ProviderCredentialRouter = class {
  brokersByProvider;
  constructor(input) {
    this.brokersByProvider = input.brokersByProvider;
  }
  async issue(input) {
    const provider = getCapabilityProvider(input.capability)?.provider;
    if (!provider) {
      throw new Error(`Unsupported capability: ${input.capability}`);
    }
    const broker = this.brokersByProvider[provider];
    if (!broker) {
      throw new Error(`No credential broker registered for provider: ${provider}`);
    }
    return await broker.issue(input);
  }
};

// src/chat/capabilities/target.ts
var REPO_FLAG_RE = /(?:^|\s)--repo(?:\s+|=)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[0-9]+)?)/;
function parseRepoTarget(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return void 0;
  }
  const [repoRef] = trimmed.split("#");
  const [owner, repo] = repoRef.split("/");
  if (!owner || !repo) {
    return void 0;
  }
  return {
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase()
  };
}
function extractRepoRef(text) {
  const byFlag = REPO_FLAG_RE.exec(text);
  if (byFlag) {
    return parseRepoTarget(byFlag[1]);
  }
  return void 0;
}
function extractCapabilityTarget(params) {
  if (params.commandText) {
    const commandRepo = extractRepoRef(params.commandText);
    if (commandRepo) {
      return commandRepo;
    }
  }
  if (params.invocationArgs) {
    const invocationRepo = extractRepoRef(params.invocationArgs);
    if (invocationRepo) {
      return invocationRepo;
    }
  }
  return void 0;
}

// src/chat/capabilities/runtime.ts
var SkillCapabilityRuntime = class {
  router;
  invocationArgs;
  requesterId;
  resolveConfiguration;
  enabledByCapability = /* @__PURE__ */ new Map();
  constructor(params) {
    if (params.router) {
      this.router = params.router;
    } else if (params.broker) {
      this.router = {
        issue: async (input) => await params.broker.issue(input)
      };
    } else {
      throw new Error("SkillCapabilityRuntime requires either router or broker");
    }
    this.invocationArgs = params.invocationArgs;
    this.requesterId = params.requesterId;
    this.resolveConfiguration = params.resolveConfiguration;
  }
  async resolveCapabilityTarget(input) {
    const activeSkill = input.activeSkill;
    const explicitTarget = input.repoRef ? parseRepoTarget(input.repoRef) : void 0;
    if (explicitTarget) {
      return explicitTarget;
    }
    const inferredTarget = extractCapabilityTarget({
      invocationArgs: this.invocationArgs
    });
    if (inferredTarget) {
      return inferredTarget;
    }
    if (!input.configKey || !this.resolveConfiguration) {
      return void 0;
    }
    const configuredRepo = await this.resolveConfiguration(input.configKey);
    if (typeof configuredRepo !== "string" || configuredRepo.trim().length === 0) {
      return void 0;
    }
    const configuredTarget = parseRepoTarget(configuredRepo);
    if (!configuredTarget) {
      logWarn(
        "config_value_invalid_for_capability_target",
        {},
        {
          "app.skill.name": activeSkill?.name,
          "app.config.key": input.configKey
        },
        `Configured ${input.configKey} is invalid for capability target resolution`
      );
      return void 0;
    }
    const declaredConfig = activeSkill?.usesConfig ?? [];
    if (activeSkill && !declaredConfig.includes(input.configKey)) {
      logWarn(
        "config_key_not_declared_for_skill",
        {},
        {
          "app.skill.name": activeSkill.name,
          "app.config.key": input.configKey
        },
        "Configuration key used by runtime is not declared in active skill frontmatter (soft enforcement)"
      );
    }
    return configuredTarget;
  }
  capabilityCacheKey(capability, target) {
    const owner = target?.owner?.trim().toLowerCase();
    const repo = target?.repo?.trim().toLowerCase();
    const scope = owner && repo ? `${owner}/${repo}` : "none";
    return `${capability}:${scope}`;
  }
  async issueCapabilityLease(input) {
    const capabilityProvider = getCapabilityProvider(input.capability);
    if (!capabilityProvider) {
      throw new Error(`Unsupported capability for lease issuance: ${input.capability}`);
    }
    const activeSkill = input.activeSkill;
    const target = capabilityProvider.target?.type === "repo" ? await this.resolveCapabilityTarget({
      activeSkill,
      repoRef: input.repoRef,
      configKey: capabilityProvider.target.configKey
    }) : void 0;
    return await this.router.issue({
      capability: input.capability,
      target,
      reason: input.reason,
      requesterId: this.requesterId
    });
  }
  toHeaderTransforms(lease) {
    if (Array.isArray(lease.headerTransforms) && lease.headerTransforms.length > 0) {
      return lease.headerTransforms.filter(
        (transform) => Boolean(transform?.domain?.trim()) && transform.headers && typeof transform.headers === "object" && Object.keys(transform.headers).length > 0
      ).map((transform) => ({
        domain: transform.domain.trim(),
        headers: transform.headers
      }));
    }
    return [];
  }
  async enableCapabilityForTurn(input) {
    const capability = input.capability.trim();
    if (!capability) {
      throw new Error("jr-rpc issue-credential requires a capability argument");
    }
    const capabilityProvider = getCapabilityProvider(capability);
    if (!capabilityProvider) {
      throw new Error(`Unsupported capability for jr-rpc issue-credential: ${capability}`);
    }
    const activeSkill = input.activeSkill;
    const capabilityTarget = capabilityProvider.target?.type === "repo" ? await this.resolveCapabilityTarget({
      activeSkill,
      repoRef: input.repoRef,
      configKey: capabilityProvider.target.configKey
    }) : void 0;
    if (capabilityProvider.target?.type === "repo" && (!capabilityTarget?.owner || !capabilityTarget?.repo)) {
      throw new Error("jr-rpc issue-credential requires repository context; use --repo <owner/repo>");
    }
    const declared = activeSkill?.requiresCapabilities ?? [];
    if (activeSkill && !declared.includes(capability)) {
      logWarn(
        "capability_not_declared_for_skill",
        {},
        {
          "app.skill.name": activeSkill.name,
          "app.capability.name": capability
        },
        "Capability issued even though it is not declared in the active skill (soft enforcement)"
      );
    }
    const cacheKey = this.capabilityCacheKey(capability, capabilityTarget);
    const existing = this.enabledByCapability.get(cacheKey);
    const now = Date.now();
    if (existing && existing.expiresAtMs - now > 1e4) {
      return { reused: true, expiresAt: new Date(existing.expiresAtMs).toISOString() };
    }
    logInfo(
      "credential_issue_request",
      {},
      {
        "app.skill.name": activeSkill?.name,
        "app.capability.name": capability
      },
      "Issuing capability credential for current turn"
    );
    try {
      const lease = await this.issueCapabilityLease({
        activeSkill,
        capability,
        repoRef: input.repoRef,
        reason: input.reason
      });
      const transforms = this.toHeaderTransforms(lease);
      if (transforms.length === 0) {
        throw new Error(`Credential lease for ${capability} did not include header transforms`);
      }
      const expiresAtMs = Date.parse(lease.expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        throw new Error(`Credential lease for ${capability} returned invalid expiresAt`);
      }
      this.enabledByCapability.set(cacheKey, {
        expiresAtMs,
        transforms,
        env: lease.env
      });
      logInfo(
        "credential_issue_success",
        {},
        {
          "app.skill.name": activeSkill?.name,
          "app.capability.name": capability,
          "app.credential.provider": lease.provider,
          "app.credential.expires_at": lease.expiresAt,
          "app.credential.delivery": "header_transform"
        },
        "Issued capability credential lease"
      );
      return { reused: false, expiresAt: lease.expiresAt };
    } catch (error) {
      logWarn(
        "credential_issue_failed",
        {},
        {
          "app.skill.name": activeSkill?.name,
          "app.capability.name": capability,
          "error.message": error instanceof Error ? error.message : String(error)
        },
        "Capability credential resolution failed"
      );
      throw error;
    }
  }
  getTurnHeaderTransforms() {
    const now = Date.now();
    const headerTransforms = [];
    for (const [capability, entry] of this.enabledByCapability.entries()) {
      if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= now) {
        this.enabledByCapability.delete(capability);
        continue;
      }
      headerTransforms.push(...entry.transforms);
    }
    return headerTransforms.length > 0 ? headerTransforms : void 0;
  }
  getTurnEnv() {
    const now = Date.now();
    const env = {};
    for (const [capability, entry] of this.enabledByCapability.entries()) {
      if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs <= now) {
        this.enabledByCapability.delete(capability);
        continue;
      }
      Object.assign(env, entry.env);
    }
    return Object.keys(env).length > 0 ? env : void 0;
  }
};

// src/chat/credentials/state-adapter-token-store.ts
var KEY_PREFIX = "oauth-token";
var BUFFER_MS = 24 * 60 * 60 * 1e3;
function tokenKey(userId, provider) {
  return `${KEY_PREFIX}:${userId}:${provider}`;
}
var StateAdapterTokenStore = class {
  state;
  constructor(stateAdapter) {
    this.state = stateAdapter;
  }
  async get(userId, provider) {
    const stored = await this.state.get(tokenKey(userId, provider));
    return stored ?? void 0;
  }
  async set(userId, provider, tokens) {
    const ttlMs = Math.max(tokens.expiresAt - Date.now() + BUFFER_MS, BUFFER_MS);
    await this.state.set(tokenKey(userId, provider), tokens, ttlMs);
  }
  async delete(userId, provider) {
    await this.state.delete(tokenKey(userId, provider));
  }
};

// src/chat/credentials/test-broker.ts
import { randomUUID as randomUUID3 } from "crypto";
var TestCredentialBroker = class {
  config;
  constructor(config) {
    this.config = config;
  }
  async issue(input) {
    const token = process.env.EVAL_TEST_CREDENTIAL_TOKEN?.trim() || "eval-test-token";
    const expiresAt = new Date(Date.now() + 5 * 60 * 1e3).toISOString();
    return {
      id: randomUUID3(),
      provider: this.config.provider,
      capability: input.capability,
      env: {
        [this.config.envKey]: this.config.placeholder
      },
      headerTransforms: this.config.domains.map((domain) => ({
        domain,
        headers: {
          Authorization: `Bearer ${token}`
        }
      })),
      expiresAt,
      metadata: {
        reason: input.reason,
        target: input.target?.owner && input.target?.repo ? `${input.target.owner}/${input.target.repo}` : "none"
      }
    };
  }
};

// src/chat/capabilities/factory.ts
var _userTokenStore;
function getUserTokenStore() {
  if (!_userTokenStore) {
    _userTokenStore = new StateAdapterTokenStore(getStateAdapter());
  }
  return _userTokenStore;
}
function createSkillCapabilityRuntime(options = {}) {
  logCapabilityCatalogLoadedOnce();
  const useTestBroker = process.env.EVAL_ENABLE_TEST_CREDENTIALS === "1";
  const userTokenStore = getUserTokenStore();
  const brokersByProvider = {};
  for (const plugin of getPluginProviders()) {
    const { credentials, name } = plugin.manifest;
    brokersByProvider[name] = useTestBroker ? new TestCredentialBroker({ provider: name, domains: credentials.apiDomains, envKey: credentials.authTokenEnv, placeholder: "host_managed_credential" }) : createPluginBroker(name, { userTokenStore });
  }
  const router = new ProviderCredentialRouter({ brokersByProvider });
  return new SkillCapabilityRuntime({
    router,
    invocationArgs: options.invocationArgs,
    requesterId: options.requesterId,
    resolveConfiguration: options.resolveConfiguration
  });
}

// src/chat/slack-actions/client.ts
import { WebClient } from "@slack/web-api";
var SlackActionError = class extends Error {
  code;
  apiError;
  needed;
  provided;
  statusCode;
  requestId;
  errorData;
  retryAfterSeconds;
  constructor(message, code, options = {}) {
    super(message);
    this.name = "SlackActionError";
    this.code = code;
    this.apiError = options.apiError;
    this.needed = options.needed;
    this.provided = options.provided;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.errorData = options.errorData;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
};
function serializeSlackErrorData(data) {
  if (!data || typeof data !== "object") {
    return void 0;
  }
  const filtered = Object.fromEntries(
    Object.entries(data).filter(([key]) => key !== "error")
  );
  if (Object.keys(filtered).length === 0) {
    return void 0;
  }
  try {
    const serialized = JSON.stringify(filtered);
    return serialized.length <= 600 ? serialized : `${serialized.slice(0, 597)}...`;
  } catch {
    return void 0;
  }
}
function getHeaderString(headers, name) {
  if (!headers || typeof headers !== "object") {
    return void 0;
  }
  const key = name.toLowerCase();
  const entries = headers;
  for (const [entryKey, value] of Object.entries(entries)) {
    if (entryKey.toLowerCase() !== key) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string");
      return typeof first === "string" ? first : void 0;
    }
  }
  return void 0;
}
var client = null;
function normalizeSlackConversationId(channelId) {
  if (!channelId) return void 0;
  const trimmed = channelId.trim();
  if (!trimmed) return void 0;
  if (!trimmed.startsWith("slack:")) {
    return trimmed;
  }
  const parts = trimmed.split(":");
  return parts[1]?.trim() || void 0;
}
function getClient() {
  if (client) return client;
  const token = getSlackBotToken();
  if (!token) {
    throw new SlackActionError(
      "SLACK_BOT_TOKEN (or SLACK_BOT_USER_TOKEN) is required for Slack canvas/list actions in this service",
      "missing_token"
    );
  }
  client = new WebClient(token);
  return client;
}
function mapSlackError(error) {
  if (error instanceof SlackActionError) {
    return error;
  }
  const candidate = error;
  const apiError = candidate.data?.error;
  const message = candidate.message ?? "Slack action failed";
  const baseOptions = {
    apiError,
    statusCode: candidate.statusCode,
    requestId: getHeaderString(candidate.headers, "x-slack-req-id"),
    errorData: serializeSlackErrorData(candidate.data)
  };
  if (apiError === "missing_scope") {
    return new SlackActionError(message, "missing_scope", {
      ...baseOptions,
      needed: candidate.data?.needed,
      provided: candidate.data?.provided
    });
  }
  if (apiError === "not_in_channel") {
    return new SlackActionError(message, "not_in_channel", baseOptions);
  }
  if (apiError === "invalid_arguments") {
    return new SlackActionError(message, "invalid_arguments", baseOptions);
  }
  if (apiError === "invalid_name") {
    return new SlackActionError(message, "invalid_arguments", baseOptions);
  }
  if (apiError === "not_found") {
    return new SlackActionError(message, "not_found", baseOptions);
  }
  if (apiError === "feature_not_enabled" || apiError === "not_allowed_token_type") {
    return new SlackActionError(message, "feature_unavailable", baseOptions);
  }
  if (apiError === "canvas_creation_failed") {
    return new SlackActionError(message, "canvas_creation_failed", baseOptions);
  }
  if (apiError === "canvas_editing_failed") {
    return new SlackActionError(message, "canvas_editing_failed", baseOptions);
  }
  if (candidate.code === "slack_webapi_rate_limited_error" || candidate.statusCode === 429) {
    return new SlackActionError(message, "rate_limited", {
      ...baseOptions,
      retryAfterSeconds: candidate.retryAfter
    });
  }
  return new SlackActionError(message, "internal_error", baseOptions);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function withSlackRetries(task, maxAttempts = 3, context = {}) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await task();
    } catch (error) {
      const mapped = mapSlackError(error);
      const isRetryable = mapped.code === "rate_limited";
      const baseLogAttributes = {
        "app.slack.action": context.action ?? "unknown",
        "app.slack.error_code": mapped.code,
        ...mapped.apiError ? { "app.slack.api_error": mapped.apiError } : {},
        ...mapped.requestId ? { "app.slack.request_id": mapped.requestId } : {},
        ...mapped.statusCode !== void 0 ? { "http.response.status_code": mapped.statusCode } : {},
        ...context.attributes ?? {}
      };
      if (!isRetryable || attempt >= maxAttempts) {
        logWarn(
          "slack_action_failed",
          {},
          {
            ...baseLogAttributes,
            ...mapped.errorData ? { "app.slack.error_data": mapped.errorData } : {}
          },
          "Slack action failed"
        );
        throw mapped;
      }
      logWarn(
        "slack_action_retrying",
        {},
        {
          ...baseLogAttributes,
          "app.slack.retry_attempt": attempt
        },
        "Retrying Slack action after transient failure"
      );
      const retryAfterMs = mapped.code === "rate_limited" && mapped.retryAfterSeconds && mapped.retryAfterSeconds > 0 ? mapped.retryAfterSeconds * 1e3 : void 0;
      const backoffMs = Math.min(2e3, 250 * 2 ** (attempt - 1));
      await sleep(retryAfterMs ?? backoffMs);
    }
  }
  throw new SlackActionError("Slack action exhausted retries", "internal_error");
}
function getSlackClient() {
  return getClient();
}
function isDmChannel(channelId) {
  const normalized = normalizeSlackConversationId(channelId);
  return Boolean(normalized && normalized.startsWith("D"));
}
function isConversationScopedChannel(channelId) {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) return false;
  return normalized.startsWith("C") || normalized.startsWith("G") || normalized.startsWith("D");
}
function isConversationChannel(channelId) {
  const normalized = normalizeSlackConversationId(channelId);
  if (!normalized) return false;
  return normalized.startsWith("C") || normalized.startsWith("G");
}
async function getFilePermalink(fileId) {
  const client2 = getClient();
  const response = await withSlackRetries(
    () => client2.files.info({
      file: fileId
    })
  );
  return response.file?.permalink;
}
async function downloadPrivateSlackFile(url) {
  const token = getSlackBotToken();
  if (!token) {
    throw new SlackActionError(
      "SLACK_BOT_TOKEN (or SLACK_BOT_USER_TOKEN) is required for Slack file downloads in this service",
      "missing_token"
    );
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  if (!response.ok) {
    throw new Error(`Slack file download failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// src/chat/capabilities/jr-rpc-command.ts
import { randomBytes } from "crypto";
import { Bash, defineCommand } from "just-bash";
async function deliverPrivateMessage(input) {
  let client2;
  try {
    client2 = getSlackClient();
  } catch {
    logWarn("oauth_private_delivery_skip", {}, { "app.reason": "missing_bot_token" }, "Skipped private message delivery \u2014 no SLACK_BOT_TOKEN");
    return false;
  }
  if (input.channelId) {
    const isDm = isDmChannel(input.channelId);
    try {
      if (isDm) {
        await client2.chat.postMessage({
          channel: input.channelId,
          text: input.text,
          ...input.threadTs ? { thread_ts: input.threadTs } : {}
        });
      } else {
        await client2.chat.postEphemeral({
          channel: input.channelId,
          user: input.userId,
          text: input.text,
          ...input.threadTs ? { thread_ts: input.threadTs } : {}
        });
      }
      return "in_context";
    } catch (error) {
      const slackError = error instanceof Error ? error.message : String(error);
      logWarn(
        "oauth_private_delivery_failed",
        {},
        { "app.slack.error": slackError, "app.slack.channel": input.channelId },
        `${isDm ? "DM" : "Ephemeral"} message delivery failed, falling back to DM`
      );
    }
  }
  try {
    const openResult = await client2.conversations.open({ users: input.userId });
    const dmChannelId = openResult.channel?.id;
    if (!dmChannelId) {
      logWarn("oauth_dm_fallback_failed", {}, { "app.reason": "no_dm_channel_id" }, "conversations.open returned no channel ID");
      return false;
    }
    await client2.chat.postMessage({ channel: dmChannelId, text: input.text });
    return "fallback_dm";
  } catch (error) {
    const slackError = error instanceof Error ? error.message : String(error);
    logWarn(
      "oauth_dm_fallback_failed",
      {},
      { "app.slack.error": slackError },
      "DM fallback delivery failed"
    );
    return false;
  }
}
function commandResult(input) {
  const stdout = input.stdout === void 0 ? "" : typeof input.stdout === "string" ? input.stdout : `${JSON.stringify(input.stdout, null, 2)}
`;
  return {
    stdout,
    stderr: input.stderr ?? "",
    exitCode: input.exitCode
  };
}
function requireChannelConfiguration(deps) {
  if (deps.channelConfiguration) {
    return { ok: true, configuration: deps.channelConfiguration };
  }
  return {
    ok: false,
    result: commandResult({
      stderr: "jr-rpc config commands require active conversation context\n",
      exitCode: 1
    })
  };
}
function parsePrefixFlag(extras) {
  if (extras.length === 0) {
    return { ok: true };
  }
  if (extras.length === 2 && extras[0] === "--prefix") {
    const prefix = extras[1]?.trim();
    return { ok: true, ...prefix ? { prefix } : {} };
  }
  if (extras.length === 1 && extras[0].startsWith("--prefix=")) {
    const prefix = extras[0].slice("--prefix=".length).trim();
    return { ok: true, ...prefix ? { prefix } : {} };
  }
  return {
    ok: false,
    error: "jr-rpc config list accepts optional --prefix <value>\n"
  };
}
async function handleIssueCredentialCommand(args, deps) {
  const capability = (args[0] ?? "").trim();
  if (!capability) {
    return commandResult({
      stderr: "jr-rpc issue-credential requires a capability argument\n",
      exitCode: 2
    });
  }
  let repoRef;
  const extras = args.slice(1);
  if (extras.length > 0) {
    if (extras.length === 2 && extras[0] === "--repo") {
      repoRef = extras[1];
    } else if (extras.length === 1 && extras[0].startsWith("--repo=")) {
      repoRef = extras[0].slice("--repo=".length);
    } else {
      return {
        stdout: "",
        stderr: "jr-rpc issue-credential requires exactly one capability argument and optional --repo <owner/repo>\n",
        exitCode: 2
      };
    }
    if (!parseRepoTarget(repoRef ?? "")) {
      return {
        stdout: "",
        stderr: "jr-rpc issue-credential --repo must be in owner/repo format\n",
        exitCode: 2
      };
    }
  }
  let outcome;
  try {
    outcome = await deps.capabilityRuntime.enableCapabilityForTurn({
      activeSkill: deps.activeSkill,
      capability,
      ...repoRef ? { repoRef } : {},
      reason: `skill:${deps.activeSkill?.name ?? "unknown"}:jr-rpc:issue-credential`
    });
  } catch (error) {
    if (error instanceof CredentialUnavailableError && getOAuthProviderConfig(error.provider) && deps.requesterId) {
      const oauthResult = await startOAuthFlow(error.provider, {
        requesterId: deps.requesterId,
        channelId: deps.channelId,
        threadTs: deps.threadTs,
        userMessage: deps.userMessage,
        channelConfiguration: deps.channelConfiguration,
        activeSkillName: deps.activeSkill?.name ?? void 0
      });
      if (oauthResult.ok) {
        const providerLabel = error.provider.charAt(0).toUpperCase() + error.provider.slice(1);
        return commandResult({
          stdout: {
            credential_unavailable: true,
            oauth_started: true,
            provider: error.provider,
            private_delivery_sent: !!oauthResult.delivery,
            message: oauthResult.delivery ? `I need to connect your ${providerLabel} account first. I've sent you a private authorization link.` : `I need to connect your ${providerLabel} account first, but I wasn't able to send you a private authorization link. Please send me a direct message and try your command again.`
          },
          exitCode: 1
        });
      }
      return {
        stdout: "",
        stderr: `${oauthResult.error}
`,
        exitCode: 1
      };
    }
    return {
      stdout: "",
      stderr: `${error instanceof Error ? error.message : String(error)}
`,
      exitCode: 1
    };
  }
  return commandResult({
    stdout: `${outcome.reused ? "credential_reused" : "credential_enabled"} capability=${capability} expiresAt=${outcome.expiresAt}
`,
    exitCode: 0
  });
}
async function handleConfigCommand(args, deps) {
  const usage = [
    "jr-rpc config get <key>",
    "jr-rpc config set <key> <value> [--json]",
    "jr-rpc config unset <key>",
    "jr-rpc config list [--prefix <value>]"
  ].join("\n");
  const subverb = (args[0] ?? "").trim();
  const configurationResult = requireChannelConfiguration(deps);
  if (!configurationResult.ok) {
    return configurationResult.result;
  }
  const configuration = configurationResult.configuration;
  if (subverb === "get") {
    const key = (args[1] ?? "").trim();
    if (!key || args.length !== 2) {
      return commandResult({
        stderr: `Usage:
${usage}
`,
        exitCode: 2
      });
    }
    const entry = await configuration.get(key);
    return commandResult({
      stdout: entry ? {
        ok: true,
        key: entry.key,
        scope: entry.scope,
        value: entry.value,
        updatedAt: entry.updatedAt,
        updatedBy: entry.updatedBy,
        source: entry.source
      } : {
        ok: true,
        key,
        found: false
      },
      exitCode: 0
    });
  }
  if (subverb === "set") {
    const key = (args[1] ?? "").trim();
    const valueArg = args[2];
    const extras = args.slice(3);
    if (!key || valueArg === void 0) {
      return commandResult({
        stderr: `Usage:
${usage}
`,
        exitCode: 2
      });
    }
    let parseAsJson = false;
    if (extras.length > 0) {
      if (extras.length === 1 && extras[0] === "--json") {
        parseAsJson = true;
      } else {
        return commandResult({
          stderr: `Usage:
${usage}
`,
          exitCode: 2
        });
      }
    }
    let value = valueArg;
    if (parseAsJson) {
      try {
        value = JSON.parse(valueArg);
      } catch (error) {
        return commandResult({
          stderr: `Invalid JSON value for jr-rpc config set --json: ${error instanceof Error ? error.message : String(error)}
`,
          exitCode: 2
        });
      }
    }
    try {
      const entry = await configuration.set({
        key,
        value,
        updatedBy: deps.requesterId,
        source: "jr-rpc"
      });
      logInfo(
        "jr_rpc_config_set",
        {},
        {
          "app.config.key": entry.key,
          "app.config.scope": entry.scope,
          "app.config.source": entry.source ?? "jr-rpc",
          ...deps.activeSkill?.name ? { "app.skill.name": deps.activeSkill.name } : {}
        },
        "Set channel configuration via jr-rpc"
      );
      deps.onConfigurationValueChanged?.(entry.key, entry.value);
      return commandResult({
        stdout: {
          ok: true,
          key: entry.key,
          scope: entry.scope,
          value: entry.value,
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
          source: entry.source
        },
        exitCode: 0
      });
    } catch (error) {
      return commandResult({
        stderr: `${error instanceof Error ? error.message : String(error)}
`,
        exitCode: 1
      });
    }
  }
  if (subverb === "unset") {
    const key = (args[1] ?? "").trim();
    if (!key || args.length !== 2) {
      return commandResult({
        stderr: `Usage:
${usage}
`,
        exitCode: 2
      });
    }
    const deleted = await configuration.unset(key);
    if (deleted) {
      logInfo(
        "jr_rpc_config_unset",
        {},
        {
          "app.config.key": key,
          ...deps.activeSkill?.name ? { "app.skill.name": deps.activeSkill.name } : {}
        },
        "Unset channel configuration via jr-rpc"
      );
      deps.onConfigurationValueChanged?.(key, void 0);
    }
    return commandResult({
      stdout: {
        ok: true,
        key,
        deleted
      },
      exitCode: 0
    });
  }
  if (subverb === "list") {
    const prefixResult = parsePrefixFlag(args.slice(1));
    if (!prefixResult.ok) {
      return commandResult({
        stderr: prefixResult.error,
        exitCode: 2
      });
    }
    const entries = await configuration.list({
      ...prefixResult.prefix ? { prefix: prefixResult.prefix } : {}
    });
    return commandResult({
      stdout: {
        ok: true,
        entries: entries.map((entry) => ({
          key: entry.key,
          scope: entry.scope,
          value: entry.value,
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
          source: entry.source
        }))
      },
      exitCode: 0
    });
  }
  return commandResult({
    stderr: `Usage:
${usage}
`,
    exitCode: 2
  });
}
function isKnownProvider(provider) {
  return listCapabilityProviders().some((p) => p.provider === provider);
}
function getOAuthProviderConfig(provider) {
  return getPluginOAuthConfig(provider);
}
var OAUTH_STATE_TTL_MS = 10 * 60 * 1e3;
function resolveBaseUrl() {
  const explicit = process.env.JUNIOR_BASE_URL?.trim();
  if (explicit) return explicit;
  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelProd) return `https://${vercelProd}`;
  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl}`;
  return void 0;
}
async function startOAuthFlow(provider, input) {
  const providerConfig = getOAuthProviderConfig(provider);
  if (!providerConfig) {
    return { ok: false, error: `Provider "${provider}" does not support OAuth authorization` };
  }
  const clientId = process.env[providerConfig.clientIdEnv]?.trim();
  if (!clientId) {
    return { ok: false, error: `Missing ${providerConfig.clientIdEnv} environment variable` };
  }
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    return { ok: false, error: "Cannot determine base URL (set JUNIOR_BASE_URL or deploy to Vercel)" };
  }
  let configuration;
  if (input.userMessage && input.channelConfiguration) {
    configuration = await input.channelConfiguration.resolveValues();
  }
  const state = randomBytes(32).toString("hex");
  const stateKey = `oauth-state:${state}`;
  const stateAdapter = getStateAdapter();
  const statePayload = {
    userId: input.requesterId,
    provider,
    ...input.channelId ? { channelId: input.channelId } : {},
    ...input.threadTs ? { threadTs: input.threadTs } : {},
    ...input.userMessage ? { pendingMessage: input.userMessage } : {},
    ...configuration && Object.keys(configuration).length > 0 ? { configuration } : {}
  };
  await stateAdapter.set(stateKey, statePayload, OAUTH_STATE_TTL_MS);
  const redirectUri = `${baseUrl}${providerConfig.callbackPath}`;
  const params = new URLSearchParams({
    client_id: clientId,
    scope: providerConfig.scope,
    state,
    redirect_uri: redirectUri,
    response_type: "code"
  });
  const authorizeUrl = `${providerConfig.authorizeEndpoint}?${params.toString()}`;
  logInfo(
    "jr_rpc_oauth_start",
    {},
    {
      "app.credential.provider": provider,
      ...input.activeSkillName ? { "app.skill.name": input.activeSkillName } : {}
    },
    "Initiated OAuth authorization code flow"
  );
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
  const delivery = await deliverPrivateMessage({
    channelId: input.channelId,
    threadTs: input.threadTs,
    userId: input.requesterId,
    text: `<${authorizeUrl}|Click here to link your ${providerLabel} account>. Once you've authorized, you'll see a confirmation in Slack.`
  });
  return { ok: true, delivery };
}
async function handleOAuthStartCommand(args, deps) {
  const provider = (args[0] ?? "").trim();
  if (!provider) {
    return commandResult({
      stderr: "jr-rpc oauth-start requires: <provider>\n",
      exitCode: 2
    });
  }
  if (args.length > 1) {
    return commandResult({
      stderr: "jr-rpc oauth-start accepts only a provider argument\n",
      exitCode: 2
    });
  }
  if (deps.requesterId && deps.userTokenStore) {
    const stored = await deps.userTokenStore.get(deps.requesterId, provider);
    if (stored && stored.expiresAt > Date.now()) {
      const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
      return commandResult({
        stdout: {
          ok: true,
          already_connected: true,
          provider,
          message: `Your ${providerLabel} account is already connected.`
        },
        exitCode: 0
      });
    }
  }
  if (!deps.requesterId) {
    return commandResult({
      stderr: "jr-rpc oauth-start requires requester context (requesterId)\n",
      exitCode: 1
    });
  }
  const result = await startOAuthFlow(provider, {
    requesterId: deps.requesterId,
    channelId: deps.channelId,
    threadTs: deps.threadTs,
    activeSkillName: deps.activeSkill?.name ?? void 0
  });
  if (!result.ok) {
    return commandResult({ stderr: `${result.error}
`, exitCode: 1 });
  }
  if (!result.delivery) {
    return commandResult({
      stdout: {
        ok: true,
        private_delivery_sent: false,
        message: "I wasn't able to send you a private authorization link. Please send me a direct message and try again."
      },
      exitCode: 0
    });
  }
  return commandResult({
    stdout: {
      ok: true,
      private_delivery_sent: true
    },
    exitCode: 0
  });
}
async function handleDeleteTokenCommand(args, deps) {
  const provider = (args[0] ?? "").trim();
  if (!provider) {
    return commandResult({
      stderr: "jr-rpc delete-token requires: <provider>\n",
      exitCode: 2
    });
  }
  if (!isKnownProvider(provider)) {
    return commandResult({
      stderr: `Unknown provider: ${provider}
`,
      exitCode: 2
    });
  }
  if (!deps.requesterId) {
    return commandResult({
      stderr: "jr-rpc delete-token requires requester context (requesterId)\n",
      exitCode: 1
    });
  }
  if (!deps.userTokenStore) {
    return commandResult({
      stderr: "Token storage is not available\n",
      exitCode: 1
    });
  }
  await deps.userTokenStore.delete(deps.requesterId, provider);
  logInfo(
    "jr_rpc_delete_token",
    {},
    {
      "app.credential.provider": provider,
      ...deps.activeSkill?.name ? { "app.skill.name": deps.activeSkill.name } : {}
    },
    "Deleted user token via jr-rpc"
  );
  return commandResult({
    stdout: `token_deleted provider=${provider}
`,
    exitCode: 0
  });
}
function createJrRpcCommand(deps) {
  return defineCommand("jr-rpc", async (args) => {
    const usage = [
      "jr-rpc issue-credential <capability> [--repo <owner/repo>]",
      "jr-rpc oauth-start <provider>",
      "jr-rpc delete-token <provider>",
      "jr-rpc config get <key>",
      "jr-rpc config set <key> <value> [--json]",
      "jr-rpc config unset <key>",
      "jr-rpc config list [--prefix <value>]"
    ].join("\n");
    const verb = (args[0] ?? "").trim();
    if (verb === "issue-credential") {
      return handleIssueCredentialCommand(args.slice(1), deps);
    }
    if (verb === "oauth-start") {
      return handleOAuthStartCommand(args.slice(1), deps);
    }
    if (verb === "delete-token") {
      return handleDeleteTokenCommand(args.slice(1), deps);
    }
    if (verb === "config") {
      return handleConfigCommand(args.slice(1), deps);
    }
    return commandResult({
      stderr: `Unsupported jr-rpc command. Use:
${usage}
`,
      exitCode: 2
    });
  });
}
async function maybeExecuteJrRpcCustomCommand(command, deps) {
  const normalized = command.trim();
  if (!/^jr-rpc(?:\s|$)/.test(normalized)) {
    return { handled: false };
  }
  const shell = new Bash({
    customCommands: [createJrRpcCommand(deps)]
  });
  const execResult = await shell.exec(normalized);
  return {
    handled: true,
    result: {
      ok: execResult.exitCode === 0,
      command: normalized,
      cwd: "/",
      exit_code: execResult.exitCode,
      signal: null,
      timed_out: false,
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      stdout_truncated: false,
      stderr_truncated: false
    }
  };
}

// src/chat/xml.ts
function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

// src/chat/status-format.ts
var SLACK_STATUS_MAX_LENGTH = 50;
function truncateWithEllipsis(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}
function truncateStatusText(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return truncateWithEllipsis(trimmed, SLACK_STATUS_MAX_LENGTH);
}
function compactStatusPath(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return void 0;
  }
  if (trimmed.length <= 80) {
    return trimmed;
  }
  return `...${trimmed.slice(-77)}`;
}
function compactStatusText(value, maxLength = 80) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return void 0;
  }
  return truncateWithEllipsis(trimmed, maxLength);
}
function compactStatusFilename(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim().replace(/[\\/]+$/g, "");
  if (!trimmed) {
    return void 0;
  }
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  const filename = parts.length > 0 ? parts[parts.length - 1] : trimmed;
  return compactStatusText(filename, 80);
}
function extractStatusUrlDomain(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return void 0;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || void 0;
  } catch {
    return void 0;
  }
}

// src/chat/respond.ts
import { Agent } from "@mariozechner/pi-agent-core";
import { Value } from "@sinclair/typebox/value";

// src/chat/gen-ai-attributes.ts
var DEFAULT_MAX_ATTRIBUTE_CHARS = 12e3;
var MAX_STRING_CHARS = 2e3;
var MAX_ARRAY_ITEMS = 50;
var MAX_OBJECT_KEYS = 50;
function asRecord(value) {
  return value && typeof value === "object" ? value : void 0;
}
function truncateString(value, maxChars) {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
function sanitizeForSerialization(value, seen, depth, keyName) {
  if (value === null || value === void 0) {
    return void 0;
  }
  if (typeof value === "string") {
    const shouldTreatAsBlob = (keyName === "data" || keyName === "base64" || keyName?.endsWith("_base64") === true) && value.length > 256;
    if (shouldTreatAsBlob) {
      return `[omitted:${value.length}]`;
    }
    return truncateString(value, MAX_STRING_CHARS);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : void 0;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (depth >= 8) {
    return "[depth_limit]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeForSerialization(entry, seen, depth + 1)).filter((entry) => entry !== void 0);
  }
  if (typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  const record = value;
  const out = {};
  for (const [key, entryValue] of Object.entries(record).slice(0, MAX_OBJECT_KEYS)) {
    const sanitized = sanitizeForSerialization(entryValue, seen, depth + 1, key);
    if (sanitized !== void 0) {
      out[key] = sanitized;
    }
  }
  return out;
}
function serializeGenAiAttribute(value, maxChars = DEFAULT_MAX_ATTRIBUTE_CHARS) {
  const sanitized = sanitizeForSerialization(value, /* @__PURE__ */ new WeakSet(), 0);
  if (sanitized === void 0) {
    return void 0;
  }
  const serialized = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  if (!serialized) {
    return void 0;
  }
  return truncateString(serialized, maxChars);
}
function toFiniteTokenCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return void 0;
  }
  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : void 0;
}
function readTokenCount(root, keys) {
  for (const key of keys) {
    const value = toFiniteTokenCount(root[key]);
    if (value !== void 0) {
      return value;
    }
  }
  return void 0;
}
function collectUsageRoots(source) {
  const sourceRecord = asRecord(source);
  if (!sourceRecord) {
    return [];
  }
  const roots = [sourceRecord];
  const usage = asRecord(sourceRecord.usage);
  if (usage) {
    roots.push(usage);
  }
  const tokenUsage = asRecord(sourceRecord.tokenUsage);
  if (tokenUsage) {
    roots.push(tokenUsage);
  }
  const providerMetadata = asRecord(sourceRecord.providerMetadata);
  if (providerMetadata) {
    roots.push(providerMetadata);
    const providerUsage = asRecord(providerMetadata.usage);
    if (providerUsage) {
      roots.push(providerUsage);
    }
  }
  const response = asRecord(sourceRecord.response);
  if (response) {
    roots.push(response);
    const responseUsage = asRecord(response.usage);
    if (responseUsage) {
      roots.push(responseUsage);
    }
  }
  return roots;
}
function extractGenAiUsageAttributes(...sources) {
  const roots = sources.flatMap((source) => collectUsageRoots(source));
  if (roots.length === 0) {
    return {};
  }
  const inputTokens = roots.map(
    (root) => readTokenCount(root, [
      "input_tokens",
      "inputTokens",
      "prompt_tokens",
      "promptTokens",
      "inputTokenCount",
      "promptTokenCount"
    ])
  ).find((value) => value !== void 0) ?? void 0;
  const outputTokens = roots.map(
    (root) => readTokenCount(root, [
      "output_tokens",
      "outputTokens",
      "completion_tokens",
      "completionTokens",
      "outputTokenCount",
      "completionTokenCount"
    ])
  ).find((value) => value !== void 0) ?? void 0;
  return {
    ...inputTokens !== void 0 ? { "gen_ai.usage.input_tokens": inputTokens } : {},
    ...outputTokens !== void 0 ? { "gen_ai.usage.output_tokens": outputTokens } : {}
  };
}

// src/chat/prompt.ts
import fs from "fs";

// src/chat/output.ts
var MAX_INLINE_CHARS = 2200;
var MAX_INLINE_LINES = 45;
function ensureBlockSpacing(text) {
  const codeBlockPattern = /^```/;
  const listItemPattern = /^[-*•]\s|^\d+\.\s/;
  const lines = text.split("\n");
  const result = [];
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isCodeFence = codeBlockPattern.test(line.trimStart());
    if (isCodeFence) {
      if (!inCodeBlock) {
        const prev2 = result.length > 0 ? result[result.length - 1] : void 0;
        if (prev2 !== void 0 && prev2.trim() !== "") {
          result.push("");
        }
      }
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      continue;
    }
    const prev = result.length > 0 ? result[result.length - 1] : void 0;
    if (prev !== void 0 && prev.trim() !== "" && line.trim() !== "" && !(listItemPattern.test(prev.trimStart()) && listItemPattern.test(line.trimStart()))) {
      result.push("");
    }
    result.push(line);
  }
  return result.join("\n");
}
function normalizeForSlack(text) {
  let normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  normalized = ensureBlockSpacing(normalized);
  return normalized.replace(/\n{3,}/g, "\n\n").trim();
}
function buildSlackOutputMessage(text, options = {}) {
  const normalized = normalizeForSlack(text);
  if (!normalized) {
    logWarn("slack_output_normalized_empty", {}, {
      "app.output.original_length": text.length,
      "app.output.parsed_length": normalized.length,
      "app.output.file_count": options.files?.length ?? 0
    }, "Slack output normalized to empty content");
    return {
      markdown: "I couldn't produce a response.",
      files: options.files
    };
  }
  return {
    markdown: normalized,
    files: options.files
  };
}
var slackOutputPolicy = {
  maxInlineChars: MAX_INLINE_CHARS,
  maxInlineLines: MAX_INLINE_LINES
};

// src/chat/sandbox/paths.ts
function normalizeWorkspaceRoot(input) {
  const candidate = (input ?? "").trim();
  if (!candidate) {
    return "/vercel/sandbox";
  }
  const normalized = candidate.replace(/\/+$/, "");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
var SANDBOX_WORKSPACE_ROOT = normalizeWorkspaceRoot(process.env.VERCEL_SANDBOX_WORKSPACE_DIR);
var SANDBOX_SKILLS_ROOT = `${SANDBOX_WORKSPACE_ROOT}/skills`;
function sandboxSkillDir(skillName) {
  return `${SANDBOX_SKILLS_ROOT}/${skillName}`;
}

// src/chat/prompt.ts
function loadSoul() {
  const resolved = soulPath();
  const raw = fs.readFileSync(resolved, "utf8").trim();
  if (raw.length === 0) {
    throw new Error(`SOUL.md is empty: ${resolved}`);
  }
  return raw;
}
var JUNIOR_PERSONALITY = loadSoul();
function workspaceSkillDir(skillName) {
  return sandboxSkillDir(skillName);
}
function formatConfigurationValue(value) {
  if (typeof value === "string") {
    return escapeXml(value);
  }
  try {
    return escapeXml(JSON.stringify(value));
  } catch {
    return escapeXml(String(value));
  }
}
function renderIdentityBlock(tag, fields) {
  const lines = Object.entries(fields).filter(([, value]) => Boolean(value)).map(([key, value]) => `- ${key}: ${escapeXml(value)}`);
  if (lines.length === 0) {
    return [`<${tag}>`, "none", `</${tag}>`].join("\n");
  }
  return [`<${tag}>`, ...lines, `</${tag}>`].join("\n");
}
function renderTag(tag, content) {
  return [`<${tag}>`, content, `</${tag}>`].join("\n");
}
function formatAvailableSkillsForPrompt(skills) {
  if (skills.length === 0) {
    return "<available_skills>\n</available_skills>";
  }
  const lines = ["<available_skills>"];
  for (const skill of skills) {
    const skillLocation = `${workspaceSkillDir(skill.name)}/SKILL.md`;
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skillLocation)}</location>`);
    if (skill.usesConfig && skill.usesConfig.length > 0) {
      lines.push(`    <uses_config>${escapeXml(skill.usesConfig.join(" "))}</uses_config>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
function formatLoadedSkillsForPrompt(skills) {
  if (skills.length === 0) {
    return "<loaded_skills>\n</loaded_skills>";
  }
  const lines = ["<loaded_skills>"];
  for (const skill of skills) {
    const skillDir = workspaceSkillDir(skill.name);
    lines.push(`  <skill name="${escapeXml(skill.name)}" location="${escapeXml(`${skillDir}/SKILL.md`)}">`);
    lines.push(`References are relative to ${escapeXml(skillDir)}.`);
    if (skill.usesConfig && skill.usesConfig.length > 0) {
      lines.push(`Uses config keys: ${escapeXml(skill.usesConfig.join(", "))}.`);
    }
    lines.push("");
    lines.push(skill.body);
    lines.push("  </skill>");
  }
  lines.push("</loaded_skills>");
  return lines.join("\n");
}
function formatProviderCatalogForPrompt() {
  const providers = listCapabilityProviders();
  if (providers.length === 0) {
    return "- none";
  }
  const lines = [];
  for (const provider of providers) {
    lines.push(`- provider: ${escapeXml(provider.provider)}`);
    lines.push(
      `  - config_keys: ${provider.configKeys.length > 0 ? escapeXml(provider.configKeys.join(", ")) : "none"}`
    );
    lines.push(
      `  - capabilities: ${provider.capabilities.length > 0 ? escapeXml(provider.capabilities.join(", ")) : "none"}`
    );
  }
  return lines.join("\n");
}
function baseSystemPrompt() {
  return [
    "You are a Slack-based helper assistant.",
    "Identity, tone, and domain defaults are defined in the personality block.",
    "",
    "- Be concise, practical, and specific.",
    "- Prefer actionable next steps over generic explanations.",
    "- When the user gives a clear task, execute it immediately in this turn.",
    "- Do not ask for permission to proceed when the request is already clear.",
    "- Keep user-visible progress communication concise and useful.",
    "- Never ask the user to re-tag or re-invoke for a clear task; continue execution in this turn.",
    "- Never claim you cannot access tools in this turn. If prior results are empty, run tools now.",
    "- If critical input is missing and cannot be discovered with tools, ask one direct clarifying question.",
    "- Always gather evidence from available sources (tools or skills) before answering factual questions.",
    "- Never guess. If you cannot verify with available sources, say it is unverified.",
    "- Never claim a lookup succeeded unless a tool result supports it.",
    "- Do not give up when unsure how to do something; find a viable path, gather evidence, and provide the best actionable way forward.",
    "- When active skills are present, follow their instructions before default behavior."
  ].join("\n");
}
function buildSystemPrompt(params) {
  const {
    availableSkills,
    activeSkills,
    invocation,
    requester,
    assistant,
    artifactState,
    configuration,
    relevantConfigurationKeys
  } = params;
  const assistantSection = renderIdentityBlock("assistant", {
    user_name: assistant?.userName ?? botConfig.userName,
    user_id: assistant?.userId
  });
  const requesterSection = renderIdentityBlock("requester", {
    full_name: requester?.fullName,
    user_name: requester?.userName,
    user_id: requester?.userId
  });
  const availableSkillsSection = [
    "The following skills provide specialized instructions for specific tasks.",
    "Call `loadSkill` when the task matches a skill description.",
    "When a skill references a relative path, resolve it against `skill_dir` and use that path with `bash`.",
    "",
    formatAvailableSkillsForPrompt(availableSkills)
  ].join("\n");
  const activeSkillsSection = [
    "Loaded skills for this turn:",
    formatLoadedSkillsForPrompt(activeSkills)
  ].join("\n");
  const configurationKeys = Object.keys(configuration ?? {}).sort((a, b) => a.localeCompare(b));
  const relevantConfigSet = new Set(
    (relevantConfigurationKeys ?? []).filter((key) => Object.prototype.hasOwnProperty.call(configuration ?? {}, key))
  );
  const relevantConfigLines = configurationKeys.filter((key) => relevantConfigSet.has(key)).map((key) => `  - ${escapeXml(key)}: ${formatConfigurationValue(configuration?.[key])}`);
  const otherConfigLines = configurationKeys.filter((key) => !relevantConfigSet.has(key)).map((key) => `  - ${escapeXml(key)}: ${formatConfigurationValue(configuration?.[key])}`);
  const configurationSection = [
    "Use these conversation-scoped defaults when the user has not provided explicit values in this turn.",
    "If explicit user input conflicts with configuration, follow explicit user input.",
    configurationKeys.length === 0 ? "- none" : [
      ...relevantConfigLines.length > 0 ? ["- relevant_for_active_skills:", ...relevantConfigLines] : [],
      ...otherConfigLines.length > 0 ? ["- other_available_keys:", ...otherConfigLines] : []
    ].join("\n")
  ].join("\n");
  const sections = [
    baseSystemPrompt(),
    renderTag(
      "personality",
      [
        "Always follow the personality guidance for tone/style unless safety or policy constraints require otherwise.",
        "",
        JUNIOR_PERSONALITY.trim()
      ].join("\n")
    ),
    renderTag(
      "identity-context",
      [
        "Use these blocks as authoritative metadata for identity questions.",
        assistantSection,
        requesterSection
      ].join("\n")
    ),
    renderTag(
      "artifact-context",
      [
        "Use this thread-scoped memory for follow-up updates to existing Slack artifacts.",
        artifactState ? [
          artifactState.lastCanvasId ? `- last_canvas_id: ${escapeXml(artifactState.lastCanvasId)}` : "- last_canvas_id: none",
          artifactState.lastCanvasUrl ? `- last_canvas_url: ${escapeXml(artifactState.lastCanvasUrl)}` : "- last_canvas_url: none",
          artifactState.recentCanvases && artifactState.recentCanvases.length > 0 ? [
            "- recent_canvases:",
            ...artifactState.recentCanvases.map(
              (canvas) => [
                `  - id: ${escapeXml(canvas.id)}`,
                canvas.title ? `    title: ${escapeXml(canvas.title)}` : "    title: [unknown]",
                canvas.url ? `    url: ${escapeXml(canvas.url)}` : "    url: [unknown]",
                canvas.createdAt ? `    created_at: ${escapeXml(canvas.createdAt)}` : "    created_at: [unknown]"
              ].join("\n")
            )
          ].join("\n") : "- recent_canvases: none",
          artifactState.lastListId ? `- last_list_id: ${escapeXml(artifactState.lastListId)}` : "- last_list_id: none",
          artifactState.lastListUrl ? `- last_list_url: ${escapeXml(artifactState.lastListUrl)}` : "- last_list_url: none"
        ].join("\n") : "- none"
      ].join("\n")
    ),
    renderTag("configuration-context", configurationSection),
    renderTag(
      "provider-capabilities",
      [
        "Use this catalog to map provider intents to valid config keys and capability names.",
        "When user intent is to set a provider default, choose a config key from this catalog and use jr-rpc config set.",
        formatProviderCatalogForPrompt()
      ].join("\n")
    ),
    renderTag(
      "tool-usage",
      [
        "- For factual or external questions, run tools/skills first, then answer from evidence.",
        "- Use tool descriptions as the source of truth for when each tool should or should not be called.",
        "- Use `bash` to inspect skill files from `skill_dir` and run shell commands inside the sandbox workspace.",
        "- Use `imageGenerate` when the user asks for image creation.",
        "- Use `slackCanvasCreate` for long-form docs/specs and `slackCanvasUpdate` for doc follow-ups.",
        "- `slackCanvasUpdate` targets the active artifact-context canvas automatically; do not ask the user for `canvas_id`.",
        "- Use `slackListCreate`, `slackListAddItems`, and `slackListUpdateItem` for actionable task tracking.",
        "- `slackListAddItems`, `slackListGetItems`, and `slackListUpdateItem` target the active artifact-context list automatically; do not ask the user for `list_id`.",
        "- If the user explicitly asks to post/send/share/say/show/announce/broadcast in the channel (outside this thread), call `slackChannelPostMessage` with the requested text instead of only replying in-thread.",
        "- For explicit in-channel post requests, prefer no thread text reply after a successful channel post. A reaction-only acknowledgment is acceptable when useful.",
        "- Use `slackMessageAddReaction` for rare lightweight acknowledgements. It reacts to the current inbound message via runtime context; never pick a target message yourself.",
        "- If the user explicitly asks for an emoji reaction instead of text, use `slackMessageAddReaction` with a Slack emoji alias name (for example `thumbsup`, not unicode emoji), and avoid redundant acknowledgment text.",
        "- Suggested acknowledgement reactions include \u{1F44B}, \u2705, \u{1F44D}, and \u{1F440}, but choose what best fits the request.",
        "- To enable provider credentials for this turn, run `jr-rpc issue-credential <capability> [--repo <owner/repo>]` as a bash command before commands that need authenticated API calls.",
        "- To persist or read conversation defaults (for example `github.repo`), run `jr-rpc config get|set|unset|list ...` as a bash command.",
        "- Capabilities are provider-qualified (for example `github.issues.write`).",
        "- When your work is complete, provide the exact user-facing markdown response.",
        "- Do not use reaction-based progress signals; Assistants API status already covers in-progress UX.",
        "- Prefer `webSearch` before `webFetch` when the user gave no URL.",
        "- Never call side-effecting tools when the user only asked for analysis or options."
      ].join("\n")
    ),
    renderTag(
      "skills",
      [
        "- For explicit slash commands, treat `/skill-name` as authoritative intent for that skill.",
        "- If slash-invoked skill instructions are already present in <loaded_skills>, apply them immediately.",
        "- Otherwise, for slash-invoked skills, call `loadSkill` for that exact skill before applying skill-specific behavior.",
        "- For non-slash requests where a skill clearly matches, call `loadSkill` before applying skill-specific behavior.",
        "- Do not claim to have used a skill unless it is present in <loaded_skills> or `loadSkill` succeeded in this turn.",
        "- Never apply skill-specific behavior unless the skill is present in <loaded_skills> or `loadSkill` succeeded in this turn.",
        "- Load only the best matching skill first; do not load multiple skills upfront.",
        "- After `loadSkill`, use `skill_dir` as the root for any referenced files you read via `bash`.",
        "- If no skill is a clear fit, continue with normal tool usage."
      ].join("\n")
    ),
    renderTag(
      "output-contract",
      [
        "Always produce output that follows this contract:",
        `<output format="slack-mrkdwn" max_inline_chars="${slackOutputPolicy.maxInlineChars}" max_inline_lines="${slackOutputPolicy.maxInlineLines}">`,
        "- Use plain Slack-safe markdown (headings, bullets, short code blocks).",
        "- Keep normal responses brief and scannable.",
        "- If depth is needed, start with a concise summary and then provide fuller detail.",
        "- A brief initial acknowledgment before significant tool work is fine; avoid extended process chatter or repeated status updates.",
        "- Avoid tables unless explicitly requested.",
        "- End every turn with a final user-facing markdown response.",
        "</output>"
      ].join("\n")
    ),
    availableSkillsSection,
    activeSkillsSection,
    renderTag(
      "invocation-context",
      invocation ? `Slash invocation detected: /${invocation.skillName}` : "No slash invocation detected."
    )
  ];
  return sections.join("\n\n");
}

// src/chat/channel-intent.ts
function isExplicitChannelPostIntent(text) {
  if (!/\bchannel\b/i.test(text)) {
    return false;
  }
  const directChannelVerb = /\b(show|post|send|share|say|announce|broadcast)\b[\s\S]{0,80}\b(?:the\s+)?channel\b/i;
  if (directChannelVerb.test(text)) {
    return true;
  }
  const scopedChannelVerb = /\b(post|send|share|say|announce|broadcast)\b[\s\S]{0,80}\b(?:in|to)\b[\s\S]{0,40}\b(?:the\s+)?channel\b/i;
  return scopedChannelVerb.test(text);
}

// src/chat/delivery/plan.ts
function buildReplyDeliveryPlan(args) {
  const mode = args.explicitChannelPostIntent && args.channelPostPerformed ? "channel_only" : "thread";
  let attachFiles = "none";
  if (args.hasFiles && mode === "thread") {
    attachFiles = args.streamingThreadReply ? "followup" : "inline";
  }
  return {
    mode,
    ack: args.reactionPerformed ? "reaction" : "none",
    postThreadText: mode === "thread",
    attachFiles
  };
}

// src/chat/skill-sandbox.ts
import fs3 from "fs/promises";
import path4 from "path";

// src/chat/skills.ts
import fs2 from "fs/promises";
import path3 from "path";

// src/chat/skill-frontmatter.ts
import { parse as parseYaml2 } from "yaml";
var FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
var SKILL_NAME_RE = /^[a-z0-9-]+$/;
var CAPABILITY_TOKEN_RE = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/;
var MAX_NAME_LENGTH = 64;
var MAX_DESCRIPTION_LENGTH = 1024;
var MAX_COMPATIBILITY_LENGTH = 500;
function hasAngleBrackets(value) {
  return value.includes("<") || value.includes(">");
}
function validateSkillName(name) {
  if (!name) return "name must not be empty";
  if (name.length > MAX_NAME_LENGTH) return `name must be <= ${MAX_NAME_LENGTH} characters`;
  if (!SKILL_NAME_RE.test(name)) return "name must contain only lowercase letters, digits, and hyphens";
  if (name.startsWith("-") || name.endsWith("-")) return "name must not start or end with a hyphen";
  if (name.includes("--")) return "name must not contain consecutive hyphens";
  return null;
}
function stripFrontmatter(raw) {
  return raw.replace(FRONTMATTER_RE, "").trim();
}
function parseAndValidateSkillFrontmatter(raw, expectedName) {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { ok: false, error: "Missing YAML frontmatter at start of file" };
  }
  let parsed;
  try {
    parsed = parseYaml2(match[1]);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Frontmatter must be a YAML object" };
  }
  const frontmatter = parsed;
  const name = frontmatter.name;
  const description = frontmatter.description;
  if (typeof name !== "string") {
    return { ok: false, error: 'Frontmatter field "name" must be a string' };
  }
  const nameError = validateSkillName(name);
  if (nameError) {
    return { ok: false, error: nameError };
  }
  if (expectedName && name !== expectedName) {
    return { ok: false, error: `name "${name}" must match directory "${expectedName}"` };
  }
  if (typeof description !== "string") {
    return { ok: false, error: 'Frontmatter field "description" must be a string' };
  }
  if (!description.trim()) {
    return { ok: false, error: "description must not be empty" };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `description must be <= ${MAX_DESCRIPTION_LENGTH} characters` };
  }
  if (hasAngleBrackets(description)) {
    return { ok: false, error: 'description must not contain "<" or ">"' };
  }
  if ("metadata" in frontmatter && (typeof frontmatter.metadata !== "object" || !frontmatter.metadata || Array.isArray(frontmatter.metadata))) {
    return { ok: false, error: 'Frontmatter field "metadata" must be an object when present' };
  }
  if ("compatibility" in frontmatter) {
    if (typeof frontmatter.compatibility !== "string") {
      return { ok: false, error: 'Frontmatter field "compatibility" must be a string when present' };
    }
    if (frontmatter.compatibility.length > MAX_COMPATIBILITY_LENGTH) {
      return { ok: false, error: `compatibility must be <= ${MAX_COMPATIBILITY_LENGTH} characters` };
    }
  }
  if ("license" in frontmatter && typeof frontmatter.license !== "string") {
    return { ok: false, error: 'Frontmatter field "license" must be a string when present' };
  }
  if ("allowed-tools" in frontmatter && typeof frontmatter["allowed-tools"] !== "string") {
    return { ok: false, error: 'Frontmatter field "allowed-tools" must be a string when present' };
  }
  if ("requires-capabilities" in frontmatter) {
    if (typeof frontmatter["requires-capabilities"] !== "string") {
      return { ok: false, error: 'Frontmatter field "requires-capabilities" must be a string when present' };
    }
    const tokens = frontmatter["requires-capabilities"].split(/\s+/).map((token) => token.trim()).filter((token) => token.length > 0);
    for (const token of tokens) {
      if (!CAPABILITY_TOKEN_RE.test(token)) {
        return {
          ok: false,
          error: `requires-capabilities token "${token}" is invalid; expected dotted lowercase tokens (for example "github.issues.write")`
        };
      }
    }
  }
  if ("uses-config" in frontmatter) {
    if (typeof frontmatter["uses-config"] !== "string") {
      return { ok: false, error: 'Frontmatter field "uses-config" must be a string when present' };
    }
    const tokens = frontmatter["uses-config"].split(/\s+/).map((token) => token.trim()).filter((token) => token.length > 0);
    for (const token of tokens) {
      if (!CAPABILITY_TOKEN_RE.test(token)) {
        return {
          ok: false,
          error: `uses-config token "${token}" is invalid; expected dotted lowercase tokens (for example "github.repo")`
        };
      }
    }
  }
  return {
    ok: true,
    frontmatter: {
      ...frontmatter,
      name,
      description
    }
  };
}

// src/chat/skills.ts
var SKILL_CACHE_TTL_MS = 5e3;
var skillCache = null;
function resolveSkillRoots(options) {
  const additionalRoots = options?.additionalRoots ?? [];
  const envRoots = process.env.SKILL_DIRS?.split(path3.delimiter).filter(Boolean) ?? [];
  const defaults = [skillsDir()];
  const pluginRoots = getPluginSkillRoots();
  const seen = /* @__PURE__ */ new Set();
  const resolved = [];
  for (const root of [...additionalRoots, ...envRoots, ...defaults, ...pluginRoots]) {
    const normalized = path3.resolve(root);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    resolved.push(normalized);
  }
  return resolved;
}
function parseAllowedTools(value) {
  return parseTokenList(value);
}
function parseRequiresCapabilities(value) {
  return parseTokenList(value);
}
function parseUsesConfig(value) {
  return parseTokenList(value);
}
function parseTokenList(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const parsed = value.split(/\s+/).map((token) => token.trim()).filter((token) => token.length > 0);
  return parsed.length > 0 ? parsed : void 0;
}
function validateSkillMetadata(input) {
  const unknownCapabilities = (input.requiresCapabilities ?? []).filter(
    (capability) => !isKnownCapability(capability)
  );
  if (unknownCapabilities.length > 0) {
    return `Unknown requires-capabilities values: ${unknownCapabilities.join(", ")}`;
  }
  const unknownConfigKeys = (input.usesConfig ?? []).filter((configKey) => !isKnownConfigKey(configKey));
  if (unknownConfigKeys.length > 0) {
    return `Unknown uses-config values: ${unknownConfigKeys.join(", ")}`;
  }
  return void 0;
}
async function readSkillDirectory(skillDir) {
  const skillFile = path3.join(skillDir, "SKILL.md");
  try {
    const raw = await fs2.readFile(skillFile, "utf8");
    const parsed = parseAndValidateSkillFrontmatter(raw, path3.basename(skillDir));
    if (!parsed.ok) {
      logWarn("skill_frontmatter_invalid", {}, {
        "file.path": skillDir,
        "error.message": parsed.error
      }, "Invalid skill frontmatter");
      return null;
    }
    const { name, description } = parsed.frontmatter;
    const allowedTools = parseAllowedTools(parsed.frontmatter["allowed-tools"]);
    const requiresCapabilities = parseRequiresCapabilities(parsed.frontmatter["requires-capabilities"]);
    const usesConfig = parseUsesConfig(parsed.frontmatter["uses-config"]);
    const metadataError = validateSkillMetadata({ requiresCapabilities, usesConfig });
    if (metadataError) {
      logWarn("skill_frontmatter_invalid", {}, {
        "file.path": skillDir,
        "error.message": metadataError
      }, "Invalid skill frontmatter");
      return null;
    }
    return {
      name,
      description,
      skillPath: skillDir,
      allowedTools,
      requiresCapabilities,
      usesConfig
    };
  } catch (error) {
    logWarn("skill_directory_read_failed", {}, {
      "file.path": skillDir,
      "error.message": error instanceof Error ? error.message : String(error)
    }, "Failed to read skill directory");
    return null;
  }
}
async function discoverSkills(options) {
  const roots = resolveSkillRoots(options);
  const cacheKey = roots.join(path3.delimiter);
  if (skillCache && skillCache.expiresAt > Date.now() && skillCache.key === cacheKey) {
    return skillCache.skills;
  }
  const discovered = [];
  const seen = /* @__PURE__ */ new Set();
  for (const root of roots) {
    try {
      const entries = await fs2.readdir(root, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) {
          continue;
        }
        const skill = await readSkillDirectory(path3.join(root, entry.name));
        if (skill && !seen.has(skill.name)) {
          seen.add(skill.name);
          discovered.push(skill);
        }
      }
    } catch (error) {
      logWarn("skill_root_read_failed", {}, {
        "file.directory": root,
        "error.message": error instanceof Error ? error.message : String(error)
      }, "Failed to read skill root");
    }
  }
  const sorted = discovered.sort((a, b) => a.name.localeCompare(b.name));
  skillCache = {
    expiresAt: Date.now() + SKILL_CACHE_TTL_MS,
    key: cacheKey,
    skills: sorted
  };
  return sorted;
}
function parseSkillInvocation(messageText, availableSkills) {
  const trimmed = messageText.trim();
  const match = /(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?/i.exec(trimmed);
  if (!match) {
    return null;
  }
  const skillName = match[1].toLowerCase();
  if (!availableSkills.some((s) => s.name === skillName)) {
    return null;
  }
  const args = (match[2] ?? "").trim();
  return {
    skillName,
    args
  };
}
function findSkillByName(skillName, available) {
  return available.find((skill) => skill.name === skillName) ?? null;
}
async function loadSkillsByName(skillNames, available) {
  const selected = new Set(skillNames);
  const skills = [];
  for (const meta of available) {
    if (!selected.has(meta.name)) {
      continue;
    }
    const skillFile = path3.join(meta.skillPath, "SKILL.md");
    const raw = await fs2.readFile(skillFile, "utf8");
    skills.push({
      ...meta,
      body: stripFrontmatter(raw)
    });
  }
  return skills;
}

// src/chat/skill-sandbox.ts
var MAX_SKILL_FILE_BYTES = 256 * 1024;
var DEFAULT_MAX_SKILL_FILE_CHARS = 2e4;
var DEFAULT_MAX_SKILL_LIST_ENTRIES = 200;
function normalizePathForOutput(value) {
  return value.split(path4.sep).join("/");
}
function normalizeSkillName(value) {
  return value.trim().toLowerCase();
}
function resolvePathWithinRoot(root, relativePath) {
  if (!relativePath.trim()) {
    throw new Error("Path must not be empty.");
  }
  if (path4.isAbsolute(relativePath)) {
    throw new Error("Absolute paths are not allowed.");
  }
  const resolvedRoot = path4.resolve(root);
  const resolvedPath = path4.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path4.sep}`)) {
    throw new Error("Path escapes the skill directory.");
  }
  return resolvedPath;
}
var SkillSandbox = class {
  availableSkills;
  availableByName = /* @__PURE__ */ new Map();
  loadedSkills = /* @__PURE__ */ new Map();
  activeSkillName = null;
  constructor(availableSkills, preloadedSkills = []) {
    this.availableSkills = [...availableSkills].sort((a, b) => a.name.localeCompare(b.name));
    for (const skill of this.availableSkills) {
      this.availableByName.set(normalizeSkillName(skill.name), skill);
    }
    for (const skill of preloadedSkills) {
      const key = normalizeSkillName(skill.name);
      this.loadedSkills.set(key, skill);
      this.activeSkillName = key;
    }
  }
  getAvailableSkills() {
    return [...this.availableSkills];
  }
  getLoadedSkillNames() {
    return [...this.loadedSkills.values()].map((skill) => skill.name).sort((a, b) => a.localeCompare(b));
  }
  getActiveSkill() {
    if (!this.activeSkillName) {
      return null;
    }
    return this.loadedSkills.get(this.activeSkillName) ?? null;
  }
  async loadSkill(skillName) {
    const normalized = normalizeSkillName(skillName);
    const cached = this.loadedSkills.get(normalized);
    if (cached) {
      this.activeSkillName = normalized;
      return cached;
    }
    const meta = this.availableByName.get(normalized);
    if (!meta) {
      return null;
    }
    const [loaded] = await loadSkillsByName([meta.name], this.availableSkills);
    if (!loaded) {
      return null;
    }
    this.loadedSkills.set(normalized, loaded);
    this.activeSkillName = normalized;
    return loaded;
  }
  filterToolNames(toolNames) {
    const activeSkill = this.getActiveSkill();
    if (!activeSkill || !activeSkill.allowedTools || activeSkill.allowedTools.length === 0) {
      return null;
    }
    const resolved = /* @__PURE__ */ new Set();
    const availableSet = new Set(toolNames);
    for (const token of activeSkill.allowedTools) {
      const requestedTool = token.trim();
      if (!requestedTool) {
        continue;
      }
      if (availableSet.has(requestedTool)) {
        resolved.add(requestedTool);
      }
    }
    return toolNames.filter((toolName) => resolved.has(toolName));
  }
  async listFiles(params) {
    const skill = await this.requireSkill(params.skillName);
    const directory = params.directory?.trim() || ".";
    const recursive = params.recursive ?? false;
    const maxEntries = Math.max(1, Math.min(params.maxEntries ?? DEFAULT_MAX_SKILL_LIST_ENTRIES, 1e3));
    const root = path4.resolve(skill.skillPath);
    const targetDirectory = resolvePathWithinRoot(root, directory);
    const targetStats = await fs3.stat(targetDirectory);
    if (!targetStats.isDirectory()) {
      throw new Error(`Path is not a directory: ${directory}`);
    }
    const entries = [];
    const queue = [targetDirectory];
    let truncated = false;
    while (queue.length > 0) {
      const currentDirectory = queue.shift();
      const children = await fs3.readdir(currentDirectory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        const absolutePath = path4.join(currentDirectory, child.name);
        const relativePath = normalizePathForOutput(path4.relative(root, absolutePath));
        if (!relativePath || relativePath.startsWith("..")) {
          continue;
        }
        if (child.isDirectory()) {
          entries.push({ path: `${relativePath}/`, type: "directory" });
          if (recursive) {
            queue.push(absolutePath);
          }
        } else if (child.isFile()) {
          entries.push({ path: relativePath, type: "file" });
        }
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
      }
      if (truncated || !recursive) {
        break;
      }
    }
    const relativeDirectory = normalizePathForOutput(path4.relative(root, targetDirectory) || ".");
    return {
      skillName: skill.name,
      directory: relativeDirectory,
      entries,
      truncated
    };
  }
  async readFile(params) {
    const skill = await this.requireSkill(params.skillName);
    const maxChars = Math.max(1, Math.min(params.maxChars ?? DEFAULT_MAX_SKILL_FILE_CHARS, 1e5));
    const root = path4.resolve(skill.skillPath);
    const targetPath = resolvePathWithinRoot(root, params.filePath);
    const stats = await fs3.stat(targetPath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${params.filePath}`);
    }
    if (stats.size > MAX_SKILL_FILE_BYTES) {
      throw new Error(`File exceeds ${MAX_SKILL_FILE_BYTES} bytes and cannot be loaded.`);
    }
    const raw = await fs3.readFile(targetPath, "utf8");
    const truncated = raw.length > maxChars;
    return {
      skillName: skill.name,
      path: normalizePathForOutput(path4.relative(root, targetPath)),
      content: truncated ? raw.slice(0, maxChars) : raw,
      truncated
    };
  }
  async requireSkill(skillName) {
    const explicit = skillName?.trim();
    if (explicit) {
      const loaded = await this.loadSkill(explicit);
      if (!loaded) {
        throw new Error(`Unknown skill: ${explicit}`);
      }
      return loaded;
    }
    const active = this.getActiveSkill();
    if (active) {
      return active;
    }
    if (this.loadedSkills.size === 1) {
      return [...this.loadedSkills.values()][0];
    }
    throw new Error("No active skill is loaded. Call loadSkill first or pass skill_name explicitly.");
  }
};

// src/chat/tools/definition.ts
function tool(definition) {
  return definition;
}

// src/chat/tools/bash.ts
import { Type } from "@sinclair/typebox";
function createBashTool() {
  return tool({
    description: "Run a bash command inside the isolated sandbox workspace. Use this for repository inspection/execution tasks that need shell access. Do not use for network-sensitive or destructive actions unless explicitly required.",
    inputSchema: Type.Object({
      command: Type.String({
        minLength: 1,
        description: "Bash command to run inside the sandbox."
      })
    }),
    execute: async () => {
      throw new Error("bash can only run when sandbox execution is enabled.");
    }
  });
}

// src/chat/tools/image-generate.ts
import { Type as Type2 } from "@sinclair/typebox";

// src/chat/pi/client.ts
import { completeSimple, getEnvApiKey, getModels } from "@mariozechner/pi-ai";
var GATEWAY_PROVIDER = "vercel-ai-gateway";
var GEN_AI_PROVIDER_NAME = GATEWAY_PROVIDER;
var GEN_AI_OPERATION_CHAT = "chat";
function getGatewayApiKey() {
  return getEnvApiKey("vercel-ai-gateway") || process.env.VERCEL_OIDC_TOKEN;
}
function extractText(message) {
  return (message.content ?? []).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text ?? "").join("").trim();
}
function parseJsonCandidate(text) {
  const trimmed = text.trim();
  if (!trimmed) return void 0;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fencedBlocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
    for (const block of fencedBlocks) {
      try {
        return JSON.parse(block[1]);
      } catch {
      }
    }
    const openBraceIndex = trimmed.indexOf("{");
    if (openBraceIndex >= 0) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = openBraceIndex; index < trimmed.length; index += 1) {
        const char = trimmed[index];
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (char === "\\") {
            escaped = true;
            continue;
          }
          if (char === '"') {
            inString = false;
          }
          continue;
        }
        if (char === '"') {
          inString = true;
          continue;
        }
        if (char === "{") {
          depth += 1;
          continue;
        }
        if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            const slice = trimmed.slice(openBraceIndex, index + 1);
            try {
              return JSON.parse(slice);
            } catch {
              break;
            }
          }
        }
      }
    }
    return void 0;
  }
}
function resolveGatewayModel(modelId) {
  const models = getModels(GATEWAY_PROVIDER);
  const matched = models.find((model) => model.id === modelId);
  if (!matched) {
    throw new Error(`Unknown AI Gateway model id: ${modelId}`);
  }
  return matched;
}
async function completeText(params) {
  const startedAt = Date.now();
  const model = resolveGatewayModel(params.modelId);
  const apiKey = getGatewayApiKey();
  const requestMessagesAttribute = serializeGenAiAttribute(params.messages);
  const startAttributes = {
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
    "gen_ai.request.model": params.modelId,
    ...requestMessagesAttribute ? { "gen_ai.input.messages": requestMessagesAttribute } : {},
    "app.ai.auth_mode": apiKey ? "api_key" : "ambient"
  };
  setSpanAttributes(startAttributes);
  const message = await completeSimple(model, {
    systemPrompt: params.system,
    messages: params.messages
  }, {
    ...apiKey ? { apiKey } : {},
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    signal: params.signal,
    metadata: params.metadata
  });
  const outputText = extractText(message);
  const outputMessagesAttribute = serializeGenAiAttribute([
    {
      role: "assistant",
      content: outputText ? [{ type: "text", text: outputText }] : []
    }
  ]);
  const usageAttributes = extractGenAiUsageAttributes(message);
  const endAttributes = {
    "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
    "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
    "gen_ai.request.model": params.modelId,
    ...outputMessagesAttribute ? { "gen_ai.output.messages": outputMessagesAttribute } : {},
    ...usageAttributes,
    "app.ai.duration_ms": Date.now() - startedAt,
    "app.ai.stop_reason": message.stopReason ?? "unknown"
  };
  setSpanAttributes(endAttributes);
  if (message.stopReason === "error") {
    const providerMessage = message.errorMessage?.trim() || "Unknown provider error";
    logWarn(
      "ai_completion_provider_error",
      {},
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
        "gen_ai.request.model": params.modelId,
        "error.message": providerMessage
      },
      "AI completion returned provider error"
    );
    throw new Error(`AI provider error: ${providerMessage}`);
  }
  return {
    message,
    text: outputText
  };
}
async function completeObject(params) {
  const startedAt = Date.now();
  let text = "";
  try {
    ({ text } = await completeText({
      modelId: params.modelId,
      system: params.system,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      signal: params.signal,
      metadata: params.metadata,
      messages: [
        {
          role: "user",
          content: params.prompt,
          timestamp: Date.now()
        }
      ]
    }));
  } catch (error) {
    logException(
      error,
      "ai_completion_failed",
      {},
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
        "gen_ai.request.model": params.modelId,
        "app.ai.duration_ms": Date.now() - startedAt
      },
      "AI object completion failed"
    );
    throw error;
  }
  const candidate = parseJsonCandidate(text);
  const parsed = params.schema.safeParse(candidate);
  if (!parsed.success) {
    const preview = text.length > 400 ? `${text.slice(0, 400)}...` : text;
    logWarn(
      "ai_completion_schema_parse_failed",
      {},
      {
        "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
        "gen_ai.operation.name": GEN_AI_OPERATION_CHAT,
        "gen_ai.request.model": params.modelId,
        "app.ai.duration_ms": Date.now() - startedAt,
        "app.ai.response_preview": preview
      },
      "AI object completion schema parse failed"
    );
    throw new Error(`Model did not return valid JSON for schema: ${parsed.error.message}. Raw response: ${preview}`);
  }
  return {
    object: parsed.data,
    text
  };
}

// src/chat/tools/image-generate.ts
var DEFAULT_IMAGE_MODEL = "google/gemini-3-pro-image";
var ENRICHMENT_SYSTEM_PROMPT = `You are an image prompt enrichment agent. Your job is to rewrite image generation requests to reflect a specific visual identity and mood.

<personality>
${JUNIOR_PERSONALITY}
</personality>

Rewrite the user's image request into a detailed image generation prompt that encodes this personality's visual aesthetic. Output ONLY the rewritten prompt text \u2014 no explanation, no wrapper.`;
async function enrichImagePrompt(rawPrompt) {
  try {
    const { text } = await completeText({
      modelId: botConfig.fastModelId,
      system: ENRICHMENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: rawPrompt, timestamp: Date.now() }],
      maxTokens: 1024
    });
    if (text && text.trim().length > 0) {
      logInfo("image_prompt_enriched", {}, { "app.image.enriched_prompt_length": text.trim().length }, "Image prompt enriched with persona");
      return text.trim();
    }
    return rawPrompt;
  } catch (error) {
    logWarn("image_prompt_enrichment_failed", {}, { "error.message": String(error) }, "Image prompt enrichment failed, using raw prompt");
    return rawPrompt;
  }
}
function extensionForMediaType(mediaType) {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "bin";
}
function parseImageGenerationError(status, body, model) {
  if (!body) return `image generation failed: ${status}`;
  try {
    const payload = JSON.parse(body);
    const message = payload.error?.message?.trim();
    if (!message) return `image generation failed: ${status} ${body}`;
    if (message.includes("not an image model")) {
      return `image generation failed: configured model "${model}" is not an image generation model. Set AI_IMAGE_MODEL to a compatible image model (for example "${DEFAULT_IMAGE_MODEL}").`;
    }
    return `image generation failed: ${status} ${message}`;
  } catch {
    return `image generation failed: ${status} ${body}`;
  }
}
function createImageGenerateTool(hooks) {
  return tool({
    description: "Generate images from a prompt. Use when the user wants to visually show or represent something \u2014 feelings, concepts, art, humor, or any visual idea. Also use for explicit image creation requests.",
    inputSchema: Type2.Object({
      prompt: Type2.String({
        minLength: 1,
        maxLength: 4e3,
        description: "Image generation prompt."
      })
    }),
    execute: async ({ prompt }) => {
      const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_OIDC_TOKEN;
      if (!apiKey) {
        throw new Error("Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
      }
      const model = process.env.AI_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;
      const enrichedPrompt = await enrichImagePrompt(prompt);
      const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: enrichedPrompt }],
          modalities: ["image"]
        })
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(parseImageGenerationError(response.status, text, model));
      }
      const payload = await response.json();
      const uploads = [];
      const generatedImages = payload.choices?.[0]?.message?.images ?? [];
      for (const [index, image] of generatedImages.entries()) {
        let bytes = null;
        let mimeType = "image/png";
        const url = image.image_url?.url;
        if (typeof url === "string" && url.startsWith("data:")) {
          const match = url.match(/^data:([^;,]+);base64,(.+)$/);
          if (!match) continue;
          mimeType = match[1] ?? mimeType;
          bytes = Buffer.from(match[2] ?? "", "base64");
        } else if (typeof url === "string" && url.length > 0) {
          const fetched = await fetch(url);
          if (!fetched.ok) continue;
          mimeType = fetched.headers.get("content-type") ?? mimeType;
          bytes = Buffer.from(await fetched.arrayBuffer());
        }
        if (!bytes) continue;
        const extension = extensionForMediaType(mimeType);
        uploads.push({
          data: bytes,
          filename: `generated-image-${Date.now()}-${index + 1}.${extension}`,
          mimeType
        });
      }
      if (uploads.length > 0) {
        hooks.onGeneratedFiles?.(uploads);
      }
      return {
        ok: true,
        model,
        prompt,
        enrichedPrompt,
        image_count: uploads.length,
        images: uploads.map((upload) => ({
          filename: upload.filename,
          media_type: upload.mimeType,
          bytes: upload.data.byteLength
        })),
        delivery: "Images will be attached to the Slack response as files."
      };
    }
  });
}

// src/chat/tools/load-skill.ts
import { Type as Type3 } from "@sinclair/typebox";
function toLoadedSkill(result) {
  if (result.ok !== true || typeof result.skill_name !== "string" || typeof result.description !== "string" || typeof result.skill_dir !== "string" || typeof result.instructions !== "string") {
    return null;
  }
  return {
    name: result.skill_name,
    description: result.description,
    skillPath: result.skill_dir,
    body: result.instructions
  };
}
function stripFrontmatter2(raw) {
  if (!raw.startsWith("---")) {
    return raw;
  }
  const match = /^---\n[\s\S]*?\n---\n?/.exec(raw);
  if (!match) {
    return raw;
  }
  return raw.slice(match[0].length);
}
async function loadSkillFromSandbox(sandbox, availableSkills, skillName) {
  const requested = skillName.trim().toLowerCase();
  const skill = availableSkills.find((entry) => entry.name.toLowerCase() === requested);
  if (!skill) {
    return {
      ok: false,
      error: `Unknown skill: ${skillName}`,
      available_skills: availableSkills.map((entry) => entry.name)
    };
  }
  const skillDir = sandboxSkillDir(skill.name);
  const skillFilePath = `${skillDir}/SKILL.md`;
  const file = await sandbox.readFileToBuffer({ path: skillFilePath });
  if (!file) {
    throw new Error(`failed to read ${skillFilePath}`);
  }
  return {
    ok: true,
    skill_name: skill.name,
    description: skill.description,
    skill_dir: skillDir,
    location: skillFilePath,
    instructions: stripFrontmatter2(file.toString("utf8"))
  };
}
function createLoadSkillTool(sandbox, availableSkills, options) {
  return tool({
    description: "Load a skill by name so its instructions are available for this turn. Use when a request clearly matches a known skill or a slash command references one. Do not use when no skill is relevant.",
    inputSchema: Type3.Object({
      skill_name: Type3.String({
        minLength: 1,
        description: "Skill name to load, without the leading slash."
      })
    }),
    execute: async ({ skill_name }) => {
      const result = await loadSkillFromSandbox(sandbox, availableSkills, skill_name);
      const loadedSkill = toLoadedSkill(result);
      if (loadedSkill) {
        await options?.onSkillLoaded?.(loadedSkill);
      }
      return result;
    }
  });
}

// src/chat/tools/read-file.ts
import { Type as Type4 } from "@sinclair/typebox";
function createReadFileTool() {
  return tool({
    description: "Read a file from the sandbox workspace. Use when you need exact file contents to verify facts or make edits safely. Do not use for broad discovery when search tools are better.",
    inputSchema: Type4.Object({
      path: Type4.String({
        minLength: 1,
        description: "Path to the file in the sandbox workspace."
      })
    }),
    execute: async () => {
      throw new Error("readFile can only run when sandbox execution is enabled.");
    }
  });
}

// src/chat/tools/slack-channel-list-members.ts
import { Type as Type5 } from "@sinclair/typebox";

// src/chat/slack-actions/channel.ts
async function postMessageToChannel(input) {
  const client2 = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error("Slack channel message posting requires a valid channel ID");
  }
  const response = await withSlackRetries(
    () => client2.chat.postMessage({
      channel: channelId,
      text: input.text,
      mrkdwn: true
    }),
    3,
    { action: "chat.postMessage" }
  );
  if (!response.ts) {
    throw new Error("Slack channel message posted without ts");
  }
  let permalink;
  try {
    const permalinkResponse = await withSlackRetries(
      () => client2.chat.getPermalink({
        channel: channelId,
        message_ts: response.ts
      }),
      3,
      { action: "chat.getPermalink" }
    );
    permalink = permalinkResponse.permalink;
  } catch {
  }
  return {
    ts: response.ts,
    permalink
  };
}
async function addReactionToMessage(input) {
  const client2 = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error("Slack reaction requires a valid channel ID");
  }
  const timestamp = input.timestamp.trim();
  if (!timestamp) {
    throw new Error("Slack reaction requires a target message timestamp");
  }
  const emoji = input.emoji.trim().replaceAll(":", "");
  if (!emoji) {
    throw new Error("Slack reaction requires a non-empty emoji name");
  }
  await withSlackRetries(
    () => client2.reactions.add({
      channel: channelId,
      timestamp,
      name: emoji
    }),
    3,
    { action: "reactions.add" }
  );
  return { ok: true };
}
async function listChannelMessages(input) {
  const client2 = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error("Slack channel history lookup requires a valid channel ID");
  }
  const targetLimit = Math.max(1, Math.min(input.limit, 1e3));
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 5, 10));
  const messages = [];
  let cursor = input.cursor;
  let pages = 0;
  while (messages.length < targetLimit && pages < maxPages) {
    pages += 1;
    const pageLimit = Math.max(1, Math.min(200, targetLimit - messages.length));
    const response = await withSlackRetries(
      () => client2.conversations.history({
        channel: channelId,
        limit: pageLimit,
        cursor,
        oldest: input.oldest,
        latest: input.latest,
        inclusive: input.inclusive
      }),
      3,
      { action: "conversations.history" }
    );
    const batch = response.messages ?? [];
    messages.push(...batch);
    cursor = response.response_metadata?.next_cursor || void 0;
    if (!cursor) {
      break;
    }
  }
  return {
    messages: messages.slice(0, targetLimit),
    nextCursor: cursor
  };
}
async function listChannelMembers(input) {
  const client2 = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error("Slack channel member lookup requires a valid channel ID");
  }
  const targetLimit = Math.max(1, Math.min(input.limit, 200));
  const response = await withSlackRetries(
    () => client2.conversations.members({
      channel: channelId,
      limit: targetLimit,
      cursor: input.cursor
    }),
    3,
    { action: "conversations.members" }
  );
  const members = (response.members ?? []).slice(0, targetLimit);
  return {
    members: members.map((userId) => ({ user_id: userId })),
    nextCursor: response.response_metadata?.next_cursor || void 0
  };
}
async function listThreadReplies(input) {
  const client2 = getSlackClient();
  const channelId = normalizeSlackConversationId(input.channelId);
  if (!channelId) {
    throw new Error("Slack thread reply lookup requires a valid channel ID");
  }
  const targetLimit = Math.max(1, Math.min(input.limit ?? 1e3, 1e3));
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 10, 10));
  const pendingTargets = new Set(
    (input.targetMessageTs ?? []).filter((value) => typeof value === "string" && value.length > 0)
  );
  const replies = [];
  let cursor;
  let pages = 0;
  while (replies.length < targetLimit && pages < maxPages) {
    pages += 1;
    const pageLimit = Math.max(1, Math.min(200, targetLimit - replies.length));
    const response = await withSlackRetries(
      () => client2.conversations.replies({
        channel: channelId,
        ts: input.threadTs,
        limit: pageLimit,
        cursor
      }),
      3,
      { action: "conversations.replies" }
    );
    const batch = response.messages ?? [];
    replies.push(...batch);
    for (const reply of batch) {
      if (typeof reply.ts === "string" && pendingTargets.size > 0) {
        pendingTargets.delete(reply.ts);
      }
    }
    cursor = response.response_metadata?.next_cursor || void 0;
    if (!cursor || pendingTargets.size === 0) {
      break;
    }
  }
  return replies.slice(0, targetLimit);
}

// src/chat/tools/slack-channel-list-members.ts
function createSlackChannelListMembersTool(context) {
  return tool({
    description: "List member IDs in the active Slack channel context. Use when the user asks who is in a channel, who to assign, or who should be notified. Do not use when thread-local participant context is sufficient.",
    inputSchema: Type5.Object({
      limit: Type5.Optional(
        Type5.Integer({
          minimum: 1,
          maximum: 200,
          description: "Maximum number of members to return."
        })
      ),
      cursor: Type5.Optional(
        Type5.String({
          minLength: 1,
          description: "Pagination cursor from a prior call."
        })
      )
    }),
    execute: async ({ limit, cursor }) => {
      const targetChannelId = context.channelId;
      if (!targetChannelId) {
        return { ok: false, error: "No active channel context is available for member lookup" };
      }
      const result = await listChannelMembers({
        channelId: targetChannelId,
        limit: limit ?? 50,
        cursor
      });
      return {
        ok: true,
        channel_id: targetChannelId,
        count: result.members.length,
        next_cursor: result.nextCursor,
        members: result.members
      };
    }
  });
}

// src/chat/tools/slack-channel-list-messages.ts
import { Type as Type6 } from "@sinclair/typebox";
function createSlackChannelListMessagesTool(context) {
  return tool({
    description: "List channel messages from Slack history in the active channel context. Use when the user asks for recent or historical channel context outside this thread. Do not use for live monitoring or when current thread context already answers the question.",
    inputSchema: Type6.Object({
      limit: Type6.Optional(
        Type6.Integer({
          minimum: 1,
          maximum: 1e3,
          description: "Maximum number of messages to return across pages."
        })
      ),
      cursor: Type6.Optional(
        Type6.String({
          minLength: 1,
          description: "Optional cursor to continue from a prior call."
        })
      ),
      oldest: Type6.Optional(
        Type6.String({
          minLength: 1,
          description: "Optional oldest message timestamp (Slack ts) for range filtering."
        })
      ),
      latest: Type6.Optional(
        Type6.String({
          minLength: 1,
          description: "Optional latest message timestamp (Slack ts) for range filtering."
        })
      ),
      inclusive: Type6.Optional(
        Type6.Boolean({
          description: "Whether oldest/latest bounds should be inclusive."
        })
      ),
      max_pages: Type6.Optional(
        Type6.Integer({
          minimum: 1,
          maximum: 10,
          description: "Maximum number of API pages to traverse in a single call."
        })
      )
    }),
    execute: async ({ limit, cursor, oldest, latest, inclusive, max_pages }) => {
      const targetChannelId = context.channelId;
      if (!targetChannelId) {
        return { ok: false, error: "No active channel context is available for history lookup" };
      }
      const result = await listChannelMessages({
        channelId: targetChannelId,
        limit: limit ?? 100,
        cursor,
        oldest,
        latest,
        inclusive,
        maxPages: max_pages
      });
      return {
        ok: true,
        channel_id: targetChannelId,
        count: result.messages.length,
        next_cursor: result.nextCursor,
        messages: result.messages
      };
    }
  });
}

// src/chat/tools/slack-channel-post-message.ts
import { Type as Type7 } from "@sinclair/typebox";

// src/chat/tools/idempotency.ts
function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort((a, b) => a[0].localeCompare(b[0]));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === void 0 ? String(value) : serialized;
}
function createOperationKey(toolName, input) {
  return `${toolName}:${stableSerialize(input)}`;
}

// src/chat/tools/slack-channel-post-message.ts
function createSlackChannelPostMessageTool(context, state) {
  return tool({
    description: "Post a message in the active Slack channel context (outside the thread). Use this when the user explicitly asks to post/send/share/say something in the channel. Do not use for normal thread replies or speculative broadcasts. Do not claim a channel message was posted unless this tool succeeds in this turn.",
    inputSchema: Type7.Object({
      text: Type7.String({
        minLength: 1,
        maxLength: 4e4,
        description: "Slack mrkdwn text to post."
      })
    }),
    execute: async ({ text }) => {
      const targetChannelId = context.channelId;
      if (!targetChannelId) {
        return { ok: false, error: "No active channel context is available for posting" };
      }
      const operationKey = createOperationKey("slackChannelPostMessage", {
        channel_id: targetChannelId,
        text
      });
      const cached = state.getOperationResult(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true
        };
      }
      const posted = await postMessageToChannel({
        channelId: targetChannelId,
        text
      });
      const response = {
        ok: true,
        channel_id: targetChannelId,
        ts: posted.ts,
        permalink: posted.permalink
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}

// src/chat/tools/slack-message-add-reaction.ts
import { Type as Type8 } from "@sinclair/typebox";
var SLACK_EMOJI_NAME_RE = /^[a-z0-9_+-]+$/;
function createSlackMessageAddReactionTool(context, state) {
  return tool({
    description: "Add an emoji reaction to the current inbound Slack message. Use sparingly for lightweight acknowledgements. Provide a Slack emoji alias name (for example `thumbsup` or `white_check_mark`), not a unicode emoji glyph. The target message is injected by runtime context; do not use this for arbitrary historical messages.",
    inputSchema: Type8.Object({
      emoji: Type8.String({
        minLength: 1,
        maxLength: 64,
        description: "Slack emoji alias name to react with (for example `thumbsup` or `white_check_mark`). Optional surrounding colons are allowed."
      })
    }),
    execute: async ({ emoji }) => {
      const targetChannelId = context.channelId;
      if (!targetChannelId) {
        return { ok: false, error: "No active channel context is available for reactions" };
      }
      const targetMessageTs = context.messageTs;
      if (!targetMessageTs) {
        return { ok: false, error: "No active message timestamp is available for reactions" };
      }
      const normalizedEmoji = emoji.trim().replaceAll(":", "").toLowerCase();
      if (!normalizedEmoji) {
        return { ok: false, error: "Emoji must be non-empty" };
      }
      if (!SLACK_EMOJI_NAME_RE.test(normalizedEmoji)) {
        return {
          ok: false,
          error: "Emoji must be a valid Slack emoji alias name (letters, numbers, _, +, -)"
        };
      }
      const operationKey = createOperationKey("slackMessageAddReaction", {
        channel_id: targetChannelId,
        message_ts: targetMessageTs,
        emoji: normalizedEmoji
      });
      const cached = state.getOperationResult(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true
        };
      }
      await addReactionToMessage({
        channelId: targetChannelId,
        timestamp: targetMessageTs,
        emoji: normalizedEmoji
      });
      const response = {
        ok: true,
        channel_id: targetChannelId,
        message_ts: targetMessageTs,
        emoji: normalizedEmoji
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}

// src/chat/tools/slack-canvas-create.ts
import { Type as Type9 } from "@sinclair/typebox";

// src/chat/slack-actions/canvases.ts
async function createCanvas(input) {
  const client2 = getSlackClient();
  const normalizedChannelId = normalizeSlackConversationId(input.channelId);
  const isConversationScoped = isConversationScopedChannel(normalizedChannelId);
  if (!isConversationScoped) {
    throw new Error(
      "Canvas creation requires an active Slack conversation context (C/G/D)."
    );
  }
  const channelPrefix = normalizedChannelId?.slice(0, 1) ?? "none";
  const action = "conversations.canvases.create";
  const result = await withSlackRetries(async () => {
    return client2.conversations.canvases.create({
      channel_id: normalizedChannelId,
      title: input.title,
      document_content: {
        type: "markdown",
        markdown: input.markdown
      }
    });
  }, 3, {
    action,
    attributes: {
      "app.slack.canvas.channel_id_prefix": channelPrefix,
      "app.slack.canvas.has_channel_id": Boolean(input.channelId),
      "app.slack.canvas.title_length": input.title.length,
      "app.slack.canvas.markdown_length": input.markdown.length
    }
  });
  if (!result.canvas_id) {
    throw new Error("Slack canvas was created without canvas_id");
  }
  let permalink;
  try {
    permalink = await getFilePermalink(result.canvas_id);
  } catch {
  }
  return {
    canvasId: result.canvas_id,
    permalink
  };
}
async function lookupCanvasSection(canvasId, containsText) {
  const client2 = getSlackClient();
  const response = await withSlackRetries(
    () => client2.canvases.sections.lookup({
      canvas_id: canvasId,
      criteria: {
        contains_text: containsText
      }
    }),
    3,
    {
      action: "canvases.sections.lookup",
      attributes: {
        "app.slack.canvas.canvas_id_prefix": canvasId.slice(0, 1),
        "app.slack.canvas.contains_text_length": containsText.length
      }
    }
  );
  return response.sections?.[0]?.id;
}
async function updateCanvas(input) {
  const client2 = getSlackClient();
  await withSlackRetries(
    () => client2.canvases.edit({
      canvas_id: input.canvasId,
      changes: [
        {
          operation: input.operation,
          section_id: input.sectionId,
          document_content: {
            type: "markdown",
            markdown: input.markdown
          }
        }
      ]
    }),
    3,
    {
      action: "canvases.edit",
      attributes: {
        "app.slack.canvas.canvas_id_prefix": input.canvasId.slice(0, 1),
        "app.slack.canvas.operation": input.operation,
        "app.slack.canvas.markdown_length": input.markdown.length
      }
    }
  );
}

// src/chat/tools/slack-canvas-create.ts
var MAX_RECENT_CANVASES = 5;
function mergeRecentCanvases(existing, created) {
  const nextEntry = {
    id: created.id,
    title: created.title,
    url: created.url,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const prior = existing ?? [];
  const deduped = prior.filter((entry) => entry.id !== created.id);
  return [nextEntry, ...deduped].slice(0, MAX_RECENT_CANVASES);
}
function createSlackCanvasCreateTool(context, state) {
  return tool({
    description: "Create a Slack canvas for long-form output in the active assistant context channel. Use when content is too long for a thread reply or needs a persistent document. Do not use for short answers that fit in-thread.",
    inputSchema: Type9.Object({
      title: Type9.String({
        minLength: 1,
        maxLength: 160,
        description: "Canvas title."
      }),
      markdown: Type9.String({
        minLength: 1,
        description: "Canvas markdown body content."
      })
    }),
    execute: async ({ title, markdown }) => {
      const targetChannelId = context.channelId;
      if (!isConversationScopedChannel(targetChannelId)) {
        logError(
          "slack_canvas_create_invalid_context",
          {},
          {
            "gen_ai.tool.name": "slackCanvasCreate",
            "messaging.destination.name": targetChannelId ?? "none",
            "app.slack.canvas.has_channel_context": Boolean(targetChannelId)
          },
          "Canvas create failed due to missing or invalid assistant channel context"
        );
        throw new Error(
          "Cannot create a canvas without an active assistant channel context (C/G/D)."
        );
      }
      const operationKey = createOperationKey("slackCanvasCreate", {
        title,
        markdown,
        channel_id: targetChannelId ?? null
      });
      const cached = state.getOperationResult(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true
        };
      }
      const created = await createCanvas({
        title,
        markdown,
        channelId: targetChannelId
      });
      state.setTurnCreatedCanvasId(created.canvasId);
      state.patchArtifactState({
        lastCanvasId: created.canvasId,
        lastCanvasUrl: created.permalink,
        recentCanvases: mergeRecentCanvases(state.artifactState.recentCanvases, {
          id: created.canvasId,
          title,
          url: created.permalink
        })
      });
      const response = {
        ok: true,
        canvas_id: created.canvasId,
        permalink: created.permalink,
        summary: `Created canvas ${created.canvasId}`
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}

// src/chat/tools/slack-canvas-update.ts
import { Type as Type10 } from "@sinclair/typebox";
function createSlackCanvasUpdateTool(state, _context) {
  return tool({
    description: "Update the active Slack canvas tracked in artifact context. Use when continuing or correcting a document already tracked in this thread. Do not use to create a brand-new long-form artifact.",
    inputSchema: Type10.Object({
      markdown: Type10.String({
        minLength: 1,
        description: "Markdown content to insert or use as replacement text."
      }),
      operation: Type10.Optional(
        Type10.Union(
          [Type10.Literal("insert_at_end"), Type10.Literal("insert_at_start"), Type10.Literal("replace")],
          { description: "Canvas update mode." }
        )
      ),
      section_id: Type10.Optional(
        Type10.String({
          minLength: 1,
          description: "Optional section ID required for targeted replace operations."
        })
      ),
      section_contains_text: Type10.Optional(
        Type10.String({
          minLength: 1,
          description: "Optional helper text used to find the target section when section_id is not provided."
        })
      )
    }),
    execute: async ({ markdown, operation, section_id, section_contains_text }) => {
      const targetCanvasId = state.getTurnCreatedCanvasId() ?? state.getCurrentCanvasId();
      const resolvedOperation = operation ?? "insert_at_end";
      if (!targetCanvasId) {
        logWarn(
          "slack_canvas_update_missing_target",
          {},
          {
            "gen_ai.tool.name": "slackCanvasUpdate",
            "app.artifacts.last_canvas_id": state.artifactState.lastCanvasId ?? "none",
            "app.artifacts.turn_created_canvas_id": state.getTurnCreatedCanvasId() ?? "none"
          },
          "Canvas update rejected because no explicit target canvas was provided"
        );
        return {
          ok: false,
          error: "No active canvas found in artifact context"
        };
      }
      const operationKey = createOperationKey("slackCanvasUpdate", {
        canvas_id: targetCanvasId,
        markdown,
        operation: resolvedOperation,
        section_id: section_id ?? null,
        section_contains_text: section_contains_text ?? null
      });
      const cached = state.getOperationResult(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true
        };
      }
      const sectionId = section_id ?? (section_contains_text ? await lookupCanvasSection(targetCanvasId, section_contains_text) : void 0);
      await updateCanvas({
        canvasId: targetCanvasId,
        markdown,
        operation: resolvedOperation,
        sectionId
      });
      state.patchArtifactState({ lastCanvasId: targetCanvasId });
      const response = {
        ok: true,
        canvas_id: targetCanvasId,
        operation: resolvedOperation,
        section_id: sectionId
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}

// src/chat/tools/slack-list-add-items.ts
import { Type as Type11 } from "@sinclair/typebox";

// src/chat/slack-actions/lists.ts
function normalizeKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}
function inferListColumnMap(schema = []) {
  const pick = (predicate) => schema.find(predicate)?.id;
  return {
    titleColumnId: pick((column) => {
      const key = normalizeKey(column.key);
      return column.is_primary_column || key.includes("title") || key.includes("task") || key.includes("name");
    }),
    completedColumnId: pick((column) => {
      const key = normalizeKey(column.key);
      return column.type === "checkbox" || key.includes("done") || key.includes("complete") || key.includes("status");
    }),
    assigneeColumnId: pick((column) => {
      const key = normalizeKey(column.key);
      return column.type === "user" || key.includes("owner") || key.includes("assignee");
    }),
    dueDateColumnId: pick((column) => {
      const key = normalizeKey(column.key);
      return column.type === "date" || key.includes("due") || key.includes("deadline");
    })
  };
}
function richTextField(columnId, value) {
  return {
    column_id: columnId,
    rich_text: [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_section",
            elements: [{ type: "text", text: value }]
          }
        ]
      }
    ]
  };
}
var DEFAULT_TODO_SCHEMA = [
  { key: "task", name: "Task", type: "rich_text", is_primary_column: true },
  { key: "completed", name: "Completed", type: "checkbox" },
  { key: "assignee", name: "Assignee", type: "user" },
  { key: "due_date", name: "Due Date", type: "date" }
];
async function createTodoList(name) {
  const client2 = getSlackClient();
  const result = await withSlackRetries(
    () => client2.slackLists.create({
      name,
      schema: DEFAULT_TODO_SCHEMA,
      todo_mode: true
    })
  );
  if (!result.list_id) {
    throw new Error("Slack list was created without list_id");
  }
  const listColumnMap = inferListColumnMap(result.list_metadata?.schema ?? []);
  let permalink;
  try {
    permalink = await getFilePermalink(result.list_id);
  } catch {
  }
  return {
    listId: result.list_id,
    listColumnMap,
    permalink
  };
}
async function addListItems(input) {
  const client2 = getSlackClient();
  const listColumnMap = input.listColumnMap ?? {};
  if (!listColumnMap.titleColumnId) {
    throw new Error("Cannot add list items because title column could not be inferred");
  }
  const createdItemIds = [];
  for (const title of input.titles) {
    const initialFields = [richTextField(listColumnMap.titleColumnId, title)];
    if (input.assigneeUserId && listColumnMap.assigneeColumnId) {
      initialFields.push({
        column_id: listColumnMap.assigneeColumnId,
        user: [input.assigneeUserId]
      });
    }
    if (input.dueDate && listColumnMap.dueDateColumnId) {
      initialFields.push({
        column_id: listColumnMap.dueDateColumnId,
        date: [input.dueDate]
      });
    }
    const response = await withSlackRetries(
      () => client2.slackLists.items.create({
        list_id: input.listId,
        initial_fields: initialFields
      })
    );
    if (response.item?.id) {
      createdItemIds.push(response.item.id);
    }
  }
  return {
    createdItemIds,
    listColumnMap
  };
}
async function listItems(listId, limit = 100) {
  const client2 = getSlackClient();
  const items = [];
  let cursor;
  const cappedLimit = Math.max(1, Math.min(limit, 200));
  do {
    const response = await withSlackRetries(
      () => client2.slackLists.items.list({
        list_id: listId,
        limit: cappedLimit,
        cursor
      })
    );
    const remaining = cappedLimit - items.length;
    if (remaining <= 0) {
      break;
    }
    items.push(...(response.items ?? []).slice(0, remaining));
    if (items.length >= cappedLimit) {
      break;
    }
    cursor = response.response_metadata?.next_cursor || void 0;
  } while (cursor);
  return items;
}
async function updateListItem(input) {
  const client2 = getSlackClient();
  const cells = [];
  if (typeof input.completed === "boolean" && input.listColumnMap.completedColumnId) {
    cells.push({
      row_id: input.itemId,
      column_id: input.listColumnMap.completedColumnId,
      checkbox: input.completed
    });
  }
  if (typeof input.title === "string" && input.title.trim() && input.listColumnMap.titleColumnId) {
    cells.push({
      row_id: input.itemId,
      ...richTextField(input.listColumnMap.titleColumnId, input.title)
    });
  }
  if (cells.length === 0) {
    throw new Error("No updatable fields were provided or inferred for this list item");
  }
  await withSlackRetries(
    () => client2.slackLists.items.update({
      list_id: input.listId,
      cells
    })
  );
}

// src/chat/tools/slack-list-add-items.ts
function createSlackListAddItemsTool(state) {
  return tool({
    description: "Add tasks to the active Slack list tracked in artifact context. Use when the user wants actionable items recorded in the current thread list. Do not use when no list exists and list creation was not requested.",
    inputSchema: Type11.Object({
      items: Type11.Array(Type11.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 25,
        description: "List item titles to create."
      }),
      assignee_user_id: Type11.Optional(
        Type11.String({
          minLength: 1,
          description: "Optional Slack user ID assigned to all created items."
        })
      ),
      due_date: Type11.Optional(
        Type11.String({
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Optional due date in YYYY-MM-DD format."
        })
      )
    }),
    execute: async ({ items, assignee_user_id, due_date }) => {
      const targetListId = state.getCurrentListId();
      if (!targetListId) {
        return { ok: false, error: "No active list found in artifact context" };
      }
      const operationKey = createOperationKey("slackListAddItems", {
        list_id: targetListId,
        items,
        assignee_user_id: assignee_user_id ?? null,
        due_date: due_date ?? null
      });
      const cached = state.getOperationResult(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true
        };
      }
      const result = await addListItems({
        listId: targetListId,
        titles: items,
        listColumnMap: state.artifactState.listColumnMap,
        assigneeUserId: assignee_user_id,
        dueDate: due_date
      });
      state.patchArtifactState({
        lastListId: targetListId,
        listColumnMap: result.listColumnMap
      });
      const response = {
        ok: true,
        list_id: targetListId,
        created_item_ids: result.createdItemIds,
        created_count: result.createdItemIds.length
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}

// src/chat/tools/slack-list-create.ts
import { Type as Type12 } from "@sinclair/typebox";
function createSlackListCreateTool(state) {
  return tool({
    description: "Create a Slack todo list for action tracking. Use when the user needs structured tasks with ownership/completion tracking. Do not use for one-off notes without task management needs.",
    inputSchema: Type12.Object({
      name: Type12.String({
        minLength: 1,
        maxLength: 160,
        description: "Name for the new Slack list."
      })
    }),
    execute: async ({ name }) => {
      const operationKey = createOperationKey("slackListCreate", { name });
      const cached = state.getOperationResult(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true
        };
      }
      const list = await createTodoList(name);
      state.patchArtifactState({
        lastListId: list.listId,
        lastListUrl: list.permalink,
        listColumnMap: list.listColumnMap
      });
      const response = {
        ok: true,
        list_id: list.listId,
        permalink: list.permalink,
        column_map: list.listColumnMap
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}

// src/chat/tools/slack-list-get-items.ts
import { Type as Type13 } from "@sinclair/typebox";
function createSlackListGetItemsTool(state) {
  return tool({
    description: "Read items from the active Slack list tracked in artifact context. Use when the user asks for task status, open items, or list contents. Do not use when list state is already known from the immediately prior result.",
    inputSchema: Type13.Object({
      limit: Type13.Optional(
        Type13.Integer({
          minimum: 1,
          maximum: 200,
          description: "Maximum number of list items to return."
        })
      )
    }),
    execute: async ({ limit }) => {
      const targetListId = state.getCurrentListId();
      const resolvedLimit = limit ?? 100;
      if (!targetListId) {
        return { ok: false, error: "No active list found in artifact context" };
      }
      const items = await listItems(targetListId, resolvedLimit);
      return {
        ok: true,
        list_id: targetListId,
        items: items.map((item) => ({ id: item.id, fields: item.fields }))
      };
    }
  });
}

// src/chat/tools/slack-list-update-item.ts
import { Type as Type14 } from "@sinclair/typebox";
function createSlackListUpdateItemTool(state) {
  return tool({
    description: "Update an item in the active Slack list tracked in artifact context (title/completion). Use when the user asks to mark progress or rename a tracked task. Do not use to add new tasks.",
    inputSchema: Type14.Object(
      {
        item_id: Type14.String({
          minLength: 1,
          description: "ID of the Slack list item to update."
        }),
        completed: Type14.Optional(
          Type14.Boolean({
            description: "Optional completion status update."
          })
        ),
        title: Type14.Optional(
          Type14.String({
            minLength: 1,
            description: "Optional new item title."
          })
        )
      },
      {
        anyOf: [{ required: ["completed"] }, { required: ["title"] }]
      }
    ),
    execute: async ({ item_id, completed, title }) => {
      const targetListId = state.getCurrentListId();
      if (!targetListId) {
        return { ok: false, error: "No active list found in artifact context" };
      }
      const operationKey = createOperationKey("slackListUpdateItem", {
        list_id: targetListId,
        item_id,
        completed: completed ?? null,
        title: title ?? null
      });
      const cached = state.getOperationResult(operationKey);
      if (cached) {
        return {
          ...cached,
          deduplicated: true
        };
      }
      await updateListItem({
        listId: targetListId,
        itemId: item_id,
        completed,
        title,
        listColumnMap: state.artifactState.listColumnMap ?? {}
      });
      state.patchArtifactState({ lastListId: targetListId });
      const response = {
        ok: true,
        list_id: targetListId,
        item_id,
        completed,
        title
      };
      state.setOperationResult(operationKey, response);
      return response;
    }
  });
}

// src/chat/tools/system-time.ts
import { Type as Type15 } from "@sinclair/typebox";
function createSystemTimeTool() {
  return tool({
    description: "Return current system time in UTC and local ISO formats. Use when the user asks for current time/date context. Do not use as a substitute for historical or timezone-conversion research.",
    inputSchema: Type15.Object({}),
    execute: async () => {
      const now = /* @__PURE__ */ new Date();
      return {
        ok: true,
        unix_ms: now.getTime(),
        iso_utc: now.toISOString(),
        iso_local: new Date(now.getTime() - now.getTimezoneOffset() * 6e4).toISOString().replace("Z", ""),
        timezone_offset_minutes: now.getTimezoneOffset()
      };
    }
  });
}

// src/chat/tools/web-fetch.ts
import { Type as Type16 } from "@sinclair/typebox";

// src/chat/tools/constants.ts
var USER_AGENT = "junior-bot/0.1";
var FETCH_TIMEOUT_MS = 8e3;
var MAX_REDIRECTS = 3;
var DEFAULT_MAX_CHARS = 6e3;
var MAX_FETCH_CHARS = 12e3;
var MAX_FETCH_BYTES = 256e3;

// src/chat/tools/network.ts
import dns from "dns/promises";
import net from "net";
function isPrivateIpv4(ip) {
  const parts = ip.split(".").map((chunk) => Number.parseInt(chunk, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  if (parts[0] === 10 || parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 0) return true;
  return false;
}
function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}
async function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "0.0.0.0" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Local/private hostnames are blocked");
  }
  const hostIpType = net.isIP(hostname);
  if (hostIpType === 4 && isPrivateIpv4(hostname)) {
    throw new Error("Private IPv4 addresses are blocked");
  }
  if (hostIpType === 6 && isPrivateIpv6(hostname)) {
    throw new Error("Private IPv6 addresses are blocked");
  }
  if (hostIpType === 0) {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw new Error("Could not resolve hostname");
    }
    for (const record of records) {
      if (record.family === 4 && isPrivateIpv4(record.address)) {
        throw new Error("Resolved to a private IPv4 address");
      }
      if (record.family === 6 && isPrivateIpv6(record.address)) {
        throw new Error("Resolved to a private IPv6 address");
      }
    }
  }
  return parsed;
}
async function withTimeout(task, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  try {
    return await Promise.race([task, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function fetchTextWithRedirects(url, redirectsLeft) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: abortController.signal,
    headers: {
      "user-agent": USER_AGENT
    }
  }).finally(() => clearTimeout(timer));
  const isRedirect = response.status >= 300 && response.status < 400;
  if (!isRedirect) {
    return response;
  }
  if (redirectsLeft <= 0) {
    throw new Error("Too many redirects");
  }
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Redirect missing location");
  }
  const nextUrl = new URL(location, url);
  const safeUrl = await assertPublicUrl(nextUrl.toString());
  return fetchTextWithRedirects(safeUrl, redirectsLeft - 1);
}
async function readResponseBody(response, maxBytes) {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error("Response body too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

// src/chat/tools/web_fetch/convert.ts
import { NodeHtmlMarkdown } from "node-html-markdown";
var htmlToMarkdownConverter = new NodeHtmlMarkdown({
  bulletMarker: "-",
  codeBlockStyle: "fenced",
  ignore: ["script", "style", "noscript", "nav", "footer", "header", "aside"],
  maxConsecutiveNewlines: 2
});
function normalizeWhitespace(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function truncateAtWordBoundary(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }
  const shortened = text.slice(0, maxChars);
  const lastSpace = shortened.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.8) {
    return `${shortened.slice(0, lastSpace).trimEnd()}...`;
  }
  return `${shortened.trimEnd()}...`;
}
function extractContent(body, contentType, maxChars) {
  const loweredContentType = contentType.toLowerCase();
  const normalizedBody = body.trim();
  if (loweredContentType.includes("html")) {
    try {
      const markdown = htmlToMarkdownConverter.translate(normalizedBody);
      return truncateAtWordBoundary(normalizeWhitespace(markdown), maxChars);
    } catch {
    }
  }
  if (loweredContentType.includes("json")) {
    try {
      const parsed = JSON.parse(normalizedBody);
      return truncateAtWordBoundary(JSON.stringify(parsed, null, 2), maxChars);
    } catch {
      return truncateAtWordBoundary(normalizeWhitespace(normalizedBody), maxChars);
    }
  }
  return truncateAtWordBoundary(normalizeWhitespace(normalizedBody), maxChars);
}

// src/chat/tools/web_fetch/index.ts
async function webFetch(url, maxChars = DEFAULT_MAX_CHARS) {
  const safeMaxChars = Math.max(500, Math.min(maxChars, MAX_FETCH_CHARS));
  const safeUrl = await assertPublicUrl(url);
  const response = await withTimeout(fetchTextWithRedirects(safeUrl, MAX_REDIRECTS), FETCH_TIMEOUT_MS, "fetch");
  if (!response.ok) {
    throw new Error(`fetch failed: ${response.status}`);
  }
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("text/") && !contentType.includes("json") && !contentType.includes("xml")) {
    throw new Error(`unsupported content type: ${contentType || "unknown"}`);
  }
  const body = await withTimeout(readResponseBody(response, MAX_FETCH_BYTES), FETCH_TIMEOUT_MS, "read");
  const text = extractContent(body, contentType, safeMaxChars);
  return { url: safeUrl.toString(), content: text };
}

// src/chat/tools/web-fetch.ts
function extensionForMediaType2(mediaType) {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/gif") return "gif";
  return "bin";
}
function filenameForUrl(url, mediaType) {
  const fromPath = url.pathname.split("/").filter(Boolean).pop();
  if (fromPath && fromPath.includes(".")) return fromPath;
  return `fetched-file.${extensionForMediaType2(mediaType)}`;
}
function extractHttpStatusFromMessage(message) {
  const match = message.match(/fetch failed:\s*(\d{3})/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function createWebFetchTool(hooks) {
  return tool({
    description: "Fetch and extract readable content from a specific URL. Use when you need details from a known page or document. Do not use for discovery when search is the first step.",
    inputSchema: Type16.Object({
      url: Type16.String({
        minLength: 1,
        description: "HTTP(S) URL to fetch."
      }),
      max_chars: Type16.Optional(
        Type16.Integer({
          minimum: 500,
          maximum: MAX_FETCH_CHARS,
          description: "Optional maximum number of extracted characters to return."
        })
      )
    }),
    execute: async ({ url, max_chars }) => {
      try {
        const safeUrl = await assertPublicUrl(url);
        const response = await withTimeout(fetchTextWithRedirects(safeUrl, MAX_REDIRECTS), FETCH_TIMEOUT_MS, "fetch");
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        if (response.ok && contentType.startsWith("image/")) {
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.byteLength > MAX_FETCH_BYTES) {
            throw new Error("image response body too large");
          }
          const filename = filenameForUrl(safeUrl, contentType.split(";")[0] ?? "image/png");
          hooks.onGeneratedFiles?.([
            {
              data: bytes,
              filename,
              mimeType: contentType.split(";")[0] ?? "application/octet-stream"
            }
          ]);
          return {
            ok: true,
            url: safeUrl.toString(),
            media_type: contentType,
            bytes: bytes.byteLength,
            delivery: "Fetched image will be attached to the Slack response as a file."
          };
        }
        return await webFetch(url, max_chars);
      } catch (error) {
        const message = error instanceof Error ? error.message : "fetch failed";
        const status = extractHttpStatusFromMessage(message);
        const isClientError = status !== null && status >= 400 && status < 500;
        return {
          ok: false,
          url,
          error: message,
          status,
          retryable: !isClientError
        };
      }
    }
  });
}

// src/chat/tools/web-search.ts
import { generateText } from "ai";
import { createGatewayProvider } from "@ai-sdk/gateway";
import { Type as Type17 } from "@sinclair/typebox";
var SEARCH_TIMEOUT_MS = 1e4;
var MAX_RESULTS = 5;
var DEFAULT_SEARCH_MODEL = "xai/grok-4-fast-reasoning";
var SEARCH_TOOL_NAME = "parallelSearch";
function asString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function parseSearchResults(toolResults, maxResults) {
  const typedResults = Array.isArray(toolResults) ? toolResults : [];
  const parsedResults = [];
  for (const toolResult of typedResults) {
    if (toolResult.type !== "tool-result" || toolResult.toolName !== SEARCH_TOOL_NAME) {
      continue;
    }
    const output = toolResult.output;
    const results = Array.isArray(output?.results) ? output.results : [];
    for (const result of results) {
      const url = asString(result.url);
      if (!url) continue;
      parsedResults.push({
        title: asString(result.title) ?? url,
        url,
        snippet: asString(result.excerpt) ?? asString(result.snippet) ?? ""
      });
      if (parsedResults.length >= maxResults) {
        return parsedResults;
      }
    }
  }
  return parsedResults;
}
function formatSearchFailure(error) {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) {
      return `web search failed: ${message}`;
    }
  }
  return "web search failed";
}
function isNonRetryableSearchFailure(message) {
  const normalized = message.toLowerCase();
  return normalized.includes("missing ai gateway credentials");
}
function isTimeoutSearchFailure(message) {
  return /timed out/i.test(message);
}
function createWebSearchTool() {
  return tool({
    description: "Search public web sources and return top snippets/URLs. Use when you need discovery or source candidates. Do not use when the user already provided a specific URL to inspect.",
    inputSchema: Type17.Object({
      query: Type17.String({
        minLength: 1,
        maxLength: 500,
        description: "Search query."
      }),
      max_results: Type17.Optional(
        Type17.Integer({
          minimum: 1,
          maximum: MAX_RESULTS,
          description: "Max results to return."
        })
      )
    }),
    execute: async ({ query, max_results }) => {
      const maxResults = max_results ?? 3;
      try {
        const apiKey = getGatewayApiKey();
        if (!apiKey) {
          throw new Error("Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)");
        }
        const model = process.env.AI_WEB_SEARCH_MODEL ?? process.env.AI_FAST_MODEL ?? process.env.AI_MODEL ?? DEFAULT_SEARCH_MODEL;
        const provider = createGatewayProvider({ apiKey });
        const response = await withTimeout(
          (async () => {
            try {
              return await generateText({
                model: provider.chat(model),
                prompt: query,
                tools: {
                  [SEARCH_TOOL_NAME]: provider.tools.parallelSearch({
                    mode: "agentic",
                    maxResults
                  })
                },
                toolChoice: {
                  type: "tool",
                  toolName: SEARCH_TOOL_NAME
                }
              });
            } catch (error) {
              throw new Error(formatSearchFailure(error));
            }
          })(),
          SEARCH_TIMEOUT_MS,
          "webSearch"
        );
        const results = parseSearchResults(response.toolResults, maxResults);
        return {
          ok: true,
          model,
          query,
          result_count: results.length,
          results
        };
      } catch (error) {
        const message = formatSearchFailure(error);
        return {
          ok: false,
          query,
          result_count: 0,
          results: [],
          error: message,
          timeout: isTimeoutSearchFailure(message),
          retryable: !isNonRetryableSearchFailure(message)
        };
      }
    }
  });
}

// src/chat/tools/write-file.ts
import { Type as Type18 } from "@sinclair/typebox";
function createWriteFileTool() {
  return tool({
    description: "Write UTF-8 content to a file in the sandbox workspace. Use for intentional file creation or replacement after validation. Do not use for exploratory analysis-only turns.",
    inputSchema: Type18.Object({
      path: Type18.String({
        minLength: 1,
        description: "Path to write in the sandbox workspace."
      }),
      content: Type18.String({
        description: "UTF-8 file content to write."
      })
    }),
    execute: async () => {
      throw new Error("writeFile can only run when sandbox execution is enabled.");
    }
  });
}

// src/chat/tools/index.ts
function createToolState(hooks, context) {
  const operationResultCache = /* @__PURE__ */ new Map();
  let turnCreatedCanvasId;
  const artifactState = {
    ...context.artifactState ?? {},
    listColumnMap: {
      ...context.artifactState?.listColumnMap ?? {}
    }
  };
  const patchArtifactState = (patch) => {
    Object.assign(artifactState, patch);
    if (patch.listColumnMap) {
      artifactState.listColumnMap = {
        ...artifactState.listColumnMap ?? {},
        ...patch.listColumnMap
      };
    }
    hooks.onArtifactStatePatch?.(patch);
  };
  return {
    artifactState,
    patchArtifactState,
    getCurrentCanvasId: () => artifactState.lastCanvasId,
    getTurnCreatedCanvasId: () => turnCreatedCanvasId,
    setTurnCreatedCanvasId: (canvasId) => {
      turnCreatedCanvasId = canvasId;
    },
    getCurrentListId: () => artifactState.lastListId,
    getOperationResult: (operationKey) => operationResultCache.get(operationKey),
    setOperationResult: (operationKey, result) => {
      operationResultCache.set(operationKey, result);
    }
  };
}
function wrapToolExecution(toolName, toolDef, hooks) {
  const maybeExecutable = toolDef;
  if (!maybeExecutable.execute) {
    return toolDef;
  }
  const originalExecute = maybeExecutable.execute.bind(toolDef);
  maybeExecutable.execute = async (...args) => {
    const input = args[0];
    await hooks.onToolCallStart?.(toolName, input);
    try {
      return await originalExecute(...args);
    } finally {
      await hooks.onToolCallEnd?.(toolName, input);
    }
  };
  return toolDef;
}
function createTools(availableSkills, hooks = {}, context) {
  const state = createToolState(hooks, context);
  const tools = {
    loadSkill: wrapToolExecution(
      "loadSkill",
      createLoadSkillTool(context.sandbox, availableSkills, {
        onSkillLoaded: hooks.onSkillLoaded
      }),
      hooks
    ),
    systemTime: wrapToolExecution("systemTime", createSystemTimeTool(), hooks),
    bash: wrapToolExecution("bash", createBashTool(), hooks),
    readFile: wrapToolExecution("readFile", createReadFileTool(), hooks),
    writeFile: wrapToolExecution("writeFile", createWriteFileTool(), hooks),
    webSearch: wrapToolExecution("webSearch", createWebSearchTool(), hooks),
    webFetch: wrapToolExecution("webFetch", createWebFetchTool(hooks), hooks),
    imageGenerate: wrapToolExecution("imageGenerate", createImageGenerateTool(hooks), hooks),
    slackCanvasUpdate: wrapToolExecution("slackCanvasUpdate", createSlackCanvasUpdateTool(state, context), hooks),
    slackListCreate: wrapToolExecution("slackListCreate", createSlackListCreateTool(state), hooks),
    slackListAddItems: wrapToolExecution("slackListAddItems", createSlackListAddItemsTool(state), hooks),
    slackListGetItems: wrapToolExecution("slackListGetItems", createSlackListGetItemsTool(state), hooks),
    slackListUpdateItem: wrapToolExecution(
      "slackListUpdateItem",
      createSlackListUpdateItemTool(state),
      hooks
    )
  };
  if (isConversationScopedChannel(context.channelId)) {
    tools.slackCanvasCreate = wrapToolExecution(
      "slackCanvasCreate",
      createSlackCanvasCreateTool(context, state),
      hooks
    );
  }
  if (isConversationChannel(context.channelId)) {
    tools.slackChannelPostMessage = wrapToolExecution(
      "slackChannelPostMessage",
      createSlackChannelPostMessageTool(context, state),
      hooks
    );
    tools.slackChannelListMembers = wrapToolExecution(
      "slackChannelListMembers",
      createSlackChannelListMembersTool(context),
      hooks
    );
    tools.slackChannelListMessages = wrapToolExecution(
      "slackChannelListMessages",
      createSlackChannelListMessagesTool(context),
      hooks
    );
  }
  if (isConversationScopedChannel(context.channelId)) {
    tools.slackMessageAddReaction = wrapToolExecution(
      "slackMessageAddReaction",
      createSlackMessageAddReactionTool(context, state),
      hooks
    );
  }
  return tools;
}

// src/chat/sandbox/sandbox.ts
import fs4 from "fs/promises";
import path5 from "path";
import { Sandbox } from "@vercel/sandbox";
import { createBashTool as createBashTool2 } from "bash-tool";

// src/chat/http-error-details.ts
var DEFAULT_PREVIEW_LIMIT = 512;
function toTrimmedString(value, maxChars) {
  if (typeof value !== "string") {
    return void 0;
  }
  const normalized = value.trim();
  if (!normalized) {
    return void 0;
  }
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}\u2026` : normalized;
}
function extractHttpErrorDetails(error, options = {}) {
  const prefix = options.attributePrefix ?? "app.http_error";
  const previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const err = error ?? {};
  const attributes = {
    "error.type": normalizedError.name || "Error",
    "error.message": toTrimmedString(normalizedError.message, previewLimit) ?? "HTTP error"
  };
  const response = err.response;
  const statusCode = typeof response?.status === "number" ? response.status : void 0;
  const statusText = toTrimmedString(response?.statusText, previewLimit);
  const responseUrl = toTrimmedString(response?.url, previewLimit);
  const responseText = toTrimmedString(err.text, previewLimit);
  const responseJson = toTrimmedString(
    err.json && typeof err.json === "object" ? JSON.stringify(err.json) : void 0,
    previewLimit
  );
  const contentType = toTrimmedString(response?.headers?.get?.("content-type"), previewLimit);
  const requestIdHeader = toTrimmedString(response?.headers?.get?.("x-request-id"), previewLimit);
  const vercelIdHeader = toTrimmedString(response?.headers?.get?.("x-vercel-id"), previewLimit);
  const requestId = requestIdHeader ?? vercelIdHeader;
  if (statusCode !== void 0) {
    attributes["http.response.status_code"] = statusCode;
  }
  if (statusText) {
    attributes[`${prefix}.status_text`] = statusText;
  }
  if (responseUrl) {
    attributes["url.full"] = responseUrl;
  }
  if (contentType) {
    attributes["http.response.header.content-type"] = [contentType];
  }
  if (requestIdHeader) {
    attributes["http.response.header.x-request-id"] = [requestIdHeader];
  }
  if (vercelIdHeader) {
    attributes["http.response.header.x-vercel-id"] = [vercelIdHeader];
  }
  if (responseText) {
    attributes[`${prefix}.response_text_preview`] = responseText;
    attributes[`${prefix}.response_text_length`] = responseText.length;
  }
  if (responseJson) {
    attributes[`${prefix}.response_json_preview`] = responseJson;
  }
  const summaryParts = [];
  if (statusCode !== void 0) {
    summaryParts.push(`status=${statusCode}`);
  }
  if (statusText) {
    summaryParts.push(`statusText=${statusText}`);
  }
  if (responseUrl) {
    summaryParts.push(`url=${responseUrl}`);
  }
  if (requestId) {
    summaryParts.push(`requestId=${requestId}`);
  }
  for (const field of options.extraFields ?? []) {
    const value = toTrimmedString(err[field.sourceKey], previewLimit);
    if (!value) {
      continue;
    }
    attributes[`${prefix}.${field.attributeKey}`] = value;
    summaryParts.push(`${field.summaryKey ?? field.attributeKey}=${value}`);
  }
  if (responseJson) {
    summaryParts.push(`json=${responseJson}`);
  } else if (responseText) {
    summaryParts.push(`text=${responseText}`);
  }
  const searchableText = `${normalizedError.message} ${responseText ?? ""} ${responseJson ?? ""}`.toLowerCase();
  return {
    attributes,
    summary: summaryParts.join(", "),
    searchableText
  };
}

// src/chat/sandbox/sandbox.ts
var SANDBOX_TOOL_NAMES = /* @__PURE__ */ new Set(["bash", "readFile", "writeFile"]);
var DEFAULT_MAX_OUTPUT_LENGTH = 3e4;
var SANDBOX_RUNTIME_BIN_DIR = `${SANDBOX_WORKSPACE_ROOT}/.junior/bin`;
var SANDBOX_ERROR_FIELDS = [{ sourceKey: "sandboxId", attributeKey: "sandbox_id", summaryKey: "sandboxId" }];
function mergeNetworkPolicyWithHeaderTransforms(networkPolicy, headerTransforms) {
  const basePolicy = networkPolicy && typeof networkPolicy === "object" && !Array.isArray(networkPolicy) ? { ...networkPolicy } : {};
  const existingAllowRaw = basePolicy.allow;
  const existingAllow = existingAllowRaw && typeof existingAllowRaw === "object" && !Array.isArray(existingAllowRaw) ? Object.fromEntries(
    Object.entries(existingAllowRaw).map(([domain, rules]) => [
      domain,
      Array.isArray(rules) ? [...rules] : []
    ])
  ) : { "*": [] };
  for (const transform of headerTransforms) {
    const currentRules = existingAllow[transform.domain] ?? [];
    existingAllow[transform.domain] = [...currentRules, { transform: [{ headers: transform.headers }] }];
  }
  return {
    ...basePolicy,
    allow: existingAllow
  };
}
function truncateOutput(output, maxLength) {
  if (output.length <= maxLength) {
    return { value: output, truncated: false };
  }
  const truncatedLength = output.length - maxLength;
  return {
    value: `${output.slice(0, maxLength)}

[output truncated: ${truncatedLength} characters removed]`,
    truncated: true
  };
}
function toPosixRelative(base, absolute) {
  return path5.relative(base, absolute).split(path5.sep).join("/");
}
async function listFilesRecursive(root) {
  const queue = [root];
  const files = [];
  while (queue.length > 0) {
    const dir = queue.shift();
    const entries = await fs4.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path5.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  return files;
}
async function buildSkillSyncFiles(availableSkills) {
  const filesToWrite = [];
  const index = {
    skills: []
  };
  for (const skill of availableSkills) {
    const skillFiles = await listFilesRecursive(skill.skillPath);
    for (const absoluteFile of skillFiles) {
      const relative = toPosixRelative(skill.skillPath, absoluteFile);
      if (!relative || relative.startsWith("..")) {
        continue;
      }
      filesToWrite.push({
        path: `${sandboxSkillDir(skill.name)}/${relative}`,
        content: await fs4.readFile(absoluteFile)
      });
    }
    index.skills.push({
      name: skill.name,
      description: skill.description,
      root: sandboxSkillDir(skill.name)
    });
  }
  filesToWrite.push({
    path: `${SANDBOX_SKILLS_ROOT}/index.json`,
    content: Buffer.from(JSON.stringify(index), "utf8")
  });
  return filesToWrite;
}
function collectDirectories(filesToWrite) {
  const directoriesToEnsure = /* @__PURE__ */ new Set();
  for (const file of filesToWrite) {
    const normalizedPath = path5.posix.normalize(file.path);
    const parts = normalizedPath.split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = `${current}/${parts[index]}`;
      directoriesToEnsure.add(current);
    }
  }
  return Array.from(directoriesToEnsure).filter((directory) => directory === SANDBOX_WORKSPACE_ROOT || directory.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`)).sort((a, b) => a.length - b.length);
}
function getSandboxErrorDetails(error) {
  return extractHttpErrorDetails(error, {
    attributePrefix: "app.sandbox.api_error",
    extraFields: [...SANDBOX_ERROR_FIELDS]
  });
}
function isAlreadyExistsError(error) {
  const details = getSandboxErrorDetails(error);
  return details.searchableText.includes("already exists") || details.searchableText.includes("file exists") || details.searchableText.includes("eexist");
}
function findInErrorChain(error, predicate) {
  const seen = /* @__PURE__ */ new Set();
  let current = error;
  while (current && !seen.has(current)) {
    if (predicate(current)) {
      return true;
    }
    seen.add(current);
    if (typeof current === "object") {
      current = current.cause;
    } else {
      current = void 0;
    }
  }
  return false;
}
function isSandboxUnavailableError(error) {
  return findInErrorChain(error, (candidate) => {
    const details = getSandboxErrorDetails(candidate);
    const searchable = `${details.searchableText} ${details.summary}`.toLowerCase();
    return searchable.includes("sandbox_stopped") || searchable.includes("status=410") || searchable.includes("status code 410") || searchable.includes("no longer available");
  });
}
function getFirstErrorMessage(error) {
  const seen = /* @__PURE__ */ new Set();
  let current = error;
  while (current && !seen.has(current)) {
    if (current instanceof Error) {
      const message = current.message.trim();
      if (message) {
        return message;
      }
    }
    seen.add(current);
    current = typeof current === "object" ? current.cause : void 0;
  }
  return void 0;
}
function wrapSandboxSetupError(error) {
  try {
    const details = getSandboxErrorDetails(error);
    if (details.summary) {
      return new Error(`sandbox setup failed (${details.summary})`, { cause: error });
    }
  } catch {
  }
  let causeMessage;
  try {
    causeMessage = getFirstErrorMessage(error);
  } catch (cause) {
    causeMessage = cause instanceof Error ? cause.message : void 0;
  }
  if (causeMessage && causeMessage.trim() && causeMessage !== "sandbox setup failed") {
    const oneLine = causeMessage.replace(/\s+/g, " ").trim();
    return new Error(`sandbox setup failed (${oneLine})`, { cause: error });
  }
  return new Error("sandbox setup failed", { cause: error });
}
function throwSandboxOperationError(action, error, includeMissingPath = false) {
  const details = getSandboxErrorDetails(error);
  setSpanAttributes({
    ...details.attributes,
    ...includeMissingPath ? {
      "app.sandbox.api_error.missing_path": details.searchableText.includes("no such file") || details.searchableText.includes("enoent")
    } : {},
    "app.sandbox.success": false
  });
  setSpanStatus("error");
  throw new Error(details.summary ? `${action} failed (${details.summary})` : `${action} failed`, {
    cause: error
  });
}
function createSandboxExecutor(options) {
  let sandbox = null;
  let sandboxIdHint = options?.sandboxId;
  let availableSkills = [];
  let toolExecutors;
  const timeoutMs = options?.timeoutMs ?? 1e3 * 60 * 30;
  const traceContext = options?.traceContext ?? {};
  const withSandboxSpan = (name, op, attributes, callback) => withSpan(name, op, traceContext, callback, attributes);
  const upsertSkillsToSandbox = async (targetSandbox) => {
    await withSandboxSpan(
      "sandbox.sync_skills",
      "sandbox.sync",
      {
        "app.sandbox.skills_count": availableSkills.length
      },
      async () => {
        const filesToWrite = await buildSkillSyncFiles(availableSkills);
        const bytesWritten = filesToWrite.reduce((total, file) => total + file.content.length, 0);
        const directories = collectDirectories(filesToWrite);
        await withSandboxSpan(
          "sandbox.sync_writeFiles",
          "sandbox.sync.write",
          {
            "app.sandbox.sync.files_written": filesToWrite.length,
            "app.sandbox.sync.bytes_written": bytesWritten,
            "app.sandbox.sync.directories_ensured": directories.length
          },
          async () => {
            try {
              for (const directory of directories) {
                try {
                  await targetSandbox.mkDir(directory);
                } catch (error) {
                  if (!isAlreadyExistsError(error)) {
                    throw error;
                  }
                }
              }
              await targetSandbox.writeFiles(filesToWrite);
            } catch (error) {
              throwSandboxOperationError("sandbox writeFiles", error, true);
            }
          }
        );
      }
    );
  };
  const createSandbox = async () => {
    return withSandboxSpan(
      "sandbox.acquire",
      "sandbox.acquire",
      {
        "app.sandbox.id_hint_present": Boolean(sandboxIdHint),
        "app.sandbox.timeout_ms": timeoutMs,
        "app.sandbox.runtime": "node22",
        "app.sandbox.skills_count": availableSkills.length
      },
      async () => {
        const assignSandbox = (nextSandbox) => {
          sandbox = nextSandbox;
          sandboxIdHint = nextSandbox.sandboxId;
          toolExecutors = void 0;
          return nextSandbox;
        };
        const handleSetupFailure = (error) => {
          throw wrapSandboxSetupError(error);
        };
        const createFreshSandbox = async () => {
          let createdSandbox;
          try {
            createdSandbox = await withSandboxSpan(
              "sandbox.create",
              "sandbox.create",
              {
                "app.sandbox.reused": false,
                "app.sandbox.source": "created",
                "app.sandbox.timeout_ms": timeoutMs,
                "app.sandbox.runtime": "node22"
              },
              async () => Sandbox.create({
                timeout: timeoutMs,
                runtime: "node22"
              })
            );
          } catch (error) {
            return handleSetupFailure(error);
          }
          try {
            await upsertSkillsToSandbox(createdSandbox);
          } catch (error) {
            return handleSetupFailure(error);
          }
          return assignSandbox(createdSandbox);
        };
        const recoverUnavailableSandbox = async (source) => {
          setSpanAttributes({
            "app.sandbox.recovery.attempted": true,
            "app.sandbox.recovery.source": source
          });
          sandbox = null;
          sandboxIdHint = void 0;
          toolExecutors = void 0;
          const replacement = await createFreshSandbox();
          setSpanAttributes({
            "app.sandbox.recovery.succeeded": true
          });
          return replacement;
        };
        if (sandbox) {
          const cachedSandbox = sandbox;
          try {
            await withSandboxSpan(
              "sandbox.reuse_cached",
              "sandbox.acquire.cached",
              {
                "app.sandbox.reused": true,
                "app.sandbox.source": "memory"
              },
              async () => {
                await upsertSkillsToSandbox(cachedSandbox);
              }
            );
            return cachedSandbox;
          } catch (error) {
            if (isSandboxUnavailableError(error)) {
              return recoverUnavailableSandbox("memory");
            }
            return handleSetupFailure(error);
          }
        }
        let acquiredSandbox = null;
        if (sandboxIdHint) {
          try {
            acquiredSandbox = await withSandboxSpan(
              "sandbox.get",
              "sandbox.get",
              {
                "app.sandbox.reused": true,
                "app.sandbox.source": "id_hint"
              },
              async () => Sandbox.get({ sandboxId: sandboxIdHint })
            );
          } catch {
            acquiredSandbox = null;
          }
        }
        if (acquiredSandbox) {
          try {
            await upsertSkillsToSandbox(acquiredSandbox);
            return assignSandbox(acquiredSandbox);
          } catch (error) {
            if (isSandboxUnavailableError(error)) {
              return recoverUnavailableSandbox("id_hint");
            }
            return handleSetupFailure(error);
          }
        }
        return createFreshSandbox();
      }
    );
  };
  const getToolExecutors = async () => {
    if (toolExecutors) {
      return toolExecutors;
    }
    const activeSandbox = await createSandbox();
    const toolkit = await withSandboxSpan(
      "sandbox.bash_tool.init",
      "sandbox.tool.init",
      {
        "app.sandbox.tool_name": "bash",
        "app.sandbox.destination": SANDBOX_WORKSPACE_ROOT
      },
      async () => createBashTool2({
        sandbox: activeSandbox,
        destination: SANDBOX_WORKSPACE_ROOT
      })
    );
    const executeReadFile = toolkit.tools.readFile.execute;
    const executeWriteFile = toolkit.tools.writeFile.execute;
    if (!executeReadFile || !executeWriteFile) {
      throw new Error("bash-tool did not return executable tool handlers");
    }
    toolExecutors = {
      bash: async (input) => {
        const restoreNetworkPolicy = activeSandbox.networkPolicy ?? "allow-all";
        const headerTransforms = input.headerTransforms;
        if (headerTransforms && headerTransforms.length > 0) {
          const policy = mergeNetworkPolicyWithHeaderTransforms(restoreNetworkPolicy, headerTransforms);
          await activeSandbox.updateNetworkPolicy(policy);
        }
        const pathPrefix = `${SANDBOX_RUNTIME_BIN_DIR}:$PATH`;
        const envExports = input.env ? Object.entries(input.env).map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'`).join(" && ") : "";
        const preamble = envExports ? `export PATH="${pathPrefix}" && ${envExports}` : `export PATH="${pathPrefix}"`;
        let commandError;
        try {
          const commandResult2 = await activeSandbox.runCommand({
            cmd: "bash",
            args: ["-c", `${preamble} && ${input.command}`],
            cwd: SANDBOX_WORKSPACE_ROOT
          });
          const maxOutputLength = Number.parseInt(process.env.SANDBOX_BASH_MAX_OUTPUT_CHARS ?? "", 10);
          const boundedOutputLength = Number.isFinite(maxOutputLength) && maxOutputLength > 0 ? maxOutputLength : DEFAULT_MAX_OUTPUT_LENGTH;
          const stdoutRaw = await commandResult2.stdout();
          const stderrRaw = await commandResult2.stderr();
          const stdout = truncateOutput(stdoutRaw, boundedOutputLength);
          const stderr = truncateOutput(stderrRaw, boundedOutputLength);
          return {
            stdout: stdout.value,
            stderr: stderr.value,
            exitCode: commandResult2.exitCode,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated
          };
        } catch (error) {
          commandError = error;
          throw error;
        } finally {
          if (headerTransforms && headerTransforms.length > 0) {
            try {
              await activeSandbox.updateNetworkPolicy(restoreNetworkPolicy);
            } catch (restoreError) {
              if (!commandError) {
                throw restoreError;
              }
            }
          }
        }
      },
      readFile: async (input) => await executeReadFile(input, {
        toolCallId: "sandbox-read-file",
        messages: []
      }),
      writeFile: async (input) => await executeWriteFile(input, {
        toolCallId: "sandbox-write-file",
        messages: []
      })
    };
    return toolExecutors;
  };
  const execute = async (params) => {
    const rawInput = params.input ?? {};
    const bashCommand = params.toolName === "bash" ? String(rawInput.command ?? "").trim() : void 0;
    if (params.toolName === "bash") {
      if (!bashCommand) {
        throw new Error("command is required");
      }
      if (options?.runBashCustomCommand) {
        const custom = await options.runBashCustomCommand(bashCommand);
        if (custom.handled) {
          return { result: custom.result };
        }
      }
    }
    const activeSandbox = await createSandbox();
    const keepAliveMs = Number.parseInt(process.env.VERCEL_SANDBOX_KEEPALIVE_MS ?? "0", 10);
    if (Number.isFinite(keepAliveMs) && keepAliveMs > 0) {
      try {
        await withSandboxSpan(
          "sandbox.keepalive.extend",
          "sandbox.keepalive",
          {
            "app.sandbox.keepalive_ms": keepAliveMs
          },
          async () => {
            await activeSandbox.extendTimeout(keepAliveMs);
          }
        );
      } catch {
      }
    }
    if (params.toolName === "bash") {
      const command = bashCommand;
      const headerTransformsInput = rawInput.headerTransforms;
      const headerTransforms = Array.isArray(headerTransformsInput) ? headerTransformsInput.filter((value) => Boolean(value && typeof value === "object")).map((transform) => ({
        domain: String(transform.domain ?? "").trim(),
        headers: transform.headers && typeof transform.headers === "object" && !Array.isArray(transform.headers) ? Object.fromEntries(
          Object.entries(transform.headers).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, value])
        ) : {}
      })).filter((transform) => transform.domain.length > 0 && Object.keys(transform.headers).length > 0) : void 0;
      const envInput = rawInput.env;
      const env = envInput && typeof envInput === "object" && !Array.isArray(envInput) ? Object.fromEntries(
        Object.entries(envInput).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, value])
      ) : void 0;
      const executeBash = (await getToolExecutors()).bash;
      const result = await withSandboxSpan(
        "bash",
        "process.exec",
        {
          "process.executable.name": "bash"
        },
        async () => {
          try {
            const response = await executeBash({ command, ...headerTransforms ? { headerTransforms } : {}, ...env ? { env } : {} });
            setSpanAttributes({
              "process.exit.code": response.exitCode,
              "app.sandbox.stdout_bytes": Buffer.byteLength(response.stdout ?? "", "utf8"),
              "app.sandbox.stderr_bytes": Buffer.byteLength(response.stderr ?? "", "utf8"),
              ...response.exitCode !== 0 ? { "error.type": "nonzero_exit" } : {}
            });
            setSpanStatus(response.exitCode === 0 ? "ok" : "error");
            return response;
          } catch (error) {
            setSpanAttributes({
              "error.type": error instanceof Error ? error.name : "sandbox_execute_error"
            });
            setSpanStatus("error");
            throw error;
          }
        }
      );
      return {
        result: {
          ok: result.exitCode === 0,
          command,
          cwd: SANDBOX_WORKSPACE_ROOT,
          exit_code: result.exitCode,
          signal: null,
          timed_out: false,
          stdout: result.stdout,
          stderr: result.stderr,
          stdout_truncated: result.stdoutTruncated,
          stderr_truncated: result.stderrTruncated
        }
      };
    }
    if (params.toolName === "readFile") {
      const filePath = String(rawInput.path ?? "").trim();
      if (!filePath) {
        throw new Error("path is required");
      }
      const executeReadFile = (await getToolExecutors()).readFile;
      const result = await withSandboxSpan(
        "sandbox.readFile",
        "sandbox.fs.read",
        {
          "app.sandbox.path.length": filePath.length
        },
        async () => {
          const response = await executeReadFile({ path: filePath });
          const content = String(response.content ?? "");
          setSpanAttributes({
            "app.sandbox.read.bytes": Buffer.byteLength(content, "utf8"),
            "app.sandbox.read.chars": content.length
          });
          setSpanStatus("ok");
          return {
            content,
            path: filePath,
            success: true
          };
        }
      );
      return { result };
    }
    if (params.toolName === "writeFile") {
      const filePath = String(rawInput.path ?? "").trim();
      if (!filePath) {
        throw new Error("path is required");
      }
      const content = String(rawInput.content ?? "");
      const executeWriteFile = (await getToolExecutors()).writeFile;
      await withSandboxSpan(
        "sandbox.writeFile",
        "sandbox.fs.write",
        {
          "app.sandbox.path.length": filePath.length,
          "app.sandbox.write.bytes": Buffer.byteLength(content, "utf8")
        },
        async () => {
          try {
            await executeWriteFile({ path: filePath, content });
            setSpanStatus("ok");
          } catch (error) {
            throwSandboxOperationError("sandbox writeFile", error);
          }
        }
      );
      return {
        result: {
          ok: true,
          path: filePath,
          bytes_written: Buffer.byteLength(content, "utf8")
        }
      };
    }
    throw new Error(`unsupported sandbox tool: ${params.toolName}`);
  };
  const dispose = async () => {
    if (!sandbox) {
      return;
    }
    await withSandboxSpan(
      "sandbox.stop",
      "sandbox.stop",
      {
        "app.sandbox.stop.blocking": true
      },
      async () => {
        await sandbox.stop({ blocking: true });
      }
    );
    sandbox = null;
    toolExecutors = void 0;
  };
  return {
    configureSkills(skills) {
      availableSkills = [...skills];
    },
    getSandboxId() {
      return sandbox?.sandboxId ?? sandboxIdHint;
    },
    canExecute(toolName) {
      return SANDBOX_TOOL_NAMES.has(toolName);
    },
    createSandbox,
    execute,
    dispose
  };
}

// src/chat/respond.ts
var AGENT_TURN_TIMEOUT_MS = 15 * 60 * 1e3;
var MAX_INLINE_ATTACHMENT_BASE64_CHARS = 12e4;
function isExecutionDeferralResponse(text) {
  return /\b(want me to proceed|do you want me to proceed|shall i proceed|can i proceed|should i proceed|let me do that now|give me a moment|tag me again|fresh invocation)\b/i.test(
    text
  );
}
function isToolAccessDisclaimerResponse(text) {
  return /\b(i (don't|do not) have access to (active )?tool|tool results came back empty|prior results .* empty|cannot access .*tool|need to (run|load) .*tool .* first)\b/i.test(
    text
  );
}
function isExecutionEscapeResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return isExecutionDeferralResponse(trimmed) || isToolAccessDisclaimerResponse(trimmed);
}
function parseJsonCandidate2(text) {
  const trimmed = text.trim();
  if (!trimmed) return void 0;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenced) return void 0;
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return void 0;
    }
  }
}
function isToolPayloadShape(payload) {
  if (!payload || typeof payload !== "object") return false;
  const record = payload;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type.startsWith("tool-")) return true;
  if (type === "tool_use" || type === "tool_call" || type === "tool_result" || type === "tool_error") return true;
  const hasToolName = typeof record.toolName === "string" || typeof record.name === "string";
  const hasToolInput = Object.prototype.hasOwnProperty.call(record, "input") || Object.prototype.hasOwnProperty.call(record, "args");
  if (hasToolName && hasToolInput) return true;
  return false;
}
function isRawToolPayloadResponse(text) {
  const parsed = parseJsonCandidate2(text);
  if (Array.isArray(parsed)) {
    return parsed.some((entry) => isToolPayloadShape(entry));
  }
  if (isToolPayloadShape(parsed)) {
    return true;
  }
  const compact = text.replace(/\s+/g, " ");
  return /"type"\s*:\s*"tool[-_](use|call|result|error)"/i.test(compact);
}
function formatToolStatus(toolName) {
  const known = {
    loadSkill: "Loading skill instructions",
    systemTime: "Reading current system time",
    bash: "Running shell command in sandbox",
    readFile: "Reading file in sandbox",
    writeFile: "Writing file in sandbox",
    webSearch: "Searching public sources",
    webFetch: "Reading source pages",
    slackChannelPostMessage: "Posting message to channel",
    slackMessageAddReaction: "Adding emoji reaction",
    slackChannelListMembers: "Listing channel members",
    slackChannelListMessages: "Listing channel messages",
    slackCanvasCreate: "Creating detailed brief",
    slackCanvasUpdate: "Updating detailed brief",
    slackListCreate: "Creating tracking list",
    slackListAddItems: "Updating tracking list",
    slackListUpdateItem: "Updating tracking list",
    imageGenerate: "Generating image"
  };
  if (known[toolName]) {
    return known[toolName];
  }
  const readable = toolName.replaceAll("_", " ").trim();
  return readable.length > 0 ? `Running ${readable}` : "Running tool";
}
function formatToolStatusWithInput(toolName, input) {
  const obj = input && typeof input === "object" ? input : void 0;
  const path6 = obj ? compactStatusPath(obj.path) : void 0;
  const filename = obj ? compactStatusFilename(obj.path) : void 0;
  const query = obj ? compactStatusText(obj.query, 70) : void 0;
  const domain = obj ? extractStatusUrlDomain(obj.url) : void 0;
  const skillName = obj ? compactStatusText(obj.skill_name ?? obj.skillName, 40) : void 0;
  if (filename && toolName === "readFile") {
    return `Reading file ${filename}`;
  }
  if (path6 && toolName === "writeFile") {
    return `Writing file ${path6}`;
  }
  if (skillName && toolName === "loadSkill") {
    return `Loading skill ${skillName}`;
  }
  if (query && toolName === "webSearch") {
    return `Searching web for "${query}"`;
  }
  if (domain && toolName === "webFetch") {
    return `Fetching page from ${domain}`;
  }
  return formatToolStatus(toolName);
}
function formatToolResultStatus(toolName) {
  const known = {
    loadSkill: "Integrating loaded skill guidance",
    systemTime: "Applying current time context",
    bash: "Analyzing command output",
    readFile: "Analyzing file contents",
    writeFile: "Saving file update",
    webSearch: "Reviewing search results",
    webFetch: "Reviewing page content",
    slackChannelPostMessage: "Posted message to channel",
    slackMessageAddReaction: "Added emoji reaction",
    slackChannelListMembers: "Reviewed channel members",
    slackChannelListMessages: "Reviewed channel messages",
    slackCanvasCreate: "Preparing canvas response",
    slackCanvasUpdate: "Preparing canvas update",
    slackListCreate: "Preparing list update",
    slackListAddItems: "Preparing list update",
    slackListUpdateItem: "Preparing list update",
    imageGenerate: "Preparing generated image"
  };
  if (known[toolName]) {
    return known[toolName];
  }
  const readable = toolName.replaceAll("_", " ").trim();
  return readable.length > 0 ? `Reviewing ${readable} result` : "Reviewing tool result";
}
function formatToolResultStatusWithInput(toolName, input) {
  const obj = input && typeof input === "object" ? input : void 0;
  const path6 = obj ? compactStatusPath(obj.path) : void 0;
  const filename = obj ? compactStatusFilename(obj.path) : void 0;
  const query = obj ? compactStatusText(obj.query, 70) : void 0;
  const domain = obj ? extractStatusUrlDomain(obj.url) : void 0;
  const skillName = obj ? compactStatusText(obj.skill_name ?? obj.skillName, 40) : void 0;
  if (filename && toolName === "readFile") {
    return `Reviewed file ${filename}`;
  }
  if (path6 && toolName === "writeFile") {
    return `Saved file ${path6}`;
  }
  if (skillName && toolName === "loadSkill") {
    return `Loaded skill ${skillName}`;
  }
  if (query && toolName === "webSearch") {
    return `Reviewed web results for "${query}"`;
  }
  if (domain && toolName === "webFetch") {
    return `Reviewed page from ${domain}`;
  }
  return formatToolResultStatus(toolName);
}
function toObservablePromptPart(part) {
  if (part.type === "text") {
    return {
      type: "text",
      text: part.text
    };
  }
  return {
    type: "image",
    mimeType: part.mimeType,
    data: `[omitted:${part.data.length}]`
  };
}
function buildUserTurnText(userInput, conversationContext) {
  const trimmedContext = conversationContext?.trim();
  if (!trimmedContext) {
    return userInput;
  }
  return [
    "<current-message>",
    userInput,
    "</current-message>",
    "",
    "<thread-conversation-context>",
    "Use this context for continuity across prior thread turns.",
    trimmedContext,
    "</thread-conversation-context>"
  ].join("\n");
}
function encodeNonImageAttachmentForPrompt(attachment) {
  const base64 = attachment.data.toString("base64");
  const wasTruncated = base64.length > MAX_INLINE_ATTACHMENT_BASE64_CHARS;
  const encodedPayload = wasTruncated ? `${base64.slice(0, MAX_INLINE_ATTACHMENT_BASE64_CHARS)}...` : base64;
  return [
    "<attachment>",
    `filename: ${attachment.filename ?? "unnamed"}`,
    `media_type: ${attachment.mediaType}`,
    "encoding: base64",
    `truncated: ${wasTruncated ? "true" : "false"}`,
    "<data_base64>",
    encodedPayload,
    "</data_base64>",
    "</attachment>"
  ].join("\n");
}
function buildExecutionFailureMessage(toolErrorCount) {
  if (toolErrorCount > 0) {
    return "I couldn\u2019t complete this because one or more required tools failed in this turn. I\u2019ve logged the failure details.";
  }
  return "I couldn\u2019t complete this request in this turn due to an execution failure. I\u2019ve logged the details for debugging.";
}
function toToolContentText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function isToolResultMessage(value) {
  return typeof value === "object" && value !== null && value.role === "toolResult";
}
function normalizeToolNameFromResult(result) {
  if (!result || typeof result !== "object") return void 0;
  const record = result;
  if (typeof record.toolName === "string" && record.toolName.length > 0) {
    return record.toolName;
  }
  if (typeof record.name === "string" && record.name.length > 0) {
    return record.name;
  }
  return void 0;
}
function isToolResultError(result) {
  if (!result || typeof result !== "object") return false;
  return Boolean(result.isError);
}
function isAssistantMessage(value) {
  return typeof value === "object" && value !== null && value.role === "assistant";
}
function extractAssistantText(message) {
  const content = message.content ?? [];
  return content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}
function collectRelevantConfigurationKeys(activeSkills, explicitSkill) {
  const keys = /* @__PURE__ */ new Set();
  for (const skill of [...activeSkills, ...explicitSkill ? [explicitSkill] : []]) {
    for (const key of skill.usesConfig ?? []) {
      keys.add(key);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}
function createAgentTools(tools, sandbox, spanContext, onStatus, sandboxExecutor, capabilityRuntime, hooks) {
  return Object.entries(tools).map(([toolName, toolDef]) => ({
    name: toolName,
    label: toolName,
    description: toolDef.description,
    parameters: toolDef.inputSchema,
    execute: async (toolCallId, params) => {
      const normalizedToolCallId = typeof toolCallId === "string" && toolCallId.length > 0 ? toolCallId : void 0;
      const toolArgumentsAttribute = serializeGenAiAttribute(params);
      hooks?.onToolCall?.(toolName);
      const toolStartedAt = Date.now();
      await onStatus?.(`${formatToolStatusWithInput(toolName, params)}...`);
      return withSpan(
        `execute_tool ${toolName}`,
        "gen_ai.execute_tool",
        spanContext,
        async () => {
          if (!Value.Check(toolDef.inputSchema, params)) {
            const details = [...Value.Errors(toolDef.inputSchema, params)].slice(0, 3).map((entry) => `${entry.path || "/"}: ${entry.message}`).join("; ");
            const validationMessage = details.length > 0 ? details : "Invalid tool input";
            const durationMs = Date.now() - toolStartedAt;
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "error.type": "tool_input_validation_error"
            });
            setSpanStatus("error");
            logWarn(
              "agent_tool_call_invalid_input",
              {},
              {
                "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": toolName,
                ...normalizedToolCallId ? { "gen_ai.tool.call.id": normalizedToolCallId } : {},
                "app.ai.tool_duration_ms": durationMs
              },
              "Agent tool call input validation failed"
            );
            logException(
              new Error(validationMessage),
              "agent_tool_call_invalid_input_exception",
              {},
              {
                "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": toolName,
                ...normalizedToolCallId ? { "gen_ai.tool.call.id": normalizedToolCallId } : {},
                "app.ai.tool_duration_ms": durationMs
              },
              "Agent tool call input validation failed with exception"
            );
            throw new Error(validationMessage);
          }
          const parsed = params;
          try {
            if (typeof toolDef.execute !== "function") {
              const resultDetails2 = { ok: true };
              const durationMs2 = Date.now() - toolStartedAt;
              const toolResultAttribute2 = serializeGenAiAttribute(resultDetails2);
              setSpanAttributes({
                "app.ai.tool_duration_ms": durationMs2,
                "app.ai.tool_outcome": "success",
                ...toolResultAttribute2 ? { "gen_ai.tool.call.result": toolResultAttribute2 } : {}
              });
              setSpanStatus("ok");
              await onStatus?.(`${formatToolResultStatusWithInput(toolName, parsed)}...`);
              return {
                content: [{ type: "text", text: "ok" }],
                details: resultDetails2
              };
            }
            const injectedHeaders = toolName === "bash" ? capabilityRuntime?.getTurnHeaderTransforms() : void 0;
            const injectedEnv = toolName === "bash" ? capabilityRuntime?.getTurnEnv() : void 0;
            const bashCommand = toolName === "bash" && typeof parsed.command === "string" ? parsed.command.trim() : "";
            const isCustomBashCommand = toolName === "bash" && /^jr-rpc(?:\s|$)/.test(bashCommand);
            const shouldLogCredentialInjection = toolName === "bash" && !isCustomBashCommand && Boolean(injectedHeaders && injectedHeaders.length > 0);
            if (shouldLogCredentialInjection) {
              const headerDomains = (injectedHeaders ?? []).map((transform) => transform.domain);
              logInfo(
                "credential_inject_start",
                {},
                {
                  "app.skill.name": sandbox.getActiveSkill()?.name,
                  "app.credential.delivery": "header_transform",
                  "app.credential.header_domains": headerDomains
                },
                "Injecting scoped credential headers for sandbox command"
              );
            }
            const hasBashCredentials = injectedHeaders || injectedEnv;
            const result = sandboxExecutor?.canExecute(toolName) ? await sandboxExecutor.execute({
              toolName,
              input: toolName === "bash" && hasBashCredentials ? {
                ...parsed,
                ...injectedHeaders ? { headerTransforms: injectedHeaders } : {},
                ...injectedEnv ? { env: injectedEnv } : {}
              } : parsed
            }) : await toolDef.execute(parsed, {
              experimental_context: sandbox
            });
            const resultDetails = sandboxExecutor?.canExecute(toolName) && result && typeof result === "object" && "result" in result ? result.result : result;
            if (shouldLogCredentialInjection) {
              logInfo(
                "credential_inject_cleanup",
                {},
                {
                  "app.skill.name": sandbox.getActiveSkill()?.name
                },
                "Scoped credential header injection completed"
              );
            }
            const durationMs = Date.now() - toolStartedAt;
            const toolResultAttribute = serializeGenAiAttribute(resultDetails);
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "app.ai.tool_outcome": "success",
              ...toolResultAttribute ? { "gen_ai.tool.call.result": toolResultAttribute } : {}
            });
            setSpanStatus("ok");
            await onStatus?.(`${formatToolResultStatusWithInput(toolName, parsed)}...`);
            return {
              content: [{ type: "text", text: toToolContentText(resultDetails) }],
              details: resultDetails
            };
          } catch (error) {
            const durationMs = Date.now() - toolStartedAt;
            setSpanAttributes({
              "app.ai.tool_duration_ms": durationMs,
              "app.ai.tool_outcome": "error",
              "error.type": error instanceof Error ? error.name : "tool_execution_error"
            });
            setSpanStatus("error");
            logException(
              error,
              "agent_tool_call_failed",
              {},
              {
                "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": toolName,
                ...normalizedToolCallId ? { "gen_ai.tool.call.id": normalizedToolCallId } : {},
                "app.ai.tool_duration_ms": durationMs
              },
              "Agent tool call failed"
            );
            throw error;
          }
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": toolName,
          ...normalizedToolCallId ? { "gen_ai.tool.call.id": normalizedToolCallId } : {},
          ...toolArgumentsAttribute ? { "gen_ai.tool.call.arguments": toolArgumentsAttribute } : {}
        }
      );
    }
  }));
}
async function generateAssistantReply(messageText, context = {}) {
  try {
    const spanContext = {
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      workflowRunId: context.correlation?.workflowRunId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId
    };
    const availableSkills = await discoverSkills({ additionalRoots: context.skillDirs });
    const configurationValues = {
      ...context.configuration ?? {}
    };
    const userInput = messageText;
    const explicitInvocation = parseSkillInvocation(userInput, availableSkills);
    const explicitSkill = explicitInvocation ? findSkillByName(explicitInvocation.skillName, availableSkills) : null;
    const activeSkills = [];
    const skillSandbox = new SkillSandbox(availableSkills, activeSkills);
    const capabilityRuntime = createSkillCapabilityRuntime({
      invocationArgs: explicitInvocation?.args,
      requesterId: context.requester?.userId,
      resolveConfiguration: async (key) => configurationValues[key]
    });
    const sandboxExecutor = createSandboxExecutor({
      sandboxId: context.sandbox?.sandboxId,
      traceContext: spanContext,
      runBashCustomCommand: async (command) => {
        const result = await maybeExecuteJrRpcCustomCommand(command, {
          capabilityRuntime,
          activeSkill: skillSandbox.getActiveSkill(),
          channelConfiguration: context.channelConfiguration,
          requesterId: context.requester?.userId,
          channelId: context.correlation?.channelId,
          threadTs: context.correlation?.threadTs,
          userMessage: userInput,
          userTokenStore: getUserTokenStore(),
          onConfigurationValueChanged: (key, value) => {
            if (value === void 0) {
              delete configurationValues[key];
              return;
            }
            configurationValues[key] = value;
          }
        });
        return result.handled ? { handled: true, result: result.result } : { handled: false };
      }
    });
    sandboxExecutor.configureSkills(availableSkills);
    const sandbox = await sandboxExecutor.createSandbox();
    if (explicitSkill) {
      const preloaded = await skillSandbox.loadSkill(explicitSkill.name);
      if (preloaded) {
        activeSkills.push(preloaded);
      }
    }
    const userTurnText = buildUserTurnText(userInput, context.conversationContext);
    if (!getGatewayApiKey()) {
      const providerError = "Missing AI gateway credentials (AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN)";
      return {
        text: `Error: ${providerError}`,
        sandboxId: sandboxExecutor.getSandboxId(),
        diagnostics: {
          outcome: "provider_error",
          modelId: botConfig.modelId,
          assistantMessageCount: 0,
          toolCalls: [],
          toolResultCount: 0,
          toolErrorCount: 0,
          usedPrimaryText: false,
          errorMessage: providerError
        }
      };
    }
    const generatedFiles = [];
    const artifactStatePatch = {};
    const toolCalls = [];
    setTags({
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      workflowRunId: context.correlation?.workflowRunId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId
    });
    const tools = createTools(
      availableSkills,
      {
        onGeneratedFiles: (files) => {
          generatedFiles.push(...files);
        },
        onArtifactStatePatch: (patch) => {
          Object.assign(artifactStatePatch, patch);
        },
        onToolCallStart: async (toolName, input) => {
          await context.onStatus?.(`${formatToolStatusWithInput(toolName, input)}...`);
        },
        onToolCallEnd: async (toolName, input) => {
          await context.onStatus?.(`${formatToolResultStatusWithInput(toolName, input)}...`);
        },
        onSkillLoaded: async (loadedSkill) => {
          const resolvedSkill = await skillSandbox.loadSkill(loadedSkill.name);
          const effective = resolvedSkill ?? loadedSkill;
          const existing = activeSkills.find((skill) => skill.name === effective.name);
          if (existing) {
            existing.body = effective.body;
            existing.description = effective.description;
            existing.skillPath = effective.skillPath;
            existing.allowedTools = effective.allowedTools;
            existing.requiresCapabilities = effective.requiresCapabilities;
            existing.usesConfig = effective.usesConfig;
            return;
          }
          activeSkills.push(effective);
        }
      },
      {
        channelId: context.toolChannelId ?? context.correlation?.channelId,
        messageTs: context.correlation?.messageTs,
        threadTs: context.correlation?.threadTs,
        userText: userInput,
        artifactState: context.artifactState,
        configuration: configurationValues,
        sandbox
      }
    );
    const baseInstructions = buildSystemPrompt({
      availableSkills,
      activeSkills,
      invocation: explicitInvocation,
      assistant: context.assistant,
      requester: context.requester,
      artifactState: context.artifactState,
      configuration: configurationValues,
      relevantConfigurationKeys: collectRelevantConfigurationKeys(activeSkills, explicitSkill)
    });
    const userContentParts = [
      { type: "text", text: userTurnText }
    ];
    for (const attachment of context.userAttachments ?? []) {
      if (attachment.mediaType.startsWith("image/")) {
        userContentParts.push({
          type: "image",
          data: attachment.data.toString("base64"),
          mimeType: attachment.mediaType
        });
      } else {
        userContentParts.push({
          type: "text",
          text: encodeNonImageAttachmentForPrompt(attachment)
        });
      }
    }
    const inputMessagesAttribute = serializeGenAiAttribute([
      {
        role: "system",
        content: [{ type: "text", text: baseInstructions }]
      },
      {
        role: "user",
        content: userContentParts.map((part) => toObservablePromptPart(part))
      }
    ]);
    const agent = new Agent({
      getApiKey: () => getGatewayApiKey(),
      initialState: {
        systemPrompt: baseInstructions,
        model: resolveGatewayModel(botConfig.modelId),
        tools: createAgentTools(
          tools,
          skillSandbox,
          spanContext,
          context.onStatus,
          sandboxExecutor,
          capabilityRuntime,
          {
            onToolCall: (toolName) => {
              toolCalls.push(toolName);
            },
            onGeneratedFiles: (files) => generatedFiles.push(...files),
            onArtifactStatePatch: (patch) => Object.assign(artifactStatePatch, patch)
          }
        )
      }
    });
    let hasEmittedText = false;
    let needsSeparator = false;
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "message_start") {
        if (hasEmittedText) {
          needsSeparator = true;
        }
        return;
      }
      if (event.type !== "message_update") {
        return;
      }
      if (event.assistantMessageEvent.type !== "text_delta") {
        return;
      }
      const deltaText = event.assistantMessageEvent.delta;
      if (!deltaText) {
        return;
      }
      const text = needsSeparator ? "\n\n" + deltaText : deltaText;
      needsSeparator = false;
      hasEmittedText = true;
      Promise.resolve(context.onTextDelta?.(text)).catch((error) => {
        logWarn(
          "streaming_text_delta_error",
          {},
          { "error.message": error instanceof Error ? error.message : String(error) },
          "Failed to deliver text delta to stream"
        );
      });
    });
    const beforeMessageCount = agent.state.messages.length;
    let newMessages = [];
    try {
      await withSpan(
        "ai.generate_assistant_reply",
        "gen_ai.invoke_agent",
        spanContext,
        async () => {
          let promptResult;
          const promptPromise = agent.prompt({
            role: "user",
            content: userContentParts,
            timestamp: Date.now()
          });
          let timeoutId;
          let didTimeout = false;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              didTimeout = true;
              agent.abort();
              reject(new Error(`Agent turn timed out after ${AGENT_TURN_TIMEOUT_MS}ms`));
            }, AGENT_TURN_TIMEOUT_MS);
          });
          try {
            promptResult = await Promise.race([promptPromise, timeoutPromise]);
          } catch (error) {
            if (didTimeout) {
              logWarn(
                "agent_turn_timeout",
                {},
                {
                  "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
                  "gen_ai.operation.name": "invoke_agent",
                  "gen_ai.request.model": botConfig.modelId,
                  "app.ai.turn_timeout_ms": AGENT_TURN_TIMEOUT_MS
                },
                "Agent turn timed out and was aborted"
              );
              await promptPromise.catch(() => {
              });
            }
            throw error;
          } finally {
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
          }
          newMessages = agent.state.messages.slice(beforeMessageCount);
          const outputMessages = newMessages.filter(isAssistantMessage);
          const outputMessagesAttribute = serializeGenAiAttribute(outputMessages);
          const usageAttributes = extractGenAiUsageAttributes(promptResult, agent.state, ...outputMessages);
          setSpanAttributes({
            ...outputMessagesAttribute ? { "gen_ai.output.messages": outputMessagesAttribute } : {},
            ...usageAttributes
          });
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.request.model": botConfig.modelId,
          ...inputMessagesAttribute ? { "gen_ai.input.messages": inputMessagesAttribute } : {}
        }
      );
    } finally {
      unsubscribe();
    }
    const toolResults = newMessages.filter(isToolResultMessage);
    const assistantMessages = newMessages.filter(isAssistantMessage);
    const primaryText = assistantMessages.map((message) => extractAssistantText(message)).join("\n\n").trim();
    const toolErrorCount = toolResults.filter((result) => result.isError).length;
    const explicitChannelPostIntent = isExplicitChannelPostIntent(userInput);
    const successfulToolNames = new Set(
      toolResults.filter((result) => !isToolResultError(result)).map((result) => normalizeToolNameFromResult(result)).filter((value) => Boolean(value))
    );
    const channelPostPerformed = successfulToolNames.has("slackChannelPostMessage");
    const reactionPerformed = successfulToolNames.has("slackMessageAddReaction");
    const deliveryPlan = buildReplyDeliveryPlan({
      explicitChannelPostIntent,
      channelPostPerformed,
      reactionPerformed,
      hasFiles: generatedFiles.length > 0,
      streamingThreadReply: Boolean(context.onTextDelta)
    });
    const deliveryMode = deliveryPlan.mode;
    const ackStrategy = deliveryPlan.ack;
    if (!primaryText) {
      logWarn(
        "ai_model_response_empty",
        {
          slackThreadId: context.correlation?.threadId,
          slackUserId: context.correlation?.requesterId,
          slackChannelId: context.correlation?.channelId,
          workflowRunId: context.correlation?.workflowRunId,
          assistantUserName: context.assistant?.userName,
          modelId: botConfig.modelId
        },
        {
          "app.ai.tool_results": toolResults.length,
          "app.ai.tool_error_results": toolErrorCount,
          "app.ai.generated_files": generatedFiles.length
        },
        "Model returned empty text response"
      );
    }
    const lastAssistant = assistantMessages.at(-1);
    const stopReason = typeof lastAssistant?.stopReason === "string" ? lastAssistant.stopReason : void 0;
    const errorMessage = typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : void 0;
    const usedPrimaryText = Boolean(primaryText);
    const outcome = primaryText ? stopReason === "error" ? "provider_error" : "success" : "execution_failure";
    const resolvedText = primaryText || buildExecutionFailureMessage(toolErrorCount);
    if (isExecutionEscapeResponse(resolvedText) || isRawToolPayloadResponse(resolvedText)) {
      return {
        text: buildExecutionFailureMessage(toolErrorCount),
        files: generatedFiles.length > 0 ? generatedFiles : void 0,
        artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : void 0,
        deliveryPlan,
        deliveryMode,
        ackStrategy,
        sandboxId: sandboxExecutor.getSandboxId(),
        diagnostics: {
          outcome: "execution_failure",
          modelId: botConfig.modelId,
          assistantMessageCount: assistantMessages.length,
          toolCalls,
          toolResultCount: toolResults.length,
          toolErrorCount,
          usedPrimaryText,
          stopReason,
          errorMessage,
          providerError: void 0
        }
      };
    }
    return {
      text: resolvedText,
      files: generatedFiles.length > 0 ? generatedFiles : void 0,
      artifactStatePatch: Object.keys(artifactStatePatch).length > 0 ? artifactStatePatch : void 0,
      deliveryPlan,
      deliveryMode,
      ackStrategy,
      sandboxId: sandboxExecutor.getSandboxId(),
      diagnostics: {
        outcome,
        modelId: botConfig.modelId,
        assistantMessageCount: assistantMessages.length,
        toolCalls,
        toolResultCount: toolResults.length,
        toolErrorCount,
        usedPrimaryText,
        stopReason,
        errorMessage,
        providerError: void 0
      }
    };
  } catch (error) {
    logException(error, "assistant_reply_generation_failed", {
      slackThreadId: context.correlation?.threadId,
      slackUserId: context.correlation?.requesterId,
      slackChannelId: context.correlation?.channelId,
      workflowRunId: context.correlation?.workflowRunId,
      assistantUserName: context.assistant?.userName,
      modelId: botConfig.modelId
    }, {}, "generateAssistantReply failed");
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: `Error: ${message}`,
      sandboxId: void 0,
      diagnostics: {
        outcome: "provider_error",
        modelId: botConfig.modelId,
        assistantMessageCount: 0,
        toolCalls: [],
        toolResultCount: 0,
        toolErrorCount: 0,
        usedPrimaryText: false,
        errorMessage: message,
        providerError: error
      }
    };
  }
}

// src/chat/app-home.ts
async function buildHomeView(userId, userTokenStore) {
  const providers = getPluginProviders();
  const connectedSections = [];
  for (const plugin of providers) {
    if (plugin.manifest.credentials.type !== "oauth-bearer") continue;
    const tokens = await userTokenStore.get(userId, plugin.manifest.name);
    if (!tokens) continue;
    connectedSections.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${plugin.manifest.name}*
${plugin.manifest.description}`
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: "Unlink" },
        action_id: "app_home_disconnect",
        value: plugin.manifest.name,
        style: "danger"
      }
    });
  }
  if (connectedSections.length === 0) {
    return {
      type: "home",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "No connected accounts"
          }
        }
      ]
    };
  }
  return {
    type: "home",
    blocks: connectedSections
  };
}
async function publishAppHomeView(slackClient, userId, userTokenStore) {
  const view = await buildHomeView(userId, userTokenStore);
  await slackClient.views.publish({ user_id: userId, view });
  logInfo("app_home_published", {}, { "app.user_id": userId });
}

export {
  isPluginProvider,
  getUserTokenStore,
  getSlackClient,
  isDmChannel,
  downloadPrivateSlackFile,
  getOAuthProviderConfig,
  resolveBaseUrl,
  startOAuthFlow,
  ensureBlockSpacing,
  buildSlackOutputMessage,
  escapeXml,
  isExplicitChannelPostIntent,
  GEN_AI_PROVIDER_NAME,
  completeText,
  completeObject,
  listThreadReplies,
  truncateStatusText,
  generateAssistantReply,
  publishAppHomeView
};
