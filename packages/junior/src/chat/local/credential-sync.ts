import { createHmac, timingSafeEqual } from "node:crypto";
import {
  pluginStoredTokensSchema,
  type PluginStoredTokens,
} from "@sentry/junior-plugin-api";
import { createUserTokenStore } from "@/chat/capabilities/factory";

const LOCAL_CREDENTIAL_SYNC_CONTEXT = "junior.local-credential-sync.v1";
const LOCAL_CREDENTIAL_SYNC_MAX_AGE_MS = 60_000;

interface LocalCredentialSyncPayload {
  createdAtMs: number;
  provider: string;
  tokens: PluginStoredTokens;
  userId: string;
}

function syncSecret(): string {
  const secret = process.env.JUNIOR_SECRET?.trim();
  if (!secret) {
    throw new Error("Local credential sync requires JUNIOR_SECRET");
  }
  return secret;
}

function signature(body: string): string {
  return createHmac("sha256", syncSecret())
    .update(`${LOCAL_CREDENTIAL_SYNC_CONTEXT}:${body}`)
    .digest("base64url");
}

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
  userId: string,
  tokens: PluginStoredTokens,
): Promise<void> {
  const body = JSON.stringify({
    createdAtMs: Date.now(),
    provider,
    tokens,
    userId,
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const payload = value as Partial<LocalCredentialSyncPayload>;
  const tokens = pluginStoredTokensSchema.safeParse(payload.tokens);
  if (
    typeof payload.createdAtMs !== "number" ||
    Math.abs(Date.now() - payload.createdAtMs) >
      LOCAL_CREDENTIAL_SYNC_MAX_AGE_MS ||
    typeof payload.provider !== "string" ||
    !payload.provider.trim() ||
    typeof payload.userId !== "string" ||
    !payload.userId.trim() ||
    !tokens.success
  ) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  await createUserTokenStore().set(
    payload.userId,
    payload.provider,
    tokens.data,
  );
  return new Response(null, { status: 204 });
}
