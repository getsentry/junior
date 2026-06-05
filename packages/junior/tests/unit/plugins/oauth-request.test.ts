import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  buildOAuthTokenRequest,
  parseOAuthTokenResponse,
} from "@/chat/plugins/auth/oauth-request";

describe("OAuth token request helpers", () => {
  it("uses form-encoded body credentials by default", () => {
    const request = buildOAuthTokenRequest({
      clientId: "client-id",
      clientSecret: "client-secret",
      payload: {
        grant_type: "authorization_code",
        code: "auth-code",
      },
    });

    expect(request.headers).toMatchObject({
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    });
    const body = new URLSearchParams(String(request.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      code: "auth-code",
      client_id: "client-id",
      client_secret: "client-secret",
    });
  });

  it("uses Basic auth and JSON body when provider metadata requires it", () => {
    const request = buildOAuthTokenRequest({
      clientId: "client-id",
      clientSecret: "client-secret",
      payload: {
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: "https://junior.example.com/api/oauth/callback/example",
      },
      tokenAuthMethod: "basic",
      tokenExtraHeaders: {
        "Content-Type": "application/json",
      },
    });

    expect(request.headers).toMatchObject({
      accept: "application/json",
      authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
      "content-type": "application/json",
    });
    expect(request.body).toBe(
      JSON.stringify({
        grant_type: "authorization_code",
        code: "auth-code",
        redirect_uri: "https://junior.example.com/api/oauth/callback/example",
      }),
    );
  });

  it("normalizes token response scope and expiration", () => {
    const parsed = parseOAuthTokenResponse(
      {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3600,
      },
      "event:read org:read",
    );

    expect(parsed).toEqual(
      expect.objectContaining({
        accessToken: "access-token",
        refreshToken: "refresh-token",
        scope: "event:read org:read",
        expiresAt: expect.any(Number),
      }),
    );
    expect(parsed.expiresAt).toBeGreaterThan(Date.now());
  });

  it("omits expiration when providers do not return expires_in", () => {
    expect(
      parseOAuthTokenResponse({
        access_token: "access-token",
        refresh_token: "refresh-token",
      }),
    ).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
  });

  it("rejects incomplete token responses", () => {
    expect(() =>
      parseOAuthTokenResponse({
        access_token: "access-token",
      }),
    ).toThrow("missing refresh_token");
  });
});
