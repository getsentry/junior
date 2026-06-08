import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type {
  PluginEnvVarDeclaration,
  PluginMcpConfig,
  PluginOAuthConfig,
  OAuthBearerCredentials,
  PluginCredentials,
  PluginCatalogConfig,
  PluginManifest,
  PluginManifestConfig,
  PluginNpmRuntimeDependency,
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
  PluginSystemRuntimeDependency,
  PluginSystemRuntimeDependencyFromUrl,
} from "./types";
import { inlineManifestSource } from "./inline-manifest-source";

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SHORT_CAPABILITY_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const SHORT_CONFIG_KEY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const TARGET_FLAG_RE = /^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/;
const AUTH_TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]*$/;
const ENV_VAR_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const ENV_PLACEHOLDER_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
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

const trimmedString = z.string().transform((value) => value.trim());
const nonEmptyTrimmedString = trimmedString.pipe(
  z.string().min(1, { error: "must be a non-empty string" }),
);
const nonEmptyStringArraySchema = (
  fieldName: string,
  options: { nonEmptyMessage?: string } = {},
) =>
  z
    .array(z.string(), {
      error: "must be an array of strings when provided",
    })
    .min(1, {
      error:
        options.nonEmptyMessage ??
        "must be a non-empty array of strings when provided",
    })
    .transform((values, ctx) => {
      const result: string[] = [];
      const seen = new Set<string>();

      for (const rawValue of values) {
        const value = rawValue.trim();
        if (!value) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${fieldName} entries must be non-empty strings`,
          });
          return z.NEVER;
        }
        if (seen.has(value)) {
          continue;
        }
        seen.add(value);
        result.push(value);
      }

      return result;
    });
const envVarString = nonEmptyTrimmedString.refine(
  (value) => AUTH_TOKEN_ENV_RE.test(value),
  {
    error: "must be an uppercase env var name",
  },
);
const httpsUrlString = nonEmptyTrimmedString.superRefine((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must be a valid URL",
    });
    return;
  }

  if (parsed.protocol !== "https:") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "must use https",
    });
  }
});

const stringMapSchema = z
  .record(z.string(), z.unknown())
  .transform((record, ctx) => {
    const entries = Object.entries(record);
    const result: Record<string, string> = {};
    const seen = new Set<string>();

    for (const [rawKey, rawValue] of entries) {
      const key = rawKey.trim();
      if (!key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "keys must be non-empty strings",
        });
        return z.NEVER;
      }
      if (typeof rawValue !== "string" || !rawValue.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} must be a non-empty string`,
        });
        return z.NEVER;
      }
      const normalizedKey = key.toLowerCase();
      if (seen.has(normalizedKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} is duplicated`,
        });
        return z.NEVER;
      }
      seen.add(normalizedKey);
      result[key] = rawValue.trim();
    }

    return result;
  });

const domainsSchema = z
  .array(z.unknown())
  .min(1, {
    error: "must be a non-empty array of strings",
  })
  .transform((domains, ctx) => {
    return domains.map((rawDomain) => {
      const domain =
        typeof rawDomain === "string" ? rawDomain.trim().toLowerCase() : "";
      if (!domain) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "entries must be non-empty strings",
        });
        return z.NEVER;
      }
      if (!API_DOMAIN_RE.test(domain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "entries must be valid domain names",
        });
        return z.NEVER;
      }
      return domain;
    });
  });

const baseCredentialsSchema = z
  .object({
    domains: domainsSchema.optional(),
  })
  .passthrough();

const oauthBearerCredentialsSchema = baseCredentialsSchema.extend({
  "api-headers": stringMapSchema.optional(),
  "auth-token-env": envVarString,
  "auth-token-placeholder": nonEmptyTrimmedString.optional(),
  type: z.literal("oauth-bearer"),
});

interface ManifestParseOptions {
  allowHookManagedEgress?: boolean;
}

const runtimeDependencyEntrySchema = z
  .object({
    type: z.enum(["npm", "system"]),
    package: z.string().optional(),
    version: z.string().optional(),
    url: z.string().optional(),
    sha256: z.string().optional(),
  })
  .passthrough();

const runtimePostinstallCommandSourceSchema = z
  .object({
    cmd: nonEmptyTrimmedString,
    args: z
      .array(z.string(), {
        error: "args must be an array of strings when provided",
      })
      .optional(),
    sudo: z
      .boolean({
        error: "sudo must be a boolean when provided",
      })
      .optional(),
  })
  .passthrough();

const oauthSourceSchema = z
  .object({
    "client-id-env": envVarString,
    "client-secret-env": envVarString,
    "authorize-endpoint": httpsUrlString,
    "token-endpoint": httpsUrlString,
    scope: nonEmptyTrimmedString.optional(),
    "authorize-params": stringMapSchema.optional(),
    "token-extra-headers": stringMapSchema.optional(),
    "token-auth-method": nonEmptyTrimmedString
      .refine((value) => value === "body" || value === "basic", {
        error: 'must be "body" or "basic"',
      })
      .optional(),
    "treat-empty-scope-as-unreported": z.boolean().optional(),
  })
  .passthrough();

const mcpSourceSchema = z
  .object({
    transport: nonEmptyTrimmedString
      .refine((value) => value === "http", {
        error: 'must be "http"',
      })
      .optional(),
    url: httpsUrlString,
    headers: stringMapSchema.optional(),
    "allowed-tools": nonEmptyStringArraySchema("allowed-tools").optional(),
  })
  .passthrough();

const targetSourceSchema = z
  .object({
    type: nonEmptyTrimmedString.refine((value) => PLUGIN_NAME_RE.test(value), {
      error: "type must be a lowercase target identifier",
    }),
    "config-key": nonEmptyTrimmedString,
    "command-flags": nonEmptyStringArraySchema("command-flags").optional(),
  })
  .passthrough();

const manifestSourceSchema = z
  .object({
    name: z.string().refine((value) => PLUGIN_NAME_RE.test(value), {
      error: "invalid",
    }),
    description: nonEmptyTrimmedString,
    capabilities: z
      .array(z.string(), {
        error: "must be an array when provided",
      })
      .optional(),
    "config-keys": z
      .array(z.string(), {
        error: "must be an array when provided",
      })
      .optional(),
    domains: domainsSchema.optional(),
    "api-headers": stringMapSchema.optional(),
    "command-env": stringMapSchema.optional(),
    credentials: z
      .record(z.string(), z.unknown(), {
        error: "must be an object when provided",
      })
      .optional(),
    "runtime-dependencies": z
      .array(z.unknown(), {
        error: "must be an array",
      })
      .optional(),
    "runtime-postinstall": z
      .array(z.unknown(), {
        error: "must be an array",
      })
      .optional(),
    "env-vars": z
      .record(z.string(), z.unknown(), {
        error: "must be an object",
      })
      .optional(),
    mcp: z
      .record(z.string(), z.unknown(), {
        error: "must be an object",
      })
      .optional(),
    oauth: z
      .record(z.string(), z.unknown(), {
        error: "must be an object",
      })
      .optional(),
    target: z
      .record(z.string(), z.unknown(), {
        error: "must be an object",
      })
      .optional(),
  })
  .passthrough();

type ManifestSource = Record<string, unknown>;

function setDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function manifestConfigPatch(
  config: PluginManifestConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  setDefined(result, "description", config.description);
  setDefined(result, "capabilities", config.capabilities);
  setDefined(result, "config-keys", config.configKeys);
  setDefined(result, "domains", config.domains);
  setDefined(result, "api-headers", config.apiHeaders);
  setDefined(result, "command-env", config.commandEnv);
  setDefined(result, "env-vars", config.envVars);

  if (config.credentials !== undefined) {
    if (!config.credentials) {
      result.credentials = null;
    } else {
      const credentials: Record<string, unknown> = {};
      setDefined(credentials, "type", config.credentials.type);
      setDefined(credentials, "domains", config.credentials.domains);
      setDefined(credentials, "api-headers", config.credentials.apiHeaders);
      setDefined(
        credentials,
        "auth-token-env",
        config.credentials.authTokenEnv,
      );
      setDefined(
        credentials,
        "auth-token-placeholder",
        config.credentials.authTokenPlaceholder,
      );
      result.credentials = credentials;
    }
  }
  setDefined(result, "runtime-dependencies", config.runtimeDependencies);
  setDefined(result, "runtime-postinstall", config.runtimePostinstall);

  if (config.mcp !== undefined) {
    if (!config.mcp) {
      result.mcp = null;
    } else {
      const mcp: Record<string, unknown> = {};
      setDefined(mcp, "transport", config.mcp.transport);
      setDefined(mcp, "url", config.mcp.url);
      setDefined(mcp, "headers", config.mcp.headers);
      setDefined(mcp, "allowed-tools", config.mcp.allowedTools);
      result.mcp = mcp;
    }
  }
  if (config.oauth !== undefined) {
    if (!config.oauth) {
      result.oauth = null;
    } else {
      const oauth: Record<string, unknown> = {};
      setDefined(oauth, "client-id-env", config.oauth.clientIdEnv);
      setDefined(oauth, "client-secret-env", config.oauth.clientSecretEnv);
      setDefined(oauth, "authorize-endpoint", config.oauth.authorizeEndpoint);
      setDefined(oauth, "token-endpoint", config.oauth.tokenEndpoint);
      setDefined(oauth, "scope", config.oauth.scope);
      setDefined(oauth, "authorize-params", config.oauth.authorizeParams);
      setDefined(oauth, "token-auth-method", config.oauth.tokenAuthMethod);
      setDefined(oauth, "token-extra-headers", config.oauth.tokenExtraHeaders);
      setDefined(
        oauth,
        "treat-empty-scope-as-unreported",
        config.oauth.treatEmptyScopeAsUnreported,
      );
      result.oauth = oauth;
    }
  }
  if (config.target !== undefined) {
    if (!config.target) {
      result.target = null;
    } else {
      const target: Record<string, unknown> = {};
      setDefined(target, "type", config.target.type);
      setDefined(target, "config-key", config.target.configKey);
      setDefined(target, "command-flags", config.target.commandFlags);
      result.target = target;
    }
  }
  return result;
}

function isPlainRecord(value: unknown): value is ManifestSource {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeManifestConfig(
  base: ManifestSource,
  patch: ManifestSource,
  options: { root?: boolean } = {},
): ManifestSource {
  const merged: ManifestSource = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (options.root && key === "name") {
      throw new Error("plugins.manifests cannot change plugin names");
    }
    if (value === null) {
      delete merged[key];
      continue;
    }
    const current = merged[key];
    if (isPlainRecord(current) && isPlainRecord(value)) {
      merged[key] = mergeManifestConfig(current, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function applyManifestConfig(
  source: ManifestSource,
  config: PluginCatalogConfig | undefined,
): ManifestSource {
  const name = source.name;
  if (typeof name !== "string") {
    return source;
  }
  const manifestConfig = config?.manifests?.[name];
  if (manifestConfig && "name" in manifestConfig) {
    throw new Error("plugins.manifests cannot change plugin names");
  }
  return manifestConfig
    ? mergeManifestConfig(source, manifestConfigPatch(manifestConfig), {
        root: true,
      })
    : source;
}

function formatPath(path: PropertyKey[]): string {
  return path.map((segment) => String(segment)).join(".");
}

function issueMessage(error: z.ZodError, prefix: string): string {
  const issue = error.issues[0];
  if (!issue) {
    return prefix;
  }
  const suffix = formatPath(issue.path);
  return suffix
    ? `${prefix}.${suffix} ${issue.message}`
    : `${prefix} ${issue.message}`;
}

function normalizeStringMap(
  value: Record<string, string> | undefined,
  prefix: string,
  options: { reservedKeys?: Set<string>; forbiddenKeys?: Set<string> } = {},
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) {
    return undefined;
  }

  for (const key of keys) {
    const normalizedKey = key.toLowerCase();
    if (options.reservedKeys?.has(normalizedKey)) {
      throw new Error(`${prefix}.${key} is reserved by the runtime`);
    }
    if (options.forbiddenKeys?.has(normalizedKey)) {
      throw new Error(`${prefix}.${key} is not allowed`);
    }
  }

  return value;
}

function envReferences(value: string): string[] {
  return Array.from(value.matchAll(ENV_PLACEHOLDER_RE), (match) => {
    return match[1] as string;
  });
}

function assertDeclaredEnvReferences(
  value: string,
  envVars: Record<string, PluginEnvVarDeclaration>,
  context: string,
): void {
  for (const name of envReferences(value)) {
    if (!Object.prototype.hasOwnProperty.call(envVars, name)) {
      throw new Error(
        `${context} references env var ${name} which is not declared in env-vars`,
      );
    }
    if (envVars[name]?.default !== undefined) {
      throw new Error(
        `${context} references env var ${name}, but API header env vars must not declare defaults`,
      );
    }
  }
}

function normalizeRequiredApiHeaders(
  value: Record<string, string>,
  prefix: string,
  envVars: Record<string, PluginEnvVarDeclaration>,
): Record<string, string> {
  const apiHeaders = normalizeStringMap(value, prefix);
  if (!apiHeaders) {
    throw new Error(`${prefix} must contain at least one header`);
  }
  for (const [key, headerValue] of Object.entries(apiHeaders)) {
    assertDeclaredEnvReferences(headerValue, envVars, `${prefix}.${key}`);
  }
  return apiHeaders;
}

function assertCommandEnvReferencesDeclared(
  value: string,
  envVars: Record<string, PluginEnvVarDeclaration>,
  context: string,
): void {
  for (const name of envReferences(value)) {
    if (!Object.prototype.hasOwnProperty.call(envVars, name)) {
      throw new Error(
        `${context} references env var ${name} which is not declared in env-vars`,
      );
    }
  }
}

function expandCommandEnvPlaceholders(
  template: string,
  envVars: Record<string, PluginEnvVarDeclaration>,
  context: string,
): string {
  return template.replace(ENV_PLACEHOLDER_RE, (match, name) => {
    const varName = name as string;
    const declaration = envVars[varName] as PluginEnvVarDeclaration | undefined;
    if (declaration?.default === undefined) {
      return match;
    }
    return expandEnvPlaceholders(match, envVars, context);
  });
}

function normalizeCommandEnv(
  value: Record<string, string>,
  prefix: string,
  envVars: Record<string, PluginEnvVarDeclaration>,
): Record<string, string> {
  const env = normalizeStringMap(value, prefix);
  if (!env) {
    throw new Error(`${prefix} must contain at least one env var`);
  }

  for (const [key, envValue] of Object.entries(env)) {
    if (!ENV_VAR_NAME_RE.test(key)) {
      throw new Error(`${prefix}.${key} must be an uppercase env var name`);
    }
    assertCommandEnvReferencesDeclared(envValue, envVars, `${prefix}.${key}`);
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, envValue]) => [
      key,
      expandCommandEnvPlaceholders(envValue, envVars, `${prefix}.${key}`),
    ]),
  );
}

function assertCommandEnvDoesNotExposeHostSecretRefs(
  commandEnv: Record<string, string> | undefined,
  apiHeaders: Record<string, string> | undefined,
  credentials: PluginCredentials | undefined,
  oauth: PluginOAuthConfig | undefined,
  pluginName: string,
): void {
  if (!commandEnv) {
    return;
  }

  const hostOnlyRefs = new Set<string>();
  for (const value of Object.values(apiHeaders ?? {})) {
    for (const name of envReferences(value)) {
      hostOnlyRefs.add(name);
    }
  }
  if (credentials) {
    if (credentials.authTokenEnv) {
      hostOnlyRefs.add(credentials.authTokenEnv);
    }
  }
  if (oauth) {
    hostOnlyRefs.add(oauth.clientIdEnv);
    hostOnlyRefs.add(oauth.clientSecretEnv);
  }

  for (const [key, value] of Object.entries(commandEnv)) {
    for (const name of envReferences(value)) {
      if (hostOnlyRefs.has(name)) {
        throw new Error(
          `Plugin ${pluginName} command-env.${key} references env var ${name}, but credential/API header env vars must stay host-only`,
        );
      }
    }
  }
}

function assertCommandEnvHostRefsAreExplicitlyExposed(
  commandEnv: Record<string, string> | undefined,
  envVars: Record<string, PluginEnvVarDeclaration>,
  pluginName: string,
): void {
  if (!commandEnv) {
    return;
  }

  for (const [key, value] of Object.entries(commandEnv)) {
    for (const name of envReferences(value)) {
      const declaration = envVars[name] as PluginEnvVarDeclaration | undefined;
      if (
        declaration &&
        declaration.default === undefined &&
        declaration.exposeToCommandEnv !== true
      ) {
        throw new Error(
          `Plugin ${pluginName} command-env.${key} references env var ${name}, but env-vars.${name} must set expose-to-command-env: true before host env can be exposed to sandbox`,
        );
      }
    }
  }
}

function normalizeCredentials(
  data: Record<string, unknown>,
  name: string,
): PluginCredentials {
  if (data.type !== "oauth-bearer") {
    throw new Error(
      `Plugin ${name} has unsupported credentials.type: "${String(data.type)}"`,
    );
  }

  const result = oauthBearerCredentialsSchema.safeParse(data);
  if (!result.success) {
    throw new Error(issueMessage(result.error, `Plugin ${name} credentials`));
  }

  if (!result.data.domains) {
    throw new Error(`Plugin ${name} credentials requires domains`);
  }
  const domains = result.data.domains;

  const apiHeaders = result.data["api-headers"]
    ? normalizeStringMap(
        result.data["api-headers"],
        `Plugin ${name} credentials.api-headers`,
        { forbiddenKeys: FORBIDDEN_API_HEADER_NAMES },
      )
    : undefined;

  return {
    type: "oauth-bearer",
    domains,
    ...(apiHeaders ? { apiHeaders } : {}),
    authTokenEnv: result.data["auth-token-env"],
    ...(result.data["auth-token-placeholder"]
      ? { authTokenPlaceholder: result.data["auth-token-placeholder"] }
      : {}),
  } satisfies OAuthBearerCredentials;
}

function normalizeRuntimeDependencies(
  entries: unknown[],
  name: string,
): PluginRuntimeDependency[] | undefined {
  const parsed: PluginRuntimeDependency[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const result = runtimeDependencyEntrySchema.safeParse(entry);
    if (!result.success) {
      throw new Error(
        issueMessage(
          result.error,
          `Plugin ${name} runtime-dependencies entries`,
        ),
      );
    }

    const record = result.data;
    const packageName =
      typeof record.package === "string" ? record.package.trim() : "";
    const packageUrl = typeof record.url === "string" ? record.url.trim() : "";
    const version = record.version;
    const sha256 = record.sha256;

    if (record.type === "npm") {
      if (!packageName) {
        throw new Error(
          `Plugin ${name} runtime dependency package must be a non-empty string`,
        );
      }
      if (record.url !== undefined || sha256 !== undefined) {
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
      const dedupeKey = `${record.type}:${packageName}:${normalizedVersion}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      parsed.push({
        type: "npm",
        package: packageName,
        version: normalizedVersion,
      } satisfies PluginNpmRuntimeDependency);
      continue;
    }

    if (version !== undefined) {
      throw new Error(
        `Plugin ${name} system runtime dependencies must not include a version`,
      );
    }
    if (packageName && packageUrl) {
      throw new Error(
        `Plugin ${name} system runtime dependencies must specify either package or url, not both`,
      );
    }
    if (!packageName && !packageUrl) {
      throw new Error(
        `Plugin ${name} system runtime dependencies must specify package or url`,
      );
    }

    if (packageName) {
      if (sha256 !== undefined) {
        throw new Error(
          `Plugin ${name} system runtime dependency package entries must not include sha256`,
        );
      }
      const dedupeKey = `${record.type}:package:${packageName}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      parsed.push({
        type: "system",
        package: packageName,
      } satisfies PluginSystemRuntimeDependency);
      continue;
    }

    if (!/^https:\/\//i.test(packageUrl)) {
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

    const dedupeKey = `${record.type}:url:${packageUrl}:${normalizedSha256}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    parsed.push({
      type: "system",
      url: packageUrl,
      sha256: normalizedSha256,
    } satisfies PluginSystemRuntimeDependencyFromUrl);
  }

  return parsed.length > 0 ? parsed : undefined;
}

