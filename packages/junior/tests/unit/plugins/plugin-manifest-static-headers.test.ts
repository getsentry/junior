import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@/chat/plugins/manifest";

describe("plugin manifest static-headers credentials", () => {
  it("parses static headers credentials with literal and env-backed header values", () => {
    const manifest = parsePluginManifest(
      [
        "name: example",
        "description: Example API access",
        "credentials:",
        "  type: static-headers",
        "  api-domains:",
        "    - api.example.com",
        "  api-headers:",
        '    Authorization: "$EXAMPLE_AUTH_HEADER"',
        '    Content-Type: "text/plain"',
      ].join("\n"),
      "/tmp/example",
    );

    expect(manifest.credentials).toEqual({
      type: "static-headers",
      apiDomains: ["api.example.com"],
      apiHeaders: {
        Authorization: "$EXAMPLE_AUTH_HEADER",
        "Content-Type": "text/plain",
      },
    });
  });

  it("rejects unsupported static-headers payloads without api-headers", () => {
    expect(() =>
      parsePluginManifest(
        [
          "name: example",
          "description: Example API access",
          "credentials:",
          "  type: static-headers",
          "  api-domains:",
          "    - api.example.com",
        ].join("\n"),
        "/tmp/example",
      ),
    ).toThrow(/credentials\.api-headers/);
  });
});
