import { z } from "zod";
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
    id: nonBlankStringSchema,
    label: nonBlankStringSchema.optional(),
    url: nonBlankStringSchema.optional(),
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

/** Runtime schema for a plugin-defined outbound credential grant. */
export const pluginGrantSchema = z
  .object({
    access: pluginGrantAccessSchema,
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
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "EgressPolicyDenied";
  }
}

/** Provider account identity resolved by a plugin OAuth hook. */
export type PluginProviderAccount = z.output<
  typeof pluginProviderAccountSchema
>;

/** Plugin-defined grant required before Junior can forward one outbound request. */
export type PluginGrant = z.output<typeof pluginGrantSchema>;

/** Request details available while selecting the grant for sandbox egress. */
export interface PluginEgressRequest {
  /** Capped request body text when the host exposes it for provider-specific grant classification. */
  bodyText?: string;
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
  request: Omit<PluginEgressRequest, "bodyText">;
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
}

export interface IssueCredentialHookContext extends PluginContext {
  actor: PluginCredentialActor;
  credentialSubject?: PluginResolvedCredentialUser;
  grant: PluginGrant;
  tokens: PluginTokenStore;
}
