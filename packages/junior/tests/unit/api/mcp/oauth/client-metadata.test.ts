import { describe, expect, it } from "vitest";
import {
  JUNIOR_IOS_CLIENT,
  redirectUriMatches,
} from "@/api/mcp/oauth/client-metadata";

const CLIENT_ID = "https://client.example.com/client.json";

describe("MCP redirect URI matching", () => {
  const client = {
    clientId: CLIENT_ID,
    redirectUris: [
      "https://client.example.com/callback",
      "http://localhost/callback",
      "http://127.0.0.1:8080/callback",
    ],
  };

  it.each([
    ["https://client.example.com/callback"],
    ["http://localhost:53682/callback"],
    ["http://localhost/callback"],
  ])("allows %s", (requested) => {
    expect(redirectUriMatches(client, requested)).toBe(true);
  });

  it.each([
    // Only loopback URIs may change the port.
    ["https://client.example.com:8443/callback"],
    ["https://client.example.com/callback/extra"],
    ["https://client.example.com/callback?next=1"],
    ["https://client.example.com/callback#fragment"],
    // A loopback port match keeps the registered host and path.
    ["http://127.0.0.1:53682/other"],
    ["http://[::1]:53682/callback"],
    ["http://client.example.com/callback"],
    ["not a url"],
  ])("rejects %s", (requested) => {
    expect(redirectUriMatches(client, requested)).toBe(false);
  });

  it("rejects a registered URI that is not https or loopback http", () => {
    expect(
      redirectUriMatches(
        {
          clientId: CLIENT_ID,
          redirectUris: ["http://client.example.com/callback"],
        },
        "http://client.example.com/callback",
      ),
    ).toBe(false);
  });

  it("allows an app URL scheme only for Junior's iOS app", () => {
    const appRedirect = "junior-ios://oauth/callback";

    expect(redirectUriMatches(JUNIOR_IOS_CLIENT, appRedirect)).toBe(true);
    expect(
      redirectUriMatches(JUNIOR_IOS_CLIENT, "junior-ios://oauth/other"),
    ).toBe(false);
    expect(
      redirectUriMatches(JUNIOR_IOS_CLIENT, "http://127.0.0.1:53682/callback"),
    ).toBe(false);
    expect(
      redirectUriMatches(
        { clientId: CLIENT_ID, redirectUris: [appRedirect] },
        appRedirect,
      ),
    ).toBe(false);
  });
});
