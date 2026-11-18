import type {
  ImageContent,
  JsonObject,
  JsonValue,
  TextContent,
  Tool,
} from "@earendil-works/pi-ai";
import type { ToolExecutionEnvironment } from "@/core/tool-execution-environment";

/**
 * A tool: the declaration that the model sees, and the code that runs one
 * call. Only the pi-ai `Tool` fields go into the model request.
 */
export type ToolDefinition<
  TArgs extends JsonObject = JsonObject,
  TDetails extends JsonValue = JsonValue,
> = Tool & {
  /**
   * Runs one call. `args` are already validated against `parameters`. A throw
   * becomes an error result that the model sees.
   */
  execute(
    args: TArgs,
    context: ToolExecutionContext,
  ): Promise<ToolResult<TDetails>>;
};

/**
 * What a tool gets for one call. The tool does not know where the environment
 * comes from or how long it lives: whoever builds the context owns that.
 */
export type ToolExecutionContext = {
  /** The model's id for this call. */
  callId: string;
  signal: AbortSignal;
  /** Present only for tools that run commands or read and write files. */
  environment?: ToolExecutionEnvironment;
};

/** What one call returns. It becomes a pi-ai `ToolResultMessage`. */
export type ToolResult<TDetails extends JsonValue = JsonValue> = {
  /** What the model sees. */
  content: (TextContent | ImageContent)[];
  /** Data for the session record and UI. The model does not see it. */
  details?: TDetails;
  /** The call failed in a way the model should see and can react to. */
  isError?: boolean;
};
