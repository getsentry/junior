import { describe, expect, it } from "vitest";
import { redirectUriMatches } from "@/api/mcp/client-metadata";

describe("MCP redirect URI matching", () => {
  const registered = [
    "https://client.example.com/callback",
    "http://localhost/callback",
    "http://127.0.0.1:8080/callback",
  ];

  it.each([
    ["https://client.example.com/callback"],
    ["http://localhost:53682/callback"],
    ["http://localhost/callback"],
  ])("allows %s", (requested) => {
    expect(redirectUriMatches(registered, requested)).toBe(true);
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
    expect(redirectUriMatches(registered, requested)).toBe(false);
  });

  it("rejects a registered URI that is not https or loopback http", () => {
    expect(
      redirectUriMatches(
        ["http://client.example.com/callback"],
        "http://client.example.com/callback",
      ),
    ).toBe(false);
  });
});
