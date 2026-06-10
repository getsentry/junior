import { beforeEach, describe, expect, it, vi } from "vitest";

const { logExceptionMock, logInfoMock, logWarnMock, setSpanAttributesMock } =
  vi.hoisted(() => ({
    logExceptionMock: vi.fn(),
    logInfoMock: vi.fn(),
    logWarnMock: vi.fn(),
    setSpanAttributesMock: vi.fn(),
  }));

vi.mock("@/chat/logging", () => ({
  logException: logExceptionMock,
  logInfo: logInfoMock,
  logWarn: logWarnMock,
  setSpanAttributes: setSpanAttributesMock,
}));

import { McpToolError } from "@/chat/mcp/errors";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";
import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";

describe("handleToolExecutionError", () => {
  beforeEach(() => {
    logExceptionMock.mockReset();
    logInfoMock.mockReset();
    logWarnMock.mockReset();
    setSpanAttributesMock.mockReset();
  });

  it("uses the MCP semantic error type for MCP tool results", () => {
    const error = new McpToolError("remote tool failed");

    expect(() =>
      handleToolExecutionError(
        error,
        "callMcpTool",
        "tool-call-id",
        true,
        {},
        "private",
      ),
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
        "exception.message": "MCP tool call failed",
      }),
      "Agent tool call failed",
    );
    expect(JSON.stringify(logWarnMock.mock.calls)).not.toContain(
      "remote tool failed",
    );
    expect(logExceptionMock).not.toHaveBeenCalled();
  });

  it("logs plugin credential failures as credential events", () => {
    const error = new PluginCredentialFailureError(
      "github",
      "GitHub credentials were rejected while running `gh repo view secret`.",
    );

    expect(() =>
      handleToolExecutionError(error, "bash", "tool-call-id", true, {}),
    ).toThrow(error);

    expect(setSpanAttributesMock).toHaveBeenCalledWith({
      "app.credential.provider": "github",
      "error.type": "PluginCredentialFailureError",
    });
    expect(logInfoMock).toHaveBeenCalledWith(
      "plugin_credential_rejected",
      {},
      expect.objectContaining({
        "app.credential.provider": "github",
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "bash",
        "gen_ai.tool.call.id": "tool-call-id",
        "error.type": "PluginCredentialFailureError",
      }),
      "Plugin credentials were rejected during tool execution",
    );
    expect(logWarnMock).not.toHaveBeenCalled();
    expect(logExceptionMock).not.toHaveBeenCalled();
    expect(JSON.stringify(logInfoMock.mock.calls)).not.toContain(
      "gh repo view secret",
    );
  });
});
