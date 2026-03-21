import { describe, expect, it } from "vitest";
import { extractOAuthStartedMessageFromToolResults } from "@/chat/tool-result-oauth";

describe("tool result oauth parsing", () => {
  it("extracts oauth_started messages from bash tool results", () => {
    const message = extractOAuthStartedMessageFromToolResults([
      {
        role: "toolResult",
        toolName: "bash",
        isError: false,
        stdout: JSON.stringify({
          credential_unavailable: true,
          oauth_started: true,
          provider: "eval-oauth",
          message:
            "I need to connect your Eval-oauth account first. I've sent you a private authorization link.",
        }),
      },
    ]);

    expect(message).toBe(
      "I need to connect your Eval-oauth account first. I've sent you a private authorization link.",
    );
  });

  it("ignores non-bash and error tool results", () => {
    const message = extractOAuthStartedMessageFromToolResults([
      {
        toolName: "webSearch",
        isError: false,
        stdout: JSON.stringify({
          oauth_started: true,
          message: "wrong tool",
        }),
      },
      {
        toolName: "bash",
        isError: true,
        stdout: JSON.stringify({
          oauth_started: true,
          message: "errored tool",
        }),
      },
    ]);

    expect(message).toBeUndefined();
  });
});
