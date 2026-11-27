// Junior config: the composed schema, env reading, and `loadConfig`. Each
// group's schema, env reading, and derive logic live in its own file here.
// Only `loadConfig` reads signing and encryption secrets, from the env that it
// receives, so `src/config/` shows what code can touch keys (see
// `policies/security.md`). `ast-grep/rules/no-secret-env-reads.yml` blocks
// `process.env` reads of them everywhere.
import * as z from "zod";
import {
  attachmentStorageEnvNames,
  attachmentStorageSchema,
  readAttachmentStorage,
} from "@/config/attachments";
import {
  botEnvNames,
  botSchema,
  deriveBot,
  limitsSchema,
  readBotEnv,
} from "@/config/bot";
import { configDefaultsSchema } from "@/config/config-defaults";
import { dashboardSchema } from "@/config/dashboard";
import {
  deploymentSchema,
  deriveDeployment,
  readDeploymentEnv,
} from "@/config/deployment";
import {
  ENCRYPTION_KEYS_HINT,
  encryptionEnvNames,
  encryptionSchema,
  readEncryption,
} from "@/config/encryption";
import { developmentSchema, readDevelopmentEnv } from "@/config/development";
import { eventEmbeddingsSchema } from "@/config/event-embeddings";
import { experimentalSchema } from "@/config/experimental";
import type { Env } from "@/config/fields";
import {
  functionMaxDurationSecondsSchema,
  resolveConversationWorkSoftYieldAfterMs,
} from "@/config/function-duration";
import {
  killSwitchEnvNames,
  killSwitchFields,
  readKillSwitchesEnv,
} from "@/config/kill-switches";
import { memorySchema, readMemoryEnv } from "@/config/memory";
import { queueEnvNames, queueSchema, readQueueEnv } from "@/config/queue";
import {
  readSandboxEnv,
  sandboxEnvNames,
  sandboxSchema,
} from "@/config/sandbox";
import { readSecretsEnv, secretsSchema } from "@/config/secrets";
import { readSignInEnv, signInSchema } from "@/config/sign-in";
import { readSkillsEnv, skillsSchema } from "@/config/skills";
import { readSlackEnv, slackEnvNames, slackSchema } from "@/config/slack";
import { deriveSql, readSqlEnv, sqlEnvNames, sqlSchema } from "@/config/sql";
import { readStateEnv, stateEnvNames, stateSchema } from "@/config/state";
import { deriveTrust, trustSchema } from "@/config/trust";
import { readWebPushEnv, webPushSchema } from "@/config/web-push";

const configObjectSchema = z.strictObject({
  /** Object storage for attachments and public artifacts. */
  attachmentStorage: attachmentStorageSchema.default({
    provider: "vercel-blob",
  }),
  bot: botSchema.prefault({}),
  configDefaults: configDefaultsSchema,
  dashboard: dashboardSchema,
  deployment: deploymentSchema,
  development: developmentSchema,
  eventEmbeddings: eventEmbeddingsSchema,
  experimental: experimentalSchema,
  memory: memorySchema,
  queue: queueSchema,
  functionMaxDurationSeconds: functionMaxDurationSecondsSchema,
  limits: limitsSchema.optional(),
  ...killSwitchFields,
  encryption: encryptionSchema,
  secrets: secretsSchema,
  signIn: signInSchema,
  webPush: webPushSchema,
  sql: sqlSchema,
  slack: slackSchema,
  sandbox: sandboxSchema,
  skills: skillsSchema,
  state: stateSchema,
  trust: trustSchema,
});

const configSchema = configObjectSchema.transform(derive);

function derive({
  limits = {},
  ...config
}: z.output<typeof configObjectSchema>) {
  const { bot, deployment, functionMaxDurationSeconds, signIn, sql, trust } =
    config;
  return {
    ...config,
    bot: deriveBot(bot, limits, functionMaxDurationSeconds),
    deployment: deriveDeployment(deployment),
    conversationWorkSoftYieldAfterMs: resolveConversationWorkSoftYieldAfterMs(
      functionMaxDurationSeconds,
    ),
    sql: deriveSql(sql),
    trust: deriveTrust(trust, signIn.allowedDomains),
  };
}

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/** Fully resolved Junior config. */
export type JuniorConfig = z.output<typeof configSchema>;
/** Config values a host passes in code. Unset values come from env, then defaults. */
export type ConfigInput = DeepPartial<z.input<typeof configSchema>>;
/** Object storage for attachments and public artifacts. */
export type AttachmentStorageConfig = JuniorConfig["attachmentStorage"];
/** Settings for an S3-compatible object store. */
export type S3StorageConfig = Extract<
  AttachmentStorageConfig,
  { provider: "s3" }
