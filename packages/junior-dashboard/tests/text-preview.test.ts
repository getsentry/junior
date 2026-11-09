import { describe, expect, it } from "vitest";

import {
  decodeTextPreview,
  textPreviewLanguage,
} from "../src/client/conversations/textPreview";

describe("text preview", () => {
  it.each([
    ["README.md", "application/octet-stream", "markdown"],
    ["main.py", "application/octet-stream", "py"],
    ["config.yml", "application/octet-stream", "yml"],
    ["server.log", "application/octet-stream", "plain"],
    ["main.go", "application/octet-stream", "plain"],
    ["notes", "text/plain; charset=utf-8", "plain"],
    ["notes", "text/markdown", "markdown"],
    ["data", "application/json", "json"],
  ])("previews %s (%s) as %s", (filename, contentType, language) => {
    expect(textPreviewLanguage({ contentType, filename })).toBe(language);
  });

  it.each([
    ["chart.png", "image/png"],
    ["logo.svg", "image/svg+xml"],
    ["report.pdf", "application/pdf"],
    ["archive", "application/octet-stream"],
  ])("does not preview %s (%s)", (filename, contentType) => {
    expect(textPreviewLanguage({ contentType, filename })).toBeUndefined();
  });

  it("rejects bytes with a NUL byte", () => {
    expect(decodeTextPreview(new Uint8Array([0x50, 0x00, 0x4b]), false)).toBe(
      undefined,
    );
  });

  it("drops a character that the byte limit cut in half", () => {
    // "é" is 0xc3 0xa9 in UTF-8. The limit kept only its first byte.
    const bytes = new Uint8Array([0x61, 0xc3]);
    expect(decodeTextPreview(bytes, true)).toBe("a");
    expect(decodeTextPreview(bytes, false)).toBe("a\ufffd");
  });
});
