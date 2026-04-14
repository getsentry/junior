import { z } from "zod";
import { parse as parseYaml } from "yaml";
import type {
  GitHubAppCredentials,
  PluginMcpConfig,
  OAuthBearerCredentials,
  PluginCredentials,
  PluginManifest,
  PluginNpmRuntimeDependency,
  PluginRuntimeDependency,
  PluginRuntimePostinstallCommand,
  PluginSystemRuntimeDependency,
  PluginSystemRuntimeDependencyFromUrl,
} from "./types";

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const SHORT_CAPABILITY_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const SHORT_CONFIG_KEY_RE = /^[a-z0-9]+(\.[a-z0-9-]+)*$/;
const TARGET_FLAG_RE = /^-{1,2}[A-Za-z0-9][A-Za-z0-9-]*$/;
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

    return Object.keys(result).length > 0 ? result : undefined;
  });

const apiDomainsSchema = z
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
    "api-domains": apiDomainsSchema,
    "api-headers": stringMapSchema.optional(),
    "auth-token-env": envVarString,
    "auth-token-placeholder": nonEmptyTrimmedString.optional(),
  })
  .passthrough();

const oauthBearerCredentialsSchema = baseCredentialsSchema.extend({
  type: z.literal("oauth-bearer"),
});

const githubAppCredentialsSchema = baseCredentialsSchema.extend({
  type: z.literal("github-app"),
  "app-id-env": envVarString,
  "private-key-env": envVarString,
  "installation-id-env": envVarString,
});

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

  for (const key of Object.keys(value)) {
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

function normalizeCredentials(
  data: Record<string, unknown>,
  name: string,
): PluginCredentials {
  const schema =
    data.type === "oauth-bearer"
      ? oauthBearerCredentialsSchema
      : data.type === "github-app"
        ? githubAppCredentialsSchema
        : undefined;

  if (!schema) {
    throw new Error(
      `Plugin ${name} has unsupported credentials.type: "${String(data.type)}"`,
    );
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(issueMessage(result.error, `Plugin ${name} credentials`));
  }

  if (result.data.type === "oauth-bearer") {
    return {
      type: "oauth-bearer",
      apiDomains: result.data["api-domains"],
      ...(result.data["api-headers"]
        ? {
            apiHeaders: normalizeStringMap(
              result.data["api-headers"],
              `Plugin ${name} credentials.api-headers`,
              { forbiddenKeys: FORBIDDEN_API_HEADER_NAMES },
            ),
          }
        : {}),
      authTokenEnv: result.data["auth-token-env"],
      ...(result.data["auth-token-placeholder"]
        ? { authTokenPlaceholder: result.data["auth-token-placeholder"] }
        : {}),
    } satisfies OAuthBearerCredentials;
  }

  return {
    type: "github-app",
    apiDomains: result.data["api-domains"],
    ...(result.data["api-headers"]
      ? {
          apiHeaders: normalizeStringMap(
            result.data["api-headers"],
            `Plugin ${name} credentials.api-headers`,
            { forbiddenKeys: FORBIDDEN_API_HEADER_NAMES },
          ),
        }
      : {}),
    authTokenEnv: result.data["auth-token-env"],
    ...(result.data["auth-token-placeholder"]
      ? { authTokenPlaceholder: result.data["auth-token-placeholder"] }
      : {}),
    appIdEnv: result.data["app-id-env"],
    privateKeyEnv: result.data["private-key-env"],
    installationIdEnv: result.data["installation-id-env"],
  } satisfies GitHubAppCredentials;
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

function normalizeMcp(
  data: Record<string, unknown>,
  name: string,
): PluginMcpConfig {
  const result = mcpSourceSchema.safeParse(data);
  if (!result.success) {
    throw new Error(issueMessage(result.error, `Plugin ${name} mcp`));
  }

  return {
    transport: "http",
    url: result.data.url,
    ...(result.data.headers
      ? {
          headers: normalizeStringMap(
            result.data.headers,
            `Plugin ${name} mcp.headers`,
            { forbiddenKeys: FORBIDDEN_API_HEADER_NAMES },
          ),
        }
      : {}),
    ...(result.data["allowed-tools"]
      ? { allowedTools: result.data["allowed-tools"] }
      : {}),
  } satisfies PluginMcpConfig;
}

export function parsePluginManifest(raw: string, dir: string): PluginManifest {
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

  const sourceResult = manifestSourceSchema.safeParse(parsedYaml);
  if (!sourceResult.success) {
    const issue = sourceResult.error.issues[0];
    const path = formatPath(issue?.path ?? []);
    if (path === "name") {
      throw new Error(
        `Invalid plugin name in ${dir}: "${(parsedYaml as { name?: unknown }).name}"`,
      );
    }
    if (path === "description") {
      throw new Error(`Invalid plugin description in ${dir}`);
    }
    if (path === "capabilities") {
      throw new Error(
        `Plugin ${(parsedYaml as { name?: string }).name ?? "unknown"} capabilities must be an array when provided`,
      );
    }
    if (path === "config-keys") {
      throw new Error(
        `Plugin ${(parsedYaml as { name?: string }).name ?? "unknown"} config-keys must be an array when provided`,
      );
    }
    if (path === "credentials") {
      throw new Error(
        `Plugin ${(parsedYaml as { name?: string }).name ?? "unknown"} credentials must be an object when provided`,
      );
    }
    if (path === "runtime-dependencies") {
      throw new Error(
        `Plugin ${(parsedYaml as { name?: string }).name ?? "unknown"} runtime-dependencies must be an array`,
      );
    }
    if (path === "runtime-postinstall") {
      throw new Error(
        `Plugin ${(parsedYaml as { name?: string }).name ?? "unknown"} runtime-postinstall must be an array`,
      );
    }
    if (path === "mcp") {
      throw new Error(
        `Plugin ${(parsedYaml as { name?: string }).name ?? "unknown"} mcp must be an object`,
      );
    }
    if (path === "oauth") {
      throw new Error(
        `Plugin ${(parsedYaml as { name?: string }).name ?? "unknown"} oauth must be an object`,
      );
    }
    if (path === "target") {
      throw new Error(
        `Plugin ${(parsedYaml as { name?: string }).name ?? "unknown"} target must be an object`,
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

  const credentials = data.credentials
    ? normalizeCredentials(data.credentials, data.name)
    : undefined;
  const runtimeDependencies = data["runtime-dependencies"]
    ? normalizeRuntimeDependencies(data["runtime-dependencies"], data.name)
    : undefined;
  const runtimePostinstall = data["runtime-postinstall"]
    ? normalizeRuntimePostinstall(data["runtime-postinstall"], data.name)
    : undefined;
  const mcp = data.mcp ? normalizeMcp(data.mcp, data.name) : undefined;

  const manifest: PluginManifest = {
    name: data.name,
    description: data.description,
    capabilities,
    configKeys,
    ...(credentials ? { credentials } : {}),
    ...(runtimeDependencies ? { runtimeDependencies } : {}),
    ...(runtimePostinstall ? { runtimePostinstall } : {}),
    ...(mcp ? { mcp } : {}),
  };

  if (data.oauth) {
    if (!credentials) {
      throw new Error(`Plugin ${data.name} oauth requires credentials`);
    }
    if (credentials.type !== "oauth-bearer") {
      throw new Error(
        `Plugin ${data.name} oauth requires credentials.type "oauth-bearer"`,
      );
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
    };
  }

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
