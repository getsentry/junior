import { withSpan, type Span, type SpanAttributes } from "@/core/telemetry";
import {
  ToolExecutionEnvironmentUnavailableError,
  type OutputChunk,
  type ToolExecutionEnvironment,
  type ToolExecutionEnvironmentManager,
} from "@/core/tool-execution-environment/types";

/**
 * Adds `sandbox.*` spans to any manager and the environments it returns. The
 * spans record only sizes, exit codes, and outcomes, never paths, arguments,
 * or output. `app.sandbox.outcome` is `completed`, `unavailable`,
 * `timed_out`, `aborted`, or `failed`. Only `failed` sets the error status,
 * because the others are outcomes that the caller handles.
 */
export function instrumentToolExecutionEnvironmentManager(
  manager: ToolExecutionEnvironmentManager,
): ToolExecutionEnvironmentManager {
  return {
    create: (input, signal) =>
      inSpan(
        "sandbox.create",
        {
          "app.sandbox.id": input.id,
          "app.sandbox.timeout_ms": input.timeoutMs,
          "app.sandbox.snapshot_used": input.snapshotId !== undefined,
        },
        signal,
        async () =>
          instrumentEnvironment(input.id, await manager.create(input, signal)),
      ),
    resume: (id, signal) =>
      inSpan("sandbox.get", { "app.sandbox.id": id }, signal, async (span) => {
        const environment = await manager.resume(id, signal);
        span.setAttribute("app.sandbox.found", environment !== undefined);
        return environment && instrumentEnvironment(id, environment);
      }),
  };
}

function instrumentEnvironment(
  id: string,
  environment: ToolExecutionEnvironment,
): ToolExecutionEnvironment {
  return {
    cwd: environment.cwd,
    exec: (argv, options) =>
      inSpan(
        "sandbox.exec",
        {
          "app.sandbox.id": id,
          // Only the program: the arguments can hold user data.
          "app.sandbox.exec.program": argv[0],
          "app.sandbox.exec.timeout_ms": options.timeoutMs,
        },
        options.signal,
        async (span) => {
          const bytes = { stdout: 0, stderr: 0 };
          const result = await environment.exec(argv, {
            ...options,
            onOutputChunk(chunk: OutputChunk) {
              bytes[chunk.stream] += Buffer.byteLength(chunk.text);
              options.onOutputChunk(chunk);
            },
          });
          span.setAttributes({
            "app.sandbox.exec.exit_code": result.exitCode,
            "app.sandbox.exec.stdout_bytes": bytes.stdout,
            "app.sandbox.exec.stderr_bytes": bytes.stderr,
          });
          return result;
        },
      ),
    // Covers opening the file. The caller reads the stream after it ends.
    readFile: (path, signal) =>
      inSpan(
        "sandbox.read_file",
        { "app.sandbox.id": id },
        signal,
        async (span) => {
          const stream = await environment.readFile(path, signal);
          span.setAttribute("app.sandbox.found", stream !== undefined);
          return stream;
        },
      ),
    writeFile: (path, content, signal) =>
      inSpan(
        "sandbox.write_file",
        { "app.sandbox.id": id, "app.sandbox.bytes": content.byteLength },
        signal,
        () => environment.writeFile(path, content, signal),
      ),
  };
}

function inSpan<T>(
  name: string,
  attributes: SpanAttributes,
  signal: AbortSignal,
  run: (span: Span) => Promise<T>,
): Promise<T> {
  return withSpan(
    name,
    attributes,
    async (span) => {
      try {
        const result = await run(span);
        span.setAttribute("app.sandbox.outcome", "completed");
        return result;
      } catch (error) {
        span.setAttribute("app.sandbox.outcome", outcomeOf(error, signal));
        throw error;
      }
    },
    { isExpectedError: (error) => outcomeOf(error, signal) !== "failed" },
  );
}

function outcomeOf(
  error: unknown,
  signal: AbortSignal,
): "unavailable" | "timed_out" | "aborted" | "failed" {
  if (error instanceof ToolExecutionEnvironmentUnavailableError) {
    return "unavailable";
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return "timed_out";
  }
  return signal.aborted ? "aborted" : "failed";
}
