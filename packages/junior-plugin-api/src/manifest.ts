export interface PluginOAuthConfig {
  authorizeEndpoint: string;
  authorizeParams?: Record<string, string>;
  clientIdEnv: string;
  clientSecretEnv: string;
  scope?: string;
  /**
   * Treat a provider token response with `scope: ""` like an omitted scope and
   * fall back to the requested scope string when storing the token.
   */
  treatEmptyScopeAsUnreported?: boolean;
  tokenAuthMethod?: "body" | "basic";
  tokenEndpoint: string;
  tokenExtraHeaders?: Record<string, string>;
}

export interface PluginOAuthBearerCredentials {
  apiHeaders?: Record<string, string>;
  authTokenEnv: string;
  authTokenPlaceholder?: string;
  domains: string[];
  type: "oauth-bearer";
}

export type PluginCredentials = PluginOAuthBearerCredentials;

export interface PluginNpmRuntimeDependency {
  package: string;
  type: "npm";
  version: string;
}

export interface PluginSystemRuntimeDependency {
  package: string;
  type: "system";
}

export interface PluginSystemRuntimeDependencyFromUrl {
  sha256: string;
  type: "system";
  url: string;
}

export type PluginRuntimeDependency =
  | PluginNpmRuntimeDependency
  | PluginSystemRuntimeDependency
  | PluginSystemRuntimeDependencyFromUrl;

export interface PluginRuntimePostinstallCommand {
  args?: string[];
  cmd: string;
  sudo?: boolean;
}

/** Bot credentials for the ID-JAG profile of the RFC 7523 `jwt-bearer` grant. */
export interface PluginMcpAuthConfig {
  /** Issuer string the MCP server trusts for this bot. */
  issuer: string;
  /** JWKS key id of the published public key that pairs with the private key. */
  keyId: string;
  /** Env var holding the PEM (PKCS#8) private signing key. */
  privateKeyEnv: string;
}

/** Pre-registered OAuth client for per-actor MCP OAuth without dynamic client registration. */
export interface PluginMcpOAuthClientConfig {
  /** Extra authorization request parameters, such as `access_type: offline`. */
  authorizeParams?: Record<string, string>;
  /** Env var holding the OAuth client id. */
  clientIdEnv: string;
  /** Env var holding the OAuth client secret. */
  clientSecretEnv: string;
  /** Space-delimited scope requested instead of the scopes the MCP server advertises. */
  scope?: string;
}

export interface PluginMcpConfig {
  /** Provider tools exposed directly to the model. */
  allowedTools?: string[];
  /** Bot auth: sign short-lived JWT assertions instead of per-actor OAuth. */
  auth?: PluginMcpAuthConfig;
  /** Request headers. Values may use `${NAME}` refs to declared env vars; Junior resolves them at connect time. */
  headers?: Record<string, string>;
  /** Per-actor OAuth with a pre-registered client instead of dynamic client registration. */
  oauthClient?: PluginMcpOAuthClientConfig;
  transport: "http";
  url: string;
  /** Provider tools hidden from the model and callable only by plugin-owned wrapper tools. */
  wrappedTools?: string[];
}

/**
 * Optional install-wide provider account, often a bot, that Junior itself
 * uses for one plugin.
 *
 * An Admin connects the service account one time on the dashboard Admin
 * page. Each request surface enforces its own part of this policy.
 *
 * By default, per-actor OAuth stays on, and an Actor's own connection
 * always wins. An Actor without their own connection uses the service
 * account for requests that this policy allows. Other requests ask the
 * Actor to connect their own account.
 *
 * With `userOAuth: false`, Junior uses only the service account. It never
 * asks an Actor to connect and ignores their own connections. Until an
 * Admin connects the account, the plugin is not available.
 */
export interface PluginServiceAccountConfig {
  /** Set false to turn off per-actor OAuth for the plugin. Defaults to true. */
  userOAuth?: boolean;
  /** MCP tools that the account may call. Each must be in `mcp.allowedTools`. */
  mcpTools: string[];
}

export interface PluginEnvVarDeclaration {
  default?: string;
  exposeToCommandEnv?: boolean;
}

export interface PluginManifest {
  apiHeaders?: Record<string, string>;
  commandEnv?: Record<string, string>;
  configKeys?: string[];
  credentials?: PluginCredentials;
  description: string;
  displayName: string;
  domains?: string[];
  envVars?: Record<string, PluginEnvVarDeclaration>;
  mcp?: PluginMcpConfig;
  name: string;
  oauth?: PluginOAuthConfig;
  runtimeDependencies?: PluginRuntimeDependency[];
  runtimePostinstall?: PluginRuntimePostinstallCommand[];
  serviceAccount?: PluginServiceAccountConfig;
  target?: {
    commandFlags?: string[];
    configKey: string;
    type: string;
  };
}
