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
  hooks?: ToolBatchHooks;
  close(): void;
};

/**
 * Fixed points in a tool batch where the host adds its own behavior. Core
 * runs them in this order: `beforeCall` for each call that passed core's
 * checks, then `beforeBatch` once, then each call that is still allowed, then
 * `afterCall` for every result. Calls carry their validated arguments. A
 * throw from a hook fails the step, unlike a throw from a tool. Results go
 * into the history in the model's call order. The tools of a step are built
 * for that step, so the host can keep what a hook learns about a call by its
 * call id, for `execute` or `afterCall` to use.
 */
export type ToolBatchHooks = {
  /** Per call. A result means the call does not run, and the model sees it. */
  beforeCall?(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<ToolResult | undefined>;
  /**
   * Once, with every call that is still allowed, in the model's order, before
   * any call runs. A call with a result in the map, by call id, does not run,
   * and the model sees that result.
   */
  beforeBatch?(
    calls: ToolCall[],
    signal: AbortSignal,
  ): Promise<Map<string, ToolResult>>;
  /**
   * Per result, including results from core's checks, from a before hook,
   * and from a tool that failed. The returned result is the one the model
   * sees.
   */
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
