import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { handleToolExecutionError } from "@/chat/tools/execution/tool-error-handler";
import { McpToolError } from "@/chat/mcp/errors";
import { PluginCredentialFailureError } from "@/chat/services/plugin-auth-orchestration";

type ToolErrorHandlerServices = NonNullable<
  Parameters<typeof handleToolExecutionError>[5]
>;

describe("handleToolExecutionError", () => {
  const services = {
    genAiProviderName: "test-provider",
    logException: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    setSpanAttributes: vi.fn(),
  } satisfies ToolErrorHandlerServices;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports system errors to Sentry via logException", () => {
    const error = new Error("sandbox API failed");
    expect(() =>
      handleToolExecutionError(error, "editFile", "call_1", true, {}, services),
    ).toThrow(error);

    expect(services.logException).toHaveBeenCalledTimes(1);
    expect(services.setSpanAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ "error.type": "Error" }),
    );
  });

  it("does not report ToolInputError to Sentry", () => {
    const error = new ToolInputError("Could not find edits[0] in file.ts");
    expect(() =>
      handleToolExecutionError(error, "editFile", "call_1", true, {}, services),
    ).toThrow(error);

    expect(services.logException).not.toHaveBeenCalled();
    expect(services.logWarn).toHaveBeenCalledTimes(1);
    expect(services.setSpanAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ "error.type": "tool_input_error" }),
    );
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
        services,
      ),
    ).toThrow(error);

    expect(services.setSpanAttributes).toHaveBeenCalledWith({
      "error.type": "tool_error",
    });
    expect(services.logWarn).toHaveBeenCalledWith(
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
    expect(services.logException).not.toHaveBeenCalled();
  });

  it("logs plugin credential failures without exposing command text", () => {
    const error = new PluginCredentialFailureError(
      "github",
      "GitHub credentials were rejected while running `gh repo view secret`.",
    );

    expect(() =>
      handleToolExecutionError(
        error,
        "bash",
        "tool-call-id",
        true,
        {},
        services,
      ),
    ).toThrow(error);

    expect(services.setSpanAttributes).toHaveBeenCalledWith({
      "app.credential.provider": "github",
      "error.type": "PluginCredentialFailureError",
    });
    expect(services.logInfo).toHaveBeenCalledWith(
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
    expect(services.logWarn).not.toHaveBeenCalled();
    expect(services.logException).not.toHaveBeenCalled();
    expect(JSON.stringify(services.logInfo.mock.calls)).not.toContain(
      "gh repo view secret",
    );
  });
});
