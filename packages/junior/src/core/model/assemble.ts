// Builds one model request from the host's spec. Core calls it for each step.
// It runs the `enabled` checks, then each needed loader once and all of them
// at the same time, then each fragment's `format`, and puts the outputs into
// the fields in layout order.
import type { Message } from "@earendil-works/pi-ai";
import type {
  FragmentDiagnostics,
  LoaderDiagnostics,
  ModelRequestDiagnostics,
} from "@/core/model/diagnostics";
import type {
  LoadedValueKeys,
  Loader,
  ModelRequestContext,
  ModelRequestSpec,
  Skip,
} from "@/core/model/request";
import type { ModelSettings } from "@/core/model/client";
import type { ToolDefinition } from "@/core/tool";
import type { StepInput } from "@/core/turn/step";

/**
 * The parts of a step's input that come from the model request. The step
 * needs the tools' `execute` as well as their declarations, so this is not a
 * `ModelRequest`: the step builds that itself.
 */
export type AssembledModelRequest = Pick<
  StepInput,
  "systemPrompt" | "messages" | "tools" | "model" | "session"
>;

type Field = FragmentDiagnostics["field"];

type LoadOutcome = "ok" | "failed" | "timed_out";

/**
 * Builds the model request for one step. A required loader that fails or
 * times out throws an error that names it. An optional one gives `undefined`
 * to its fragments. `newMessages` are the message fragments' outputs, which
 * go after `ctx.history` in `request.messages`.
 */
export async function assembleModelRequest(
  spec: ModelRequestSpec,
  ctx: ModelRequestContext,
  { session }: { session: string },
): Promise<{
  request: AssembledModelRequest;
  newMessages: Message[];
  diagnostics: ModelRequestDiagnostics;
}> {
  const disabled = new Set<object>();
  const needed = new Set<Loader<unknown>>();
  for (const item of [
    ...spec.systemPrompt,
    ...spec.tools,
    ...spec.messages,
    spec.model,
  ]) {
    if (item.enabled && !item.enabled(ctx)) {
      disabled.add(item);
    } else if (item.loader) {
      needed.add(item.loader);
    }
  }

  const keys: LoadedValueKeys = { deployment: spec, step: { ctx } };
  const runs = await Promise.all(
    // oxlint-disable-next-line junior/bounded-fan-out -- The host declares a short list of loaders, and they run at once so a step waits only for the slowest one.
    [...needed].map(async (source) => ({
      source,
      ...(await runLoader(source, keys)),
    })),
  );
  for (const { source, diagnostics, error } of runs) {
    if (source.optional) {
      continue;
    }
    if (diagnostics.status === "failed") {
      throw new Error(`Loader "${source.label}" failed`, { cause: error });
    }
    if (diagnostics.status === "timed_out") {
      throw new Error(
        `Loader "${source.label}" timed out after ${source.timeoutMs} ms`,
      );
    }
  }

  const fragments: FragmentDiagnostics[] = [];
  const renderField = <TOutput>(
    field: Field,
    items: ReadonlyArray<{
      name: string;
      render: (keys: LoadedValueKeys) => TOutput | Skip;
    }>,
  ): TOutput[] => {
    const outputs: TOutput[] = [];
    for (const item of items) {
      if (disabled.has(item)) {
        fragments.push({ name: item.name, field, status: "disabled" });
        continue;
      }
      const output = item.render(keys);
      if (isSkip(output)) {
        fragments.push({
          name: item.name,
          field,
          status: "skipped",
          reason: output.skipped,
        });
        continue;
      }
      fragments.push({ name: item.name, field, status: "included" });
      outputs.push(output);
    }
    return outputs;
  };
  const systemPrompt = renderField<string>("systemPrompt", spec.systemPrompt);
  const tools = renderField<ToolDefinition[]>("tools", spec.tools).flat();
  const newMessages = renderField<Message | Message[]>(
    "messages",
    spec.messages,
  ).flat();
  const [model] = renderField<ModelSettings>("model", [spec.model]);
  if (!model) {
    throw new Error(`Fragment "${spec.model.name}" gave no model settings`);
  }
  return {
    request: {
      systemPrompt: systemPrompt.join("\n\n"),
      messages: [...ctx.history, ...newMessages],
      tools,
      model,
      session,
    },
    newMessages,
    diagnostics: {
      loaders: runs.map((run) => run.diagnostics),
      fragments,
    },
  };
}

function isSkip<TOutput>(output: TOutput | Skip): output is Skip {
  return (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    "skipped" in output
  );
}

/**
 * Loads one loader's value for a request. A `deployment` value stays on the
 * spec after its first successful load. A failed load keeps nothing, so the
 * next request tries again.
 */
async function runLoader(
  source: Loader<unknown>,
  keys: LoadedValueKeys,
): Promise<{ diagnostics: LoaderDiagnostics; error?: unknown }> {
  const { label, lifetime } = source;
  if (lifetime === "deployment" && source.has(keys)) {
    return { diagnostics: { label, lifetime, ms: 0, status: "cached" } };
  }
  const started = performance.now();
  const { status, error } = await loadWithTimeout(source, keys);
  const ms = Math.round(performance.now() - started);
  return { diagnostics: { label, lifetime, ms, status }, error };
}

/** Runs one load, and aborts its signal and stops waiting after its timeout. */
async function loadWithTimeout(
  source: Loader<unknown>,
  keys: LoadedValueKeys,
): Promise<{ status: LoadOutcome; error?: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => {
      resolve("timed_out");
      controller.abort(new Error(`Loader "${source.label}" timed out`));
    }, source.timeoutMs);
  });
  try {
    const loaded = source
      .loadInto(keys, controller.signal)
      .then((): LoadOutcome => "ok");
    return { status: await Promise.race([loaded, timeout]) };
  } catch (error) {
    // A load that stops when its signal aborts rejects after the timeout.
    return controller.signal.aborted
      ? { status: "timed_out" }
      : { status: "failed", error };
  } finally {
    clearTimeout(timer);
  }
}