function normalizeRuntimePostinstall(
  commands: unknown[],
  name: string,
): PluginRuntimePostinstallCommand[] | undefined {
  const parsed: PluginRuntimePostinstallCommand[] = [];

  for (const command of commands) {
    const result = runtimePostinstallCommandSourceSchema.safeParse(command);
    if (!result.success) {
      throw new Error(
        issueMessage(result.error, `Plugin ${name} runtime-postinstall`),
      );
    }

    if (!RUNTIME_POSTINSTALL_CMD_RE.test(result.data.cmd)) {
      throw new Error(
        `Plugin ${name} runtime-postinstall cmd must be a single executable token (letters, digits, ., _, /, -)`,
      );
    }

    const normalizedArgs = result.data.args
      ?.map((arg) => arg.trim())
      .filter((arg) => arg.length > 0);

    parsed.push({
      cmd: result.data.cmd,
      ...(normalizedArgs && normalizedArgs.length > 0
        ? { args: normalizedArgs }
        : {}),
      ...(typeof result.data.sudo === "boolean"
        ? { sudo: result.data.sudo }
        : {}),
    });
  }

  return parsed.length > 0 ? parsed : undefined;
}

const envVarDeclarationSchema = z.preprocess(
  (value) => (value === null || value === undefined ? {} : value),
  z
    .object({
      default: z.string().optional(),
      "expose-to-command-env": z.boolean().optional(),
      exposeToCommandEnv: z.boolean().optional(),
    })
    .strict(),
);

