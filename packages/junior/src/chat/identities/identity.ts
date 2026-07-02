export type IdentityKind = "service" | "system" | "user";

export interface IdentityUpsert {
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
