import { describe, expect, it } from "vitest";
import { normalizeToolResult } from "@/chat/tools/execution/normalize-result";

describe("normalizeToolResult", () => {
  it("unwraps sandbox envelope", () => {
    const result = normalizeToolResult({ result: "hello" }, true);
    expect(result.details).toBe("hello");
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("does not unwrap non-sandbox result", () => {
    const result = normalizeToolResult({ result: "hello" }, false);
    expect(result.details).toEqual({ result: "hello" });
  });

  it("passes through structured result", () => {
    const structured = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { foo: 1 },
    };
    const result = normalizeToolResult(structured, false);
    expect(result).toBe(structured);
  });

  it("passes through structured result from sandbox envelope", () => {
    const structured = {
      content: [{ type: "text" as const, text: "ok" }],
      details: { foo: 1 },
    };
    const result = normalizeToolResult({ result: structured }, true);
    expect(result).toBe(structured);
  });

  it("serializes object to JSON text", () => {
    const result = normalizeToolResult({ key: "value" }, false);
    expect(result.content[0]).toEqual({
      type: "text",
      text: '{"key":"value"}',
    });
  });

  it("handles string result directly", () => {
    const result = normalizeToolResult("plain text", false);
    expect(result.content[0]).toEqual({ type: "text", text: "plain text" });
  });

  it("handles null result", () => {
    const result = normalizeToolResult(null, false);
    expect(result.content[0]).toEqual({ type: "text", text: "null" });
  });
});