function normalizeEnvVars(
  data: Record<string, unknown>,
  pluginName: string,
): Record<string, PluginEnvVarDeclaration> {
  const normalized: Record<string, PluginEnvVarDeclaration> = {};
  for (const [rawName, rawDecl] of Object.entries(data)) {
    const name = rawName.trim();
    if (!ENV_VAR_NAME_RE.test(name)) {
      throw new Error(
        `Plugin ${pluginName} env-vars key "${rawName}" must match [A-Z_][A-Z0-9_]*`,
      );
    }
    const parsed = envVarDeclarationSchema.safeParse(rawDecl);
    if (!parsed.success) {
      throw new Error(
        issueMessage(parsed.error, `Plugin ${pluginName} env-vars.${name}`),
      );
    }
    const decl: PluginEnvVarDeclaration = {};
    if (parsed.data.default !== undefined) {
      decl.default = parsed.data.default;
    }
    if (
      parsed.data["expose-to-command-env"] === true ||
      parsed.data.exposeToCommandEnv === true
    ) {
      decl.exposeToCommandEnv = true;
    }
    normalized[name] = decl;
  }
  return normalized;
}

/**
 * Expand `${NAME}` placeholders in a manifest string field using the plugin's
 * declared env-vars block. `NAME` must match `[A-Z_][A-Z0-9_]*` and must be
 * declared in the plugin's `env-vars` block — otherwise load fails. This
 * keeps the manifest's env-var surface explicit and auditable, and prevents
 * a plugin manifest from opportunistically exfiltrating ambient process env
 * vars via `mcp.url`. If `NAME` is declared without a default and
 * `process.env[NAME]` is unset, load also fails.
 */
