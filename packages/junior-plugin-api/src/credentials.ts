import * as z from "zod";
import type { PluginContext } from "./context";
import { nonBlankStringSchema, pluginCredentialSubjectSchema } from "./schemas";

const pluginProviderNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
const pluginGrantNameSchema = z.string().regex(/^[a-z][a-z0-9.-]*$/);
const pluginGrantAccessSchema = z.union([
  z.literal("read"),
  z.literal("write"),
]);

/** Runtime schema for provider authorization a plugin may request. */
export const pluginAuthorizationSchema = z
  .object({
    provider: pluginProviderNameSchema,
    scope: nonBlankStringSchema.optional(),
    type: z.literal("oauth"),
  })
  .strict();

/** Runtime schema for a provider account attached to stored OAuth tokens. */
export const pluginProviderAccountSchema = z
  .object({
    displayName: nonBlankStringSchema.optional(),
    handle: nonBlankStringSchema.optional(),
    id: nonBlankStringSchema,
    label: nonBlankStringSchema.optional(),
    url: nonBlankStringSchema.optional(),
    /**
     * Email addresses that the provider verified for this account. Junior
     * uses them only to link the account to a person and does not store them
     * with the tokens.
     */
    verifiedEmails: z.array(nonBlankStringSchema).optional(),
  })
  .strict();

/** Runtime schema for OAuth tokens stored by the host for plugin credentials. */
export const pluginStoredTokensSchema = z
  .object({
    account: pluginProviderAccountSchema.optional(),
    accessToken: nonBlankStringSchema,
    expiresAt: z.number().finite().optional(),
    refreshToken: nonBlankStringSchema,
    refreshTokenExpiresAt: z.number().finite().optional(),
    scope: nonBlankStringSchema.optional(),
  })
  .strict();

/**
 * Provider facts for egress audit events, such as the target repository.
 * Keys use the plugin's `app.<provider>.*` names. Telemetry only.
 */
export const pluginAuditAttributesSchema = z.record(
  z.string().regex(/^app\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$/),
  z.union([z.string(), z.boolean(), z.array(z.string())]),
);

/** Runtime schema for a plugin-defined outbound credential grant. */
export const pluginGrantSchema = z
  .object({
    access: pluginGrantAccessSchema,
    /** Provider facts for the write audit event. */
    auditAttributes: pluginAuditAttributesSchema.optional(),
    leaseScope: nonBlankStringSchema.optional(),
    name: pluginGrantNameSchema,
    reason: nonBlankStringSchema.optional(),
    requirements: z.array(nonBlankStringSchema).min(1).optional(),
  })
  .strict();

/** Runtime schema for plugin-issued header mutations. */
export const pluginCredentialHeaderTransformSchema = z
  .object({
    domain: z.string().min(1),
    headers: z
      .record(z.string(), z.string())
      .refine((headers) => Object.keys(headers).length > 0),
  })
  .strict();

/** Runtime schema for a short-lived plugin-issued credential lease. */
export const pluginCredentialLeaseSchema = z
  .object({
    account: pluginProviderAccountSchema.optional(),
    authorization: pluginAuthorizationSchema.optional(),
    expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    headerTransforms: z.array(pluginCredentialHeaderTransformSchema).min(1),
  })
  .strict();

/** Runtime schema for the result returned by a plugin credential hook. */
export const pluginCredentialResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      lease: pluginCredentialLeaseSchema,
      type: z.literal("lease"),
    })
    .strict(),
  z
    .object({
      authorization: pluginAuthorizationSchema.optional(),
      message: nonBlankStringSchema,
      type: z.literal("needed"),
    })
    .strict(),
  z
    .object({
      message: nonBlankStringSchema,
      type: z.literal("unavailable"),
    })
    .strict(),
]);

export type PluginCredentialSubject = z.output<
  typeof pluginCredentialSubjectSchema
>;

export type PluginGrantAccess = z.output<typeof pluginGrantAccessSchema>;

/** Provider authorization Junior can start when a plugin-owned grant is missing. */
export type PluginAuthorization = z.output<typeof pluginAuthorizationSchema>;

/** Interrupt sandbox egress so Junior can start provider authorization. */
export class EgressAuthRequired extends Error {
  authorization?: PluginAuthorization;

  constructor(
    message: string,
    options?: {
      authorization?: PluginAuthorization;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "EgressAuthRequired";
    this.authorization = options?.authorization;
  }
}

/** Deny provider egress before Junior issues credentials for a disallowed operation. */
export class EgressPolicyDenied extends Error {
  /** Provider facts for the policy denial event. */
  readonly auditAttributes?: PluginAuditAttributes;

