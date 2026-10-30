/**
 * Own the OAuth token endpoint. It accepts public clients only, so a request
 * names its `client_id` and carries no client secret. Every response uses
 * `Cache-Control: no-store`.
 */
import {
  exchangeAuthorizationCode,
  refreshGrant,
  type McpTokenResult,
} from "./grants";
import type { McpState } from "./state";

const TOKEN_HEADERS = { "cache-control": "no-store", pragma: "no-cache" };

function tokenError(error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status: 400, headers: TOKEN_HEADERS },
  );
}

function tokenResponse(result: McpTokenResult): Response {
  return result.ok
    ? Response.json(result.tokens, { headers: TOKEN_HEADERS })
    : tokenError(result.error, result.description);
}

/** Handle `POST /api/mcp/oauth/token` for code exchange and refresh. */
export async function handleMcpToken(args: {
  request: Request;
  state: McpState;
}): Promise<Response> {
  const contentType = args.request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return tokenError("invalid_request", "Send a form-encoded body.");
  }
  const form = new URLSearchParams(await args.request.text());
  const value = (name: string) => form.get(name) ?? undefined;
  const clientId = value("client_id");
  if (!clientId) {
    return tokenError("invalid_request", "The client_id is required.");
  }

  switch (value("grant_type")) {
    case "authorization_code": {
      const code = value("code");
      const codeVerifier = value("code_verifier");
      const redirectUri = value("redirect_uri");
      if (!code || !codeVerifier || !redirectUri) {
        return tokenError(
          "invalid_request",
          "The code, code_verifier, and redirect_uri are required.",
        );
      }
      return tokenResponse(
        await exchangeAuthorizationCode({
          clientId,
          code,
          codeVerifier,
          redirectUri,
          resource: value("resource"),
          state: args.state,
        }),
      );
    }
    case "refresh_token": {
      const refreshToken = value("refresh_token");
      if (!refreshToken) {
        return tokenError("invalid_request", "The refresh_token is required.");
      }
      return tokenResponse(
        await refreshGrant({
          clientId,
          refreshToken,
          resource: value("resource"),
          scope: value("scope"),
          state: args.state,
        }),
      );
    }
    default:
      return tokenError(
        "unsupported_grant_type",
        "Use authorization_code or refresh_token.",
      );
  }
}