function expandEnvPlaceholders(
  template: string,
  envVars: Record<string, PluginEnvVarDeclaration>,
  context: string,
): string {
  return template.replace(ENV_PLACEHOLDER_RE, (_match, name) => {
    const varName = name as string;
    if (!Object.prototype.hasOwnProperty.call(envVars, varName)) {
      throw new Error(
        `${context} references env var ${varName} which is not declared in env-vars`,
      );
    }
    const decl = envVars[varName] as PluginEnvVarDeclaration;
    const fromProcess = process.env[varName];
    if (fromProcess !== undefined && fromProcess !== "") {
      return fromProcess;
    }
    if (decl.default !== undefined) {
      return decl.default;
    }
    throw new Error(
      `${context} env var ${varName} is unset and has no default in env-vars`,
    );
  });
}

function normalizeMcp(
  data: Record<string, unknown>,
  envVars: Record<string, PluginEnvVarDeclaration>,
  name: string,
): PluginMcpConfig {
  const prepared: Record<string, unknown> = { ...data };
  if (typeof prepared.url === "string") {
    prepared.url = expandEnvPlaceholders(
      prepared.url,
      envVars,
      `Plugin ${name} mcp.url`,
    );
  }

  const result = mcpSourceSchema.safeParse(prepared);
  if (!result.success) {
    throw new Error(issueMessage(result.error, `Plugin ${name} mcp`));
  }

  const headers = result.data.headers
    ? normalizeStringMap(result.data.headers, `Plugin ${name} mcp.headers`, {
        forbiddenKeys: FORBIDDEN_API_HEADER_NAMES,
      })
    : undefined;

  return {
    transport: "http",
    url: result.data.url,
    ...(headers ? { headers } : {}),
    ...(result.data["allowed-tools"]
      ? { allowedTools: result.data["allowed-tools"] }
      : {}),
  } satisfies PluginMcpConfig;
}

