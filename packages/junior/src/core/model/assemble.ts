// Builds one model request from the host's spec. Core calls it for each step.
// It runs the `enabled` checks, then each needed loader once and all of them
// at the same time, then each fragment's `format`, and puts the outputs into
// the fields in layout order. The step gets the Turn's tools separately.
import type { Message } from "@earendil-works/pi-ai";
import type {
  FragmentDiagnostics,
  LoaderDiagnostics,
  ModelRequestDiagnostics,
} from "@/core/model/diagnostics";
import type {
  LoadedValues,
  Loader,
  ModelRequestContext,
  ModelRequestSpec,
  Skip,
} from "@/core/model/request";
import type { ModelSettings } from "@/core/model/client";
import type { StepInput } from "@/core/turn/step";

/**
 * The parts of a step's input that come from the model request. The step
 * builds the `ModelRequest` itself, with the Turn's tools.
 */
export type AssembledModelRequest = Pick<
  StepInput,
  "systemPrompt" | "messages" | "model" | "session"
>;

type Field = FragmentDiagnostics["field"];

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
  for (const item of [...spec.messages, spec.model]) {
    if (item.enabled && !item.enabled(ctx)) {
      disabled.add(item);
    } else if (item.loader) {
      needed.add(item.loader);
    }
  }

  const values: LoadedValues = { ctx };
  const runs = await Promise.all(
    // oxlint-disable-next-line junior/bounded-fan-out -- The host declares a short list of loaders, and they run at once so a step waits only for the slowest one.
    [...needed].map(async (source) => ({
      source,
      ...(await runLoader(source, values)),
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
      render: (values: LoadedValues) => TOutput | Skip;
    }>,
  ): TOutput[] => {
    const outputs: TOutput[] = [];
    for (const item of items) {
      if (disabled.has(item)) {
        fragments.push({ name: item.name, field, status: "disabled" });
        continue;
      }
      const output = item.render(values);
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
      systemPrompt: spec.systemPrompt.map((part) => part.text).join("\n\n"),
      messages: [...ctx.history, ...newMessages],
      model,
      session,
    },
    newMessages,
    diagnostics: {
      systemPrompt: spec.systemPrompt.map(({ name, text }) => ({
        name,
        chars: text.length,
      })),
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

/** Loads one loader's value for a request, and times the load. */
async function runLoader(
  source: Loader<unknown>,
  values: LoadedValues,
): Promise<{ diagnostics: LoaderDiagnostics; error?: unknown }> {
  const started = performance.now();
  const { status, error } = await loadWithTimeout(source, values);
  const ms = Math.round(performance.now() - started);
  return { diagnostics: { label: source.label, ms, status }, error };
}

/** Runs one load, and aborts its signal and stops waiting after its timeout. */
async function loadWithTimeout(
  source: Loader<unknown>,
  values: LoadedValues,
): Promise<{ status: LoaderDiagnostics["status"]; error?: unknown }> {
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
      .loadInto(values, controller.signal)
      .then((): "ok" => "ok");
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