>["s3"];
/** Encryption keys as plain data. */
export type EncryptionConfig = JuniorConfig["encryption"];

/** Env var that sets each config field, for error messages. */
const ENV_NAMES: Record<string, string> = {
  ...botEnvNames,
  ...attachmentStorageEnvNames,
  ...queueEnvNames,
  ...killSwitchEnvNames,
  ...encryptionEnvNames,
  ...sqlEnvNames,
  ...slackEnvNames,
  ...sandboxEnvNames,
  ...stateEnvNames,
};

// Maps env vars onto config fields and parses their strings. Errors name the
// env var. Groups read in this order, so the first error is the same one.
function readEnv(env: Env): ConfigInput {
  return {
    attachmentStorage: readAttachmentStorage(env),
    bot: readBotEnv(env),
    deployment: readDeploymentEnv(env),
    development: readDevelopmentEnv(env),
    memory: readMemoryEnv(env),
    queue: readQueueEnv(env),
    ...readKillSwitchesEnv(env),
    encryption: readEncryption(env),
    secrets: readSecretsEnv(env),
    signIn: readSignInEnv(env),
    webPush: readWebPushEnv(env),
    sql: readSqlEnv(env),
    slack: readSlackEnv(env),
    sandbox: readSandboxEnv(env),
    skills: readSkillsEnv(env),
    state: readStateEnv(env),
  };
}

// Plain objects only: arrays, Buffers, and class instances are values.
const plainObjectSchema = z.record(z.string(), z.unknown());

// `b` wins. Plain objects merge per key, arrays and scalars replace, and
// undefined values are skipped. An object that names another `provider` is
// another union variant, so it replaces the object in `a`.
function mergeConfig(a: unknown, b: unknown): unknown {
  if (b === undefined) {
    return a;
  }
  const left = plainObjectSchema.safeParse(a);
  const right = plainObjectSchema.safeParse(b);
  if (
    !left.success ||
    !right.success ||
    (right.data["provider"] !== undefined &&
      right.data["provider"] !== left.data["provider"])
  ) {
    return b;
  }
  const merged: Record<string, unknown> = {};
  for (const key of new Set([
    ...Object.keys(left.data),
    ...Object.keys(right.data),
  ])) {
    const value = mergeConfig(left.data[key], right.data[key]);
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const key of path) {
    const object = plainObjectSchema.safeParse(value);
    if (!object.success || typeof key === "symbol") {
      return undefined;
    }
    value = object.data[String(key)];
  }
  return value;
}

// The env var of the field, or of its nearest group that has one.
function envNameFor(path: readonly PropertyKey[]): string | undefined {
  const keys = path.filter((key) => typeof key === "string");
  for (let length = keys.length; length > 0; length--) {
    const envName = ENV_NAMES[keys.slice(0, length).join(".")];
    if (envName) {
      return envName;
    }
  }
  return undefined;
}

function formatIssue(input: unknown, issue: z.core.$ZodIssue): string {
  if (issue.code === "custom" && issue.params?.["option"] === true) {
    return issue.message;
  }
  const path = issue.path.map(String).join(".");
  const envName = envNameFor(issue.path);
  if (
    issue.code === "invalid_type" &&
    valueAt(input, issue.path) === undefined
  ) {
    const required = `${envName ?? path} is required`;
    return path === "encryption"
      ? `${required}. ${ENCRYPTION_KEYS_HINT}`
      : required;
  }
  return `${envName ? `${path} (${envName})` : path}: ${issue.message}`;
}

/** Resolve config: host options win over env, and the schema fills defaults. */
export function loadConfig({
  env = {},
  options = {},
}: { env?: Env; options?: ConfigInput } = {}): JuniorConfig {
  const input = mergeConfig(readEnv(env), options);
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      result.error.issues.map((issue) => formatIssue(input, issue)).join("; "),
    );
  }
  return result.data;
}