function parseManifestSource(
  parsedSource: ManifestSource,
  dir: string,
  config?: PluginCatalogConfig,
  options?: ManifestParseOptions,
): PluginManifest {
  const source = applyManifestConfig(parsedSource, config);
  const sourceResult = manifestSourceSchema.safeParse(source);
  if (!sourceResult.success) {
    const issue = sourceResult.error.issues[0];
    const path = formatPath(issue?.path ?? []);
    if (path === "name") {
      throw new Error(`Invalid plugin name in ${dir}: "${parsedSource.name}"`);
    }
    if (path === "description") {
      throw new Error(`Invalid plugin description in ${dir}`);
    }
    if (path === "capabilities") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} capabilities must be an array when provided`,
      );
    }
    if (path === "config-keys") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} config-keys must be an array when provided`,
      );
    }
    if (path === "domains") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} ${path} must be a non-empty array of domains`,
      );
    }
    if (path === "api-headers") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} api-headers must be an object when provided`,
      );
    }
    if (path === "command-env") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} command-env must be an object when provided`,
      );
    }
    if (path === "credentials") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} credentials must be an object when provided`,
      );
    }
    if (path === "runtime-dependencies") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} runtime-dependencies must be an array`,
      );
    }
    if (path === "runtime-postinstall") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} runtime-postinstall must be an array`,
      );
    }
    if (path === "env-vars") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} env-vars must be an object`,
      );
    }
    if (path === "mcp") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} mcp must be an object`,
      );
    }
    if (path === "oauth") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} oauth must be an object`,
      );
    }
    if (path === "target") {
      throw new Error(
        `Plugin ${String(parsedSource.name ?? "unknown")} target must be an object`,
      );
    }
    throw new Error(issue?.message ?? `Invalid plugin manifest in ${dir}`);
  }

  const data = sourceResult.data;
  const capabilities = (data.capabilities ?? []).map((cap) => {
    if (!SHORT_CAPABILITY_RE.test(cap)) {
      throw new Error(
        `Invalid capability token "${cap}" in plugin ${data.name}`,
      );
    }
    return `${data.name}.${cap}`;
  });

  const configKeys = (data["config-keys"] ?? []).map((key) => {
    if (!SHORT_CONFIG_KEY_RE.test(key)) {
      throw new Error(`Invalid config key "${key}" in plugin ${data.name}`);
    }
    return `${data.name}.${key}`;
  });

  const envVars = data["env-vars"]
    ? normalizeEnvVars(data["env-vars"], data.name)
    : {};
  const apiHeaders = data["api-headers"]
    ? normalizeRequiredApiHeaders(
        data["api-headers"],
        `Plugin ${data.name} api-headers`,
        envVars,
      )
    : undefined;
  const domains = data.domains;
  if (apiHeaders && !domains) {
    throw new Error(`Plugin ${data.name} api-headers requires domains`);
  }
  if (
    domains &&
    !apiHeaders &&
    !data.credentials &&
    options?.allowHookManagedEgress !== true
  ) {
    throw new Error(
      `Plugin ${data.name} domains requires credentials or api-headers`,
    );
  }
  const commandEnv = data["command-env"]
    ? normalizeCommandEnv(
        data["command-env"],
        `Plugin ${data.name} command-env`,
        envVars,
      )
    : undefined;

  const credentials = data.credentials
    ? normalizeCredentials(data.credentials, data.name)
    : undefined;
  const runtimeDependencies = data["runtime-dependencies"]
    ? normalizeRuntimeDependencies(data["runtime-dependencies"], data.name)
    : undefined;
  const runtimePostinstall = data["runtime-postinstall"]
    ? normalizeRuntimePostinstall(data["runtime-postinstall"], data.name)
    : undefined;
  const mcp = data.mcp ? normalizeMcp(data.mcp, envVars, data.name) : undefined;

  const manifest: PluginManifest = {
    name: data.name,
    description: data.description,
    capabilities,
    configKeys,
    ...(domains ? { domains } : {}),
    ...(apiHeaders ? { apiHeaders } : {}),
    ...(commandEnv ? { commandEnv } : {}),
    ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
    ...(credentials ? { credentials } : {}),
    ...(runtimeDependencies ? { runtimeDependencies } : {}),
    ...(runtimePostinstall ? { runtimePostinstall } : {}),
    ...(mcp ? { mcp } : {}),
  };

  if (data.oauth) {
    if (!credentials && options?.allowHookManagedEgress !== true) {
      throw new Error(`Plugin ${data.name} oauth requires credentials`);
    }

    const result = oauthSourceSchema.safeParse(data.oauth);
    if (!result.success) {
      throw new Error(issueMessage(result.error, `Plugin ${data.name} oauth`));
    }

    const authorizeParams = result.data["authorize-params"]
      ? normalizeStringMap(
          result.data["authorize-params"],
          `Plugin ${data.name} oauth.authorize-params`,
          {
            reservedKeys: RESERVED_AUTHORIZE_PARAM_KEYS,
          },
        )
      : undefined;
    const tokenExtraHeaders = result.data["token-extra-headers"]
      ? normalizeStringMap(
          result.data["token-extra-headers"],
          `Plugin ${data.name} oauth.token-extra-headers`,
          {
            forbiddenKeys: FORBIDDEN_TOKEN_HEADER_NAMES,
          },
        )
      : undefined;

    manifest.oauth = {
      clientIdEnv: result.data["client-id-env"],
      clientSecretEnv: result.data["client-secret-env"],
      authorizeEndpoint: result.data["authorize-endpoint"],
      tokenEndpoint: result.data["token-endpoint"],
      ...(result.data.scope ? { scope: result.data.scope } : {}),
      ...(authorizeParams ? { authorizeParams } : {}),
      ...(result.data["token-auth-method"]
        ? { tokenAuthMethod: result.data["token-auth-method"] }
        : {}),
      ...(tokenExtraHeaders ? { tokenExtraHeaders } : {}),
      ...(result.data["treat-empty-scope-as-unreported"]
        ? { treatEmptyScopeAsUnreported: true }
        : {}),
    };
  }

  assertCommandEnvDoesNotExposeHostSecretRefs(
    data["command-env"],
    apiHeaders,
    credentials,
    manifest.oauth,
    data.name,
  );
  assertCommandEnvHostRefsAreExplicitlyExposed(
    data["command-env"],
    envVars,
    data.name,
  );

  if (data.target) {
    const result = targetSourceSchema.safeParse(data.target);
    if (!result.success) {
      throw new Error(issueMessage(result.error, `Plugin ${data.name} target`));
    }
    if (!SHORT_CONFIG_KEY_RE.test(result.data["config-key"])) {
      throw new Error(
        `Plugin ${data.name} target.config-key "${result.data["config-key"]}" is invalid`,
      );
    }
    const qualifiedKey = `${data.name}.${result.data["config-key"]}`;
    if (!configKeys.includes(qualifiedKey)) {
      throw new Error(
        `Plugin ${data.name} target.config-key "${result.data["config-key"]}" must be listed in config-keys`,
      );
    }
    const commandFlags = result.data["command-flags"];
    if (
      commandFlags &&
      commandFlags.some((flag) => !TARGET_FLAG_RE.test(flag))
    ) {
      throw new Error(
        `Plugin ${data.name} target.command-flags must contain CLI flags like --repo or -R`,
      );
    }
    manifest.target = {
      type: result.data.type,
      configKey: qualifiedKey,
      ...(commandFlags ? { commandFlags } : {}),
    };
  }

  return manifest;
}

/** Parse one plugin.yaml manifest after applying install-level plugin config. */
export function parsePluginManifest(
  raw: string,
  dir: string,
  config?: PluginCatalogConfig,
): PluginManifest {
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(raw);
  } catch (error) {
    throw new Error(
      `Invalid plugin manifest in ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    !parsedYaml ||
    typeof parsedYaml !== "object" ||
    Array.isArray(parsedYaml)
  ) {
    throw new Error(`Invalid plugin manifest in ${dir}: expected an object`);
  }

  return parseManifestSource(parsedYaml as ManifestSource, dir, config);
}

/** Parse one inline JavaScript manifest through the same effective manifest pipeline as plugin.yaml. */
export function parseInlinePluginManifest(
  manifest: PluginManifest,
  dir: string,
  config?: PluginCatalogConfig,
): PluginManifest {
  return parseManifestSource(inlineManifestSource(manifest), dir, config, {
    allowHookManagedEgress: true,
  });
}
