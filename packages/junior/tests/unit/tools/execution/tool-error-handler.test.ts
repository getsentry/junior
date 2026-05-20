import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

const logExceptionMock = vi.fn();
const logInfoMock = vi.fn();
const logWarnMock = vi.fn();
const setSpanAttributesMock = vi.fn();

vi.mock("@/chat/logging", () => ({
  logException: (...args: unknown[]) => logExceptionMock(...args),
  logInfo: (...args: unknown[]) => logInfoMock(...args),
  logWarn: (...args: unknown[]) => logWarnMock(...args),
  setSpanAttributes: (...args: unknown[]) => setSpanAttributesMock(...args),
}));

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "test-provider",
}));

import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";
import { McpToolError } from "@/chat/mcp/errors";

describe("handleToolExecutionError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports system errors to Sentry via logException", () => {
    const error = new Error("sandbox API failed");
    expect(() =>
      handleToolExecutionError(error, "editFile", "call_1", true, {}),
    ).toThrow(error);

    expect(logExceptionMock).toHaveBeenCalledTimes(1);
    expect(setSpanAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({ "error.type": "Error" }),
    );
  });

  it("does not report ToolInputError to Sentry", () => {
    const error = new ToolInputError("Could not find edits[0] in file.ts");
    expect(() =>
      handleToolExecutionError(error, "editFile", "call_1", true, {}),
    ).toThrow(error);

    expect(logExceptionMock).not.toHaveBeenCalled();
    expect(logWarnMock).toHaveBeenCalledTimes(1);
    expect(setSpanAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({ "error.type": "tool_input_error" }),
    );
  });

  it("does not report McpToolError to Sentry", () => {
    const error = new McpToolError("mcp tool failed");
    expect(() =>
      handleToolExecutionError(error, "mcpTool", "call_1", true, {}),
    ).toThrow(error);

    expect(logExceptionMock).not.toHaveBeenCalled();
    expect(setSpanAttributesMock).toHaveBeenCalledWith(
      expect.objectContaining({ "error.type": "tool_error" }),
    );
  });
});
