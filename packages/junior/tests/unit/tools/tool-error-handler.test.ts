import { beforeEach, describe, expect, it, vi } from "vitest";

const { logExceptionMock, logWarnMock, setSpanAttributesMock } = vi.hoisted(
  () => ({
    logExceptionMock: vi.fn(),
    logWarnMock: vi.fn(),
    setSpanAttributesMock: vi.fn(),
  }),
);

vi.mock("@/chat/logging", () => ({
  logException: logExceptionMock,
  logWarn: logWarnMock,
  setSpanAttributes: setSpanAttributesMock,
}));

import { McpToolError } from "@/chat/mcp/errors";
import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";

describe("handleToolExecutionError", () => {
  beforeEach(() => {
    logExceptionMock.mockReset();
    logWarnMock.mockReset();
    setSpanAttributesMock.mockReset();
  });

  it("uses the MCP semantic error type for MCP tool results", () => {
    const error = new McpToolError("remote tool failed");

    expect(() =>
      handleToolExecutionError(error, "callMcpTool", "tool-call-id", true, {}),
    ).toThrow(error);

    expect(setSpanAttributesMock).toHaveBeenCalledWith({
      "error.type": "tool_error",
    });
    expect(logWarnMock).toHaveBeenCalledWith(
      "agent_tool_call_failed",
      {},
      expect.objectContaining({
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "callMcpTool",
        "gen_ai.tool.call.id": "tool-call-id",
        "error.type": "tool_error",
        "error.message": "remote tool failed",
      }),
      "Agent tool call failed",
    );
    expect(logExceptionMock).not.toHaveBeenCalled();
  });
});
