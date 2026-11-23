// Builds the prompt of one model request from the host's layout. Core calls it
// for each step. It runs the `enabled` checks, then each needed loader once,
// then each fragment's `format`, and puts the outputs in layout order. The
// step gets the Turn's tools and model settings separately.
import type { Message } from "@earendil-works/pi-ai";
import { mapBounded } from "@/chat/fan-out";
import type {
  FragmentDiagnostics,
  LoaderDiagnostics,
  PromptDiagnostics,
} from "@/core/prompt/diagnostics";
import type {
  LoadedValues,
  Loader,
  PromptBuildContext,
  PromptLayout,
  Skip,
} from "@/core/prompt/layout";

/**
 * Builds the prompt for one step. A required loader that fails or times out
 * throws an error that names it. An optional one gives `undefined` to its
 * fragments. A fragment whose `enabled` or `format` throws gives an error
 * that names it. `newMessages` are the message fragments' outputs, which go
 * after `ctx.history` in `messages`.
 */
export async function assemblePrompt(
  layout: PromptLayout,
  ctx: PromptBuildContext,
): Promise<{
  systemPrompt: string;
  messages: Message[];
  newMessages: Message[];
  diagnostics: PromptDiagnostics;
}> {
  const disabled = new Set<object>();
  const needed = new Set<Loader<unknown>>();
  for (const item of layout.messages) {
    const { enabled } = item;
    if (enabled && !inFragment(item.name, () => enabled(ctx))) {
      disabled.add(item);
    } else if (item.loader) {
      needed.add(item.loader);
    }
  }

  const values: LoadedValues = { ctx };
  const runs = await mapBounded(needed, async (source) => ({
    source,
    ...(await runLoader(source, values)),
  }));
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
  const newMessages: Message[] = [];
  for (const item of layout.messages) {
    const { name } = item;
    if (disabled.has(item)) {
      fragments.push({ name, field: "messages", status: "disabled" });
      continue;
    }
    const output = inFragment(name, () => item.render(values));
    if (isSkip(output)) {
      fragments.push({
        name,
        field: "messages",
        status: "skipped",
        reason: output.skipped,
      });
      continue;
    }
    fragments.push({ name, field: "messages", status: "included" });
    newMessages.push(...(Array.isArray(output) ? output : [output]));
  }
  return {
    systemPrompt: layout.systemPrompt
      .map((section) => section.text)
      .join("\n\n"),
    messages: [...ctx.history, ...newMessages],
    newMessages,
    diagnostics: {
      systemPrompt: layout.systemPrompt.map(({ name, text }) => ({
        name,
        chars: text.length,
      })),
      loaders: runs.map((run) => run.diagnostics),
      fragments,
    },
  };
}

/** Runs a fragment's own code, and names the fragment when it throws. */
function inFragment<T>(name: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new Error(`Fragment "${name}" failed`, { cause: error });
  }
}

function isSkip<TOutput>(output: TOutput | Skip): output is Skip {
  return (
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    "skipped" in output
  );
}

/** Loads one loader's value for a prompt, and times the load. */
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
