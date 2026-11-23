// Builds the prompt of one model request from the host's layout. Core calls it
// for each step that sends a model request. It runs the `enabled` checks,
// then each needed loader once, then each fragment's `format`, and puts the
// outputs in layout order. The step gets the Turn's tools and model settings
// separately.
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import { mapBounded } from "@/chat/fan-out";
import type {
  FragmentDiagnostics,
  LoaderDiagnostics,
  PromptDiagnostics,
} from "@/core/prompt/diagnostics";
import {
  inputFormatOf,
  type LoadedValues,
  type Loader,
  type PromptBuildContext,
  type PromptLayout,
  type Skip,
} from "@/core/prompt/layout";

/**
 * One new message of a prompt, and where it came from: a message fragment,
 * or an unread input that the `inputs()` fragment formatted.
 */
export type PromptMessage =
  | { source: "fragment"; fragment: string; message: Message }
  | {
      source: "input";
      inputId: string;
      message: UserMessage;
      provenance: ConversationMessageProvenance;
    };

/** The system prompt of a layout: its sections' texts, joined in order. */
export function layoutSystemPrompt(layout: PromptLayout): string {
  return layout.systemPrompt.map((section) => section.text).join("\n\n");
}

/**
 * Builds the prompt for one step. A required loader that fails or times out
 * throws an error that names it. An optional one gives `undefined` to its
 * fragments. A fragment whose `enabled` or `format` throws gives an error
 * that names it. When `signal` aborts, each load's signal aborts too, and
 * this throws the abort reason. `newMessages` are the new messages in layout
 * order, which go after `ctx.history` in `messages`. Core sets their
 * timestamps: an input's send time, or the step's time for a fragment
 * message.
 */
export async function assemblePrompt(
  layout: PromptLayout,
  ctx: PromptBuildContext,
  { signal }: { signal: AbortSignal },
): Promise<{
  systemPrompt: string;
  messages: Message[];
  newMessages: PromptMessage[];
  diagnostics: PromptDiagnostics;
}> {
  signal.throwIfAborted();
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
    ...(await runLoader(source, values, signal)),
  }));
  // The step stopped, so the loads that it stopped do not count as failures.
  signal.throwIfAborted();
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

  // One time for the step, so every fragment message of a prompt shares it.
  const stepTime = Date.now();
  const fragments: FragmentDiagnostics[] = [];
  const newMessages: PromptMessage[] = [];
  for (const item of layout.messages) {
    const { name } = item;
    if (disabled.has(item)) {
      fragments.push({ name, field: "messages", status: "disabled" });
      continue;
    }
    const formatInput = inputFormatOf(item);
    if (formatInput) {
      for (const input of ctx.inputs) {
        const { message, provenance } = inFragment(name, () =>
          formatInput(input),
        );
        newMessages.push({
          source: "input",
          inputId: input.inputId,
          message: { ...message, timestamp: input.sentAt.getTime() },
          provenance,
        });
      }
      fragments.push({ name, field: "messages", status: "included" });
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
    for (const message of Array.isArray(output) ? output : [output]) {
      newMessages.push({
        source: "fragment",
        fragment: name,
        message: { ...message, timestamp: stepTime },
      });
    }
  }
  return {
    systemPrompt: layoutSystemPrompt(layout),
    messages: [...ctx.history, ...newMessages.map(({ message }) => message)],
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
  signal: AbortSignal,
): Promise<{ diagnostics: LoaderDiagnostics; error?: unknown }> {
  const started = performance.now();
  const { status, error } = await loadWithTimeout(source, values, signal);
  const ms = Math.round(performance.now() - started);
  return { diagnostics: { label: source.label, ms, status }, error };
}

/**
 * Runs one load, and aborts its signal and stops waiting after its timeout
 * or when the step's `signal` aborts.
 */
async function loadWithTimeout(
  source: Loader<unknown>,
  values: LoadedValues,
  signal: AbortSignal,
): Promise<{ status: LoaderDiagnostics["status"]; error?: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopStep = () => {};
  // A stopped step reads no status: assemblePrompt throws the abort reason.
  const stopped = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => {
      resolve("timed_out");
      controller.abort(new Error(`Loader "${source.label}" timed out`));
    }, source.timeoutMs);
    stopStep = () => {
      resolve("timed_out");
      controller.abort(signal.reason);
    };
    signal.addEventListener("abort", stopStep, { once: true });
  });
  try {
    const loaded = source
      .loadInto(values, controller.signal)
      .then((): "ok" => "ok");
    return { status: await Promise.race([loaded, stopped]) };
  } catch (error) {
    // A load that stops when its signal aborts rejects after the timeout.
    return controller.signal.aborted
      ? { status: "timed_out" }
      : { status: "failed", error };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stopStep);
  }
}
