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

/** Request header that carries a workload identity token. */
export type PluginWorkloadIdentityHeader =
  | "Authorization"
  | "Proxy-Authorization"
  | "X-Serverless-Authorization";

/**
 * Google Cloud token that Junior mints for one service account.
 *
 * `service-account-jwt` signs a JWT with `iss` and `sub` set to the service
 * account (Identity-Aware Proxy accepts it). `id-token` mints a Google ID
 * token (Cloud Run accepts it). `access-token` mints an OAuth access token for
 * Google APIs.
 */
export type PluginGcpWorkloadIdentityToken =
  | { audience: string; token: "id-token" }
  | { audience: string; token: "service-account-jwt" }
  | { scopes: string[]; token: "access-token" };

/** Google Cloud workload identity federation through one service account. */
export type PluginGcpWorkloadIdentityConfig = PluginGcpWorkloadIdentityToken & {
  /** Service account email that Junior impersonates. */
  serviceAccount: string;
  /** `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
  workloadIdentityProvider: string;
};

/** Microsoft Entra ID workload identity federation for one app registration. */
export interface PluginAzureWorkloadIdentityConfig {
  clientId: string;
  /** Token scope, such as `api://<app>/.default`. */
  scope: string;
  tenantId: string;
}

/**
 * Bot credential that Junior mints on the host from the deployment's Vercel
 * OIDC token. Set exactly one of `gcp` or `azure`.
 */
export type PluginWorkloadIdentityCredentials = {
  domains: string[];
  /** Defaults to `Authorization`. */
  header?: PluginWorkloadIdentityHeader;
  type: "workload-identity";
} & (
  | { azure?: never; gcp: PluginGcpWorkloadIdentityConfig }
  | { azure: PluginAzureWorkloadIdentityConfig; gcp?: never }
);

export type PluginCredentials =
  | PluginOAuthBearerCredentials
  | PluginWorkloadIdentityCredentials;

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
  /** Provider tools whose successful calls Junior records as audit events. */
  auditTools?: string[];
}

/**
 * Which provider accounts Junior may use for one plugin.
 *
 * By default, each Actor connects their own account with per-actor OAuth.
 * A plugin can also allow an optional install-wide service account, often a
 * bot. An Admin connects it one time on the dashboard Admin page.
 *
 * An Actor's own connection always wins. An Actor without their own
 * connection uses the service account for what it lists. Other requests ask
 * the Actor to connect their own account.
 *
 * With `userOAuth: false`, Junior uses only the service account. It never
 * asks an Actor to connect, ignores their own connections, and hides tools
 * that the service account does not list. Until an Admin connects the
 * account, the plugin is not available.
 */
export interface PluginAccountsConfig {
  /** Set false to turn off per-actor OAuth for the plugin. Defaults to true. */
  userOAuth?: boolean;
  /** Optional service account and what it may use. Omit for none. */
  serviceAccount?: PluginServiceAccountConfig;
}

/** What one plugin's service account may use. */
export interface PluginServiceAccountConfig {
  /** MCP tools that the account may call. Each must be loaded by `mcp`. */
  tools: string[];
}

export interface PluginEnvVarDeclaration {
  default?: string;
  exposeToCommandEnv?: boolean;
}

export interface PluginManifest {
  accounts?: PluginAccountsConfig;
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
  target?: {
    commandFlags?: string[];
    configKey: string;
    type: string;
  };
}
