/** Parsers for GitHub App installation API responses. */
import * as z from "zod";
import { readGrantPermissions } from "./permissions.js";

const installationTokenResponseSchema = z.object({
  expires_at: z.unknown().optional(),
  token: z.unknown().optional(),
});
const installationPermissionsSchema = z.object({
  permissions: z.record(z.string(), z.unknown()),
});

/** Read the token and its expiry from an installation token response. */
export function parseInstallationTokenResponse(value: unknown): {
  expiresAtMs: number;
  token: string;
} {
  const parsed = installationTokenResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("GitHub installation token response is invalid");
  }
  const data = parsed.data;
  const token = data["token"];
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("GitHub installation token response missing token");
  }
  const expiresAt = data["expires_at"];
  const expiresAtMs =
    typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error(
      "GitHub installation token response returned invalid expires_at",
    );
  }
  return { token, expiresAtMs };
}

/** Read the read permissions that an installation was granted. */
export function readInstallationPermissions(
  installation: unknown,
): Record<string, "read"> {
  const parsed = installationPermissionsSchema.safeParse(installation);
  if (!parsed.success) {
    throw new Error("GitHub installation response missing permissions");
  }
  return readGrantPermissions(parsed.data.permissions);
}
