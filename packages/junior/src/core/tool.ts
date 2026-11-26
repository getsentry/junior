import type {
  ImageContent,
  JsonObject,
  JsonValue,
  TextContent,
  Tool,
  ToolCall,
} from "@earendil-works/pi-ai";

/**
 * A tool: the declaration that the model sees, and the code that runs one
 * call. Only the pi-ai `Tool` fields go into the model request.
 */
export type ToolDefinition<
  TArgs extends JsonObject = JsonObject,
  TDetails extends JsonValue = JsonValue,
> = Tool & {
  /**
   * Whether a step that runs again may run this call again. A step runs again
   * when its earlier attempt did not commit, so a call may have run without a
   * saved result. `safe`: running it twice does no harm, such as a read.
   * `never`: it has a side effect, so the retry gives the model an error
   * result and does not run it.
   */
  replay: "never" | "safe";
  /**
   * Runs one call. `args` are already validated against `parameters`. A throw
   * becomes an error result that the model sees.
   */
  execute(
    args: TArgs,
    context: ToolExecutionContext,
  ): Promise<ToolResult<TDetails>>;
};

/** What a tool gets for one call. */
export type ToolExecutionContext = {
  /** The model's id for this call. */
  callId: string;
  signal: AbortSignal;
};

/**
 * The tools of one step, which the host builds for the claimed Turn. Core
 * calls `close` when the step ends, so the host can let go of what the tools
 * hold, such as a sandbox handle.
 */
export type StepTools = {
  definitions: ToolDefinition[];
  /** Host code that core runs around the step's tool calls. */
  hooks?: ToolExecutionHooks;
  close(): void;
};

/**
 * Core runs these in order: `beforeCall` per call, `beforeBatch` once, the
 * calls, then `afterCall` per call. A throw from any of them fails the step.
 */
export type ToolExecutionHooks = {
  /** Before a call runs. Return a result to skip the call; the model sees it instead. */
  beforeCall?(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResult | undefined>;
  /** Once, before any call runs, with the calls not yet skipped. A result for a call id skips that call. */
  beforeBatch?(
    calls: ToolCall[],
    signal: AbortSignal,
  ): Promise<Map<string, ToolResult>>;
  /** After each call, skipped ones included. The returned result replaces the call's result. */
  afterCall?(
    call: ToolCall,
    result: ToolResult,
    signal: AbortSignal,
  ): Promise<ToolResult>;
};

/** What one call returns. It becomes a pi-ai `ToolResultMessage`. */
export type ToolResult<TDetails extends JsonValue = JsonValue> = {
  /** What the model sees. */
  content: (TextContent | ImageContent)[];
  /** Data for the session record and UI. The model does not see it. */
  details?: TDetails;
  /** The call failed in a way the model should see and can react to. */
  isError?: boolean;
  /**
   * Hint that the Turn should end after the current tool batch, such as when
   * the user must sign in first. The Turn ends only when every result in the
   * batch sets this to true. Otherwise the Turn continues and the model sees
   * every result. Same rule as pi-agent-core's `terminate`.
   */
  endsTurn?: boolean;
};
