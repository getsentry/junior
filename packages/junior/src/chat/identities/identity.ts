/**
 * Provider of the native Google identity. Core links it through Google
 * sign-in. Its tenant is empty and its subject is the Google OIDC `sub`.
 */
export const GOOGLE_IDENTITY_PROVIDER = "google";

const NATIVE_IDENTITY_PROVIDERS = new Set(["slack", GOOGLE_IDENTITY_PROVIDER]);

/**
 * Return whether only core may link identities for this provider. Plugin
 * OAuth accounts must not link under these names, because other checks trust
 * them.
 */
export function isNativeIdentityProvider(provider: string): boolean {
  return NATIVE_IDENTITY_PROVIDERS.has(provider);
}

export type IdentityKind = "service" | "system" | "user";

export interface IdentityUpsert {
  /**
   * Profile photo URL from the provider. Omit it to keep the saved photo. Null
   * clears it, for example when the person removes their photo.
   */
  avatarUrl?: string | null;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
  handle?: string;
  kind: IdentityKind;
  metadata?: Record<string, unknown>;
  provider: string;
  providerSubjectId: string;
  providerTenantId?: string;
}

export interface StoredIdentity {
  id: string;
  userId?: string;
}

/** Canonicalize email addresses for identity lookup and linking. */
export function normalizeIdentityEmail(
  email: string | undefined,
): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}
