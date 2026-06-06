import { normalizeOAuthScope } from "@/chat/credentials/oauth-scope";

const DEFAULT_TOKEN_CONTENT_TYPE = "application/x-www-form-urlencoded";

type OAuthTokenRequestInput = {
  clientId: string;
  clientSecret: string;
  payload: Record<string, string>;
  tokenAuthMethod?: "body" | "basic";
  tokenExtraHeaders?: Record<string, string>;
};

function requireNonEmptyTokenField(
  data: Record<string, unknown>,
  field: "access_token" | "refresh_token",
): string {
  const value = data[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`OAuth token response missing ${field}`);
  }
  return value;
}

function contentTypeToBody(
  contentType: string,
  payload: Record<string, string>,
): BodyInit {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType || mediaType === DEFAULT_TOKEN_CONTENT_TYPE) {
    return new URLSearchParams(payload);
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    return JSON.stringify(payload);
  }
  throw new Error(`Unsupported OAuth token Content-Type: ${contentType}`);
}

export function buildOAuthTokenRequest(input: OAuthTokenRequestInput): {
  headers: Record<string, string>;
  body: BodyInit;
} {
  const headers = new Headers({ Accept: "application/json" });
  for (const [name, value] of Object.entries(input.tokenExtraHeaders ?? {})) {
    headers.set(name, value);
  }
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", DEFAULT_TOKEN_CONTENT_TYPE);
  }

  const payload = { ...input.payload };
  if (input.tokenAuthMethod === "basic") {
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
    );
  } else {
    payload.client_id = input.clientId;
    payload.client_secret = input.clientSecret;
  }

  const contentType = headers.get("Content-Type") ?? DEFAULT_TOKEN_CONTENT_TYPE;
  const serializedHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    serializedHeaders[key] = value;
  });
  return {
    headers: serializedHeaders,
    body: contentTypeToBody(contentType, payload),
  };
}

export function parseOAuthTokenResponse(
  data: Record<string, unknown>,
  fallbackScope?: string,
): {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  scope?: string;
} {
  const accessToken = requireNonEmptyTokenField(data, "access_token");
  const refreshToken = requireNonEmptyTokenField(data, "refresh_token");
  const expiresIn = data.expires_in;
  const responseScope = data.scope;
  let scope: string | undefined;

  if (responseScope !== undefined) {
    if (typeof responseScope !== "string" || !responseScope.trim()) {
      throw new Error("OAuth token response returned invalid scope");
    }
    scope = normalizeOAuthScope(responseScope);
  } else {
    scope = normalizeOAuthScope(fallbackScope);
  }

  if (expiresIn === undefined) {
    return { accessToken, refreshToken, ...(scope ? { scope } : {}) };
  }
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error("OAuth token response returned invalid expires_in");
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    ...(scope ? { scope } : {}),
  };
}
