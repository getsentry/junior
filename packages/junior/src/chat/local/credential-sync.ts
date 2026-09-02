import { createHmac, createSecretKey, timingSafeEqual } from "node:crypto";
import {
  pluginStoredTokensSchema,
  type PluginStoredTokens,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import {
  createInstallationTokenStore,
  createUserTokenStore,
} from "@/chat/capabilities/factory";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";

const LOCAL_CREDENTIAL_SYNC_CONTEXT = "junior.local-credential-sync.v1";
const LOCAL_CREDENTIAL_SYNC_MAX_AGE_MS = 60_000;

const localCredentialSyncSchema = z
  .object({
    createdAtMs: z.number().finite(),
    provider: z.string().regex(/^[a-z][a-z0-9-]*$/),
    tokens: pluginStoredTokensSchema,
  })
  .strict();

type LocalCredentialSyncPayload = z.infer<typeof localCredentialSyncSchema>;

function syncSecret(): string {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (!secret) {
    throw new Error("Local credential sync requires JUNIOR_SECRET");
  }
  return secret;
}

/** Sign one local credential payload in its own HMAC domain. */
function signature(body: string): string {
  const signingKey = createSecretKey(Buffer.from(syncSecret(), "utf8"));
  return createHmac("sha256", signingKey)
    .update(`${LOCAL_CREDENTIAL_SYNC_CONTEXT}:${body}`)
    .digest("base64url");
}

/** Compare credential signatures without leaking a matching prefix by timing. */
function signaturesMatch(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

/** Copy a local user's provider credential to the loopback dev-server broker. */
export async function syncLocalOAuthCredential(
  provider: string,
  tokens: PluginStoredTokens,
): Promise<void> {
  const body = JSON.stringify({
    createdAtMs: Date.now(),
    provider,
    tokens,
  } satisfies LocalCredentialSyncPayload);
  const port = process.env.PORT?.trim() || "3000";
  const response = await fetch(
    `http://127.0.0.1:${port}/api/internal/local-oauth-credentials`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-junior-local-credential-signature": signature(body),
      },
      body,
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not sync local OAuth credential: HTTP ${response.status}`,
    );
  }
}

/** Verify and store one credential sent by the local CLI over loopback. */
export async function receiveLocalOAuthCredential(
  request: Request,
): Promise<Response> {
  const hostname = new URL(request.url).hostname;
  if (
    process.env.NODE_ENV !== "development" ||
    (hostname !== "127.0.0.1" && hostname !== "localhost")
  ) {
    return new Response(null, { status: 404 });
  }
  const body = await request.text();
  const actualSignature = request.headers.get(
    "x-junior-local-credential-signature",
  );
  if (!actualSignature || !signaturesMatch(signature(body), actualSignature)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const payload = localCredentialSyncSchema.safeParse(value);
  if (
    !payload.success ||
    Math.abs(Date.now() - payload.data.createdAtMs) >
      LOCAL_CREDENTIAL_SYNC_MAX_AGE_MS
  ) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const provider = payload.data.provider;
  if (
    pluginCatalogRuntime.getOAuthConfig(provider)?.tokenSubject ===
    "installation"
  ) {
    await createInstallationTokenStore().set(provider, payload.data.tokens);
  } else {
    await createUserTokenStore().set(
      "local-cli",
      provider,
      payload.data.tokens,
    );
  }
  return new Response(null, { status: 204 });
}
