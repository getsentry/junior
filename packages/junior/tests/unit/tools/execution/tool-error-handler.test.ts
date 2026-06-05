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
  resolveGatewayModel: (modelId: string) => modelId,
}));

import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";
import { McpToolError } from "@/chat/mcp/errors";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";

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
        "exception.message": "remote tool failed",
      }),
      "Agent tool call failed",
    );
    expect(logExceptionMock).not.toHaveBeenCalled();
  });

  it("logs plugin credential failures without exposing command text", () => {
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