  constructor(
    message: string,
    options?: { auditAttributes?: PluginAuditAttributes; cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.name = "EgressPolicyDenied";
    if (options?.auditAttributes) {
      this.auditAttributes = options.auditAttributes;
    }
  }
}

/** Provider facts for egress audit events. */
export type PluginAuditAttributes = z.output<
  typeof pluginAuditAttributesSchema
>;

/** Provider account identity resolved by a plugin OAuth hook. */
export type PluginProviderAccount = z.output<
  typeof pluginProviderAccountSchema
>;

/** Plugin-defined grant required before Junior can forward one outbound request. */
export type PluginGrant = z.output<typeof pluginGrantSchema>;

/** One ref update command in a Git push. */
export interface PluginGitRefUpdate {
  /** True when the push deletes the ref: its new object id is all zeros. */
  deletes: boolean;
  /** Full ref name, such as `refs/heads/main`. */
  ref: string;
}

/** Why the host could not read the ref updates of a Git push. */
export type PluginGitPushUnreadableReason =
  | "gzip"
  | "malformed"
  | "signed"
  | "unterminated";

/**
 * Ref updates of a Git smart HTTP push (`git-receive-pack`), which the host
 * reads from the body before the pack data. An `unreadable` push changes
 * refs that the host cannot name.
 */
export type PluginGitPush =
  | { kind: "commands"; updates: PluginGitRefUpdate[] }
  | { kind: "unreadable"; reason: PluginGitPushUnreadableReason };

/** One field that a GraphQL operation selects. */
export interface PluginGraphqlField {
  /** Names of the arguments that the field passes. */
  arguments: string[];
  /** Schema field name. An alias does not replace it. */
  name: string;
}

/** The GraphQL operation that one request runs. */
export interface PluginGraphqlOperation {
  /**
   * Each distinct field that the operation selects at any depth, also through
   * fragments.
   */
  fields: PluginGraphqlField[];
  name?: string;
  /**
   * Field names at the operation root, also through fragments. There is one
   * entry for each field selection, so an aliased repeat shows twice.
   */
  rootFields: string[];
  type: "mutation" | "query" | "subscription";
}

/**
 * Why the host could not read the operation of a GraphQL request:
 *
 * - `document`: the query does not parse, or it spreads a fragment that it
 *   does not define.
 * - `gzip`: the body is compressed.
 * - `json`: the body is not a JSON object or a JSON array of objects.
 * - `operation`: `operationName` names no operation, or the document has more
 *   than one operation and no `operationName`.
 * - `query`: the body has no `query` string, such as a persisted query hash.
 * - `too-large`: the body is larger than the host reads before it issues
 *   credentials.
 */
export type PluginGraphqlUnreadableReason =
  | "document"
  | "gzip"
  | "json"
  | "operation"
  | "query"
  | "too-large";

/**
 * The operations of a GraphQL POST, which the host reads from the JSON body.
 * A `batch` is a JSON array of requests. An `unreadable` request can run any
 * operation, mutations included.
 */
export type PluginGraphqlRequest =
  | { kind: "batch"; operations: PluginGraphqlOperation[] }
  | { kind: "operation"; operation: PluginGraphqlOperation }
  | { kind: "unreadable"; reason: PluginGraphqlUnreadableReason };

/** Request details available while selecting the grant for sandbox egress. */
export interface PluginEgressRequest {
  /**
   * Capped request body text when the host exposes it for provider-specific
   * grant classification.
   */
  bodyText?: string;
  /** Set for every Git `git-receive-pack` POST. */
  gitPush?: PluginGitPush;
  /** Set for every POST to a URL path that ends in `/graphql`. */
  graphql?: PluginGraphqlRequest;
  method: string;
  /** Plugin-declared operation this request performs, used for grant classification and diagnostics. */
  operation?: string;
  url: string;
}

export interface EgressHookContext extends PluginContext {
  request: PluginEgressRequest;
}

export interface PluginEgressResponse {
  /** Snapshot of upstream response headers; mutations do not affect pass-through. */
  headers: Headers;
  readText(maxBytes: number): Promise<string | undefined>;
  status: number;
}

export interface EgressResponseHookContext extends PluginContext {
  grant: PluginGrant;
  permissionDenied(message: string): void;
  request: Omit<PluginEgressRequest, "bodyText" | "gitPush" | "graphql">;
  response: PluginEgressResponse;
}

/** Header mutations a plugin-issued credential lease may apply to owned domains. */
export type PluginCredentialHeaderTransform = z.output<
  typeof pluginCredentialHeaderTransformSchema
>;

/** Short-lived credential headers issued by a plugin for a selected grant. */
export type PluginCredentialLease = z.output<
  typeof pluginCredentialLeaseSchema
>;

export type PluginCredentialResult = z.output<
  typeof pluginCredentialResultSchema
>;

export type PluginCredentialActor =
  | {
      platform: "system";
      name: string;
    }
  | {
      type: "user";
      userId: string;
    };

export interface PluginResolvedCredentialUser {
  type: "user";
  userId: string;
}

export type PluginStoredTokens = z.output<typeof pluginStoredTokensSchema>;

export interface PluginUserTokenSlot {
  get(): Promise<PluginStoredTokens | undefined>;
  set(tokens: PluginStoredTokens): Promise<void>;
  /** Run token refresh work after the host has serialized this user/provider slot, or throw after a bounded wait. */
  withRefresh<T>(callback: () => Promise<T>): Promise<T>;
  userId: string;
}

export interface PluginTokenStore {
  credentialSubject?: PluginUserTokenSlot;
  currentUser?: PluginUserTokenSlot;
}

export interface ResolveOAuthAccountHookContext extends PluginContext {
  tokens: PluginStoredTokens;
  /**
   * Parsed JSON body of the provider token response. Some providers return
   * the authorized account in this body.
   */
  tokenResponse: Record<string, unknown>;
}

export interface IssueCredentialHookContext extends PluginContext {
  actor: PluginCredentialActor;
  credentialSubject?: PluginResolvedCredentialUser;
  grant: PluginGrant;
  tokens: PluginTokenStore;
}
