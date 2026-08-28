import { describe, expect, it } from "vitest";
import { normalizeToolResult } from "@/chat/tool-support/normalize-result";

describe("normalizeToolResult", () => {
  it("keeps ordinary object results intact", () => {
    const result = normalizeToolResult({ result: "hello" });
    expect(result.details).toEqual({ result: "hello" });
  });

  it("passes through structured result", () => {
    const structured = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { foo: 1 },
    };
    const result = normalizeToolResult(structured);
    expect(result).toBe(structured);
  });

  it("normalizes native content results with empty transcript details", () => {
    const result = normalizeToolResult({
      content: [
        { type: "text" as const, text: "image generated" },
        {
          type: "image" as const,
          data: "base64-image",
          mimeType: "image/png",
        },
      ],
    });

    expect(result).toEqual({
      content: [
        { type: "text", text: "image generated" },
        {
          type: "image",
          data: "base64-image",
          mimeType: "image/png",
        },
      ],
      details: {},
    });
  });

  it("rejects native content results when structured details are required", () => {
    expect(() =>
      normalizeToolResult(
        {
          content: [{ type: "text" as const, text: "native content" }],
        },
        { requireStructuredResult: true },
      ),
    ).toThrow(
      "Structured tools must return details matching their outputSchema.",
    );
  });

  it("preserves structured envelope details after schema validation", () => {
    const structured = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { value: "ok" },
    };
    const result = normalizeToolResult(structured, {
      requireStructuredResult: true,
    });
    expect(result.details).toEqual({ value: "ok" });
  });

  it("serializes object to JSON text", () => {
    const result = normalizeToolResult({ key: "value" });
    expect(result.content[0]).toEqual({
      type: "text",
      text: '{"key":"value"}',
    });
  });

  it("injects the exposed tool name into continuation metadata", () => {
    const result = normalizeToolResult(
      {
        continuation: {
          arguments: {
            offset: 2,
          },
          reason: "more content",
        },
      },
      { toolName: "renamedReadFile" },
    );

    expect(result.details).toMatchObject({
      continuation: {
        tool_name: "renamedReadFile",
        arguments: {
          offset: 2,
        },
        reason: "more content",
      },
    });
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "{}";
    expect(JSON.parse(text)).toMatchObject({
      continuation: {
        tool_name: "renamedReadFile",
      },
    });
  });

  it("formats upstream permission denials as deterministic tool text", () => {
    const details = {
      command: "git push",
      exit_code: 1,
      stdout: "",
      stderr: "remote: Permission denied",
      permission_denied: {
        account: {
          id: "12345",
          label: "actor",
        },
        acceptedPermissions: "contents=write",
        grant: {
          access: "write",
          name: "user-write",
          reason: "github.installation-write",
          requirements: ["GitHub App Contents: write on the target repository"],
        },
        message:
          "github returned HTTP 403 after the runtime injected the user-write grant. The request was forwarded; this is not a local runtime block.",
        provider: "github",
        source: "upstream",
        status: 403,
        upstreamHost: "github.com",
        upstreamPath:
          "/getsentry/sentry-mcp.git/info/refs?service=git-receive-pack",
      },
    };

    const result = normalizeToolResult(details);

    expect(result.details).toBe(details);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "Junior had a credential lease for this grant and forwarded the request.",
      ),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "Do not diagnose this as a missing user token or a local Junior runtime block",
      ),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "Upstream: github.com/getsentry/sentry-mcp.git/info/refs?service=git-receive-pack",
      ),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("Provider account: actor (12345)"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "GitHub App Contents: write on the target repository",
      ),
    });
  });

  it("formats upstream permission denials from required structured envelopes", () => {
    const details = {
      command: "git push",
      exit_code: 1,
      stdout: "",
      stderr: "remote: Permission denied",
      permission_denied: {
        acceptedPermissions: "contents=write",
        grant: {
          access: "write",
          name: "user-write",
          reason: "github.installation-write",
          requirements: ["GitHub App Contents: write on the target repository"],
        },
        message:
          "github returned HTTP 403 after the runtime injected the user-write grant.",
        provider: "github",
        source: "upstream",
        status: 403,
        upstreamHost: "github.com",
        upstreamPath:
          "/getsentry/sentry-mcp.git/info/refs?service=git-receive-pack",
      },
    };
    const result = normalizeToolResult(
      {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      },
      { requireStructuredResult: true },
    );

    expect(result.details).toEqual(details);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Upstream permission denied."),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "Do not diagnose this as a missing user token or a local Junior runtime block",
      ),
    });
  });

  it("handles string result directly", () => {
    const result = normalizeToolResult("plain text");
    expect(result.content[0]).toEqual({ type: "text", text: "plain text" });
  });

  it("handles null result", () => {
    const result = normalizeToolResult(null);
    expect(result.content[0]).toEqual({ type: "text", text: "null" });
  });
});
