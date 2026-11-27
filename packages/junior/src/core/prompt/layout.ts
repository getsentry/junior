// How host code declares the prompt of each model request. Loaders do all
// I/O, once per needed loader per step. Fragments are pure (no I/O, clock, or
// random value), so the same inputs give the same prompt. Message fragments
// only append, and only for a step that sends a model request. The system
// prompt holds no Conversation data, so the provider can cache it.
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { UnreadInput } from "@/core/turn/inbox";
import type { ClaimedTurn } from "@/core/turn/state";

/** What a loader or a fragment knows about the step that it builds for. */
export type PromptBuildContext = {
  turn: ClaimedTurn;
  /** The Conversation history before this step's new messages. */
  history: Message[];
  /** The Turn's inputs that the history has not read, oldest first. */
  inputs: UnreadInput[];
};

/** Keeps the loaded values of one prompt. Core makes one per prompt. */
export type LoadedValues = { readonly ctx: PromptBuildContext };

/**
 * A source of data for fragments. Make one with `loader`. Core calls
 * `loadInto` and `valueIn`: a fragment reads its loader's value through
 * `valueIn`, so the value keeps its type.
 */
export type Loader<T> = {
  readonly label: string;
  readonly timeoutMs: number;
  /** When true, a failed or timed-out load gives `undefined`. */
  readonly optional: boolean;
  /** Runs the load, and keeps its value in `values` unless `signal` aborts. */
  readonly loadInto: (
    values: LoadedValues,
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * The value kept in `values`. With no value, an optional loader gives
   * `undefined`, and a required one throws.
   */
  readonly valueIn: (values: LoadedValues) => T;
};

type LoaderOptions = {
  /** Core aborts `signal` and stops waiting for the load after this time. */
  timeoutMs: number;
  /**
   * When true, a failed or timed-out load gives `undefined`, and the prompt
   * is built without it. Otherwise the failure stops the step.
   */
  optional?: boolean;
};

type Load<T> = (ctx: PromptBuildContext, signal: AbortSignal) => Promise<T>;

/**
 * Declares a loader. `label` names it in diagnostics and errors, and must be
 * unique in a layout. `load` does the I/O, and stops when `signal` aborts. Core
 * runs it again for each step.
 */
export function loader<T>(
  label: string,
  load: Load<T>,
  options: LoaderOptions & { optional: true },
): Loader<T | undefined>;
export function loader<T>(
  label: string,
  load: Load<T>,
  options: LoaderOptions & { optional?: false },
): Loader<T>;
export function loader<T>(
  label: string,
  load: Load<T>,
  options: LoaderOptions,
): Loader<T> | Loader<T | undefined> {
  if (options.optional) {
    return buildLoader<T | undefined>(label, load, options, () => undefined);
  }
  return buildLoader<T>(label, load, options, () => {
    throw new Error(`Loader "${label}" has no value`);
  });
}

function buildLoader<T>(
  label: string,
  load: Load<T>,
  { timeoutMs, optional = false }: LoaderOptions,
  missing: () => T,
): Loader<T> {
  // Weak keys, so the values go away with their prompt.
  const kept = new WeakMap<LoadedValues, { value: T }>();
  return {
    label,
    timeoutMs,
    optional,
    loadInto: async (values, signal) => {
      const value = await load(values.ctx, signal);
      if (!signal.aborted) {
        kept.set(values, { value });
      }
    },
    valueIn: (values) => {
      const entry = kept.get(values);
      return entry ? entry.value : missing();
    },
  };
}

/** What `format` returns to leave its fragment out of this prompt. */
export type Skip = { skipped: string };

/** Leaves a fragment out of this prompt. `reason` goes into diagnostics. */
export function skip(reason: string): Skip {
  return { skipped: reason };
}

type Enabled = (ctx: PromptBuildContext) => boolean;

/**
 * One piece of a prompt. Make one with `fragment`. Core calls
 * `render`, which runs `format` on the loader's value.
 */
export type Fragment<TOutput = unknown> = {
  readonly name: string;
  readonly loader?: Loader<unknown>;
  readonly enabled?: Enabled;
  readonly render: (values: LoadedValues) => TOutput | Skip;
};

/**
 * Declares a fragment. `name` names it in diagnostics, and must be unique in
 * a layout. `format` turns the loader's value into the fragment's output, or
 * returns `skip(reason)`. `enabled` returning false leaves the fragment out,
 * and core does not run its loader for it.
 */
export function fragment<T, TResult>(
  name: string,
  definition: {
    loader: Loader<T>;
    enabled?: Enabled;
    format: (value: T, ctx: PromptBuildContext) => TResult;
  },
): Fragment<Exclude<TResult, Skip>>;
export function fragment<TResult>(
  name: string,
  definition: {
    loader?: undefined;
    enabled?: Enabled;
    format: (value: undefined, ctx: PromptBuildContext) => TResult;
  },
): Fragment<Exclude<TResult, Skip>>;
export function fragment(
  name: string,
  definition:
    | {
        loader: Loader<unknown>;
        enabled?: Enabled;
        format: (value: unknown, ctx: PromptBuildContext) => unknown;
      }
    | {
        loader?: undefined;
        enabled?: Enabled;
        format: (value: undefined, ctx: PromptBuildContext) => unknown;
      },
): Fragment {
  const { enabled } = definition;
  if (definition.loader) {
    const { loader: source, format } = definition;
    return {
      name,
      loader: source,
      enabled,
      render: (values) => format(source.valueIn(values), values.ctx),
    };
  }
  const { format } = definition;
  return {
    name,
    enabled,
    render: (values) => format(undefined, values.ctx),
  };
}

// Distributes over a union, so each kind of message keeps its own fields.
type WithoutTimestamp<M> = M extends unknown ? Omit<M, "timestamp"> : never;

/**
 * A message that a fragment gives. It has no timestamp: core sets the step's
 * time, so a fragment reads no clock.
 */
export type FragmentMessage = WithoutTimestamp<Message>;

/**
 * One unread input as a user message, and the authority it has. Core sets
 * the message's timestamp to the input's send time.
 */
export type InputPrompt = {
  message: Omit<UserMessage, "timestamp">;
  provenance: ConversationMessageProvenance;
};

type FormatInput = (input: UnreadInput) => InputPrompt;

// The `format` of each `inputs()` fragment. Core finds the inputs fragment of
// a layout by identity, so no field of a fragment can fake one.
const inputFormats = new WeakMap<Fragment, FormatInput>();

/**
 * Declares where the Turn's unread inputs go in the messages. `format` turns
 * each input into a user message and its provenance. A layout has exactly
 * one, named `inputs`. It has no loader: it reads `ctx.inputs`. Core keeps
 * each input's id with its message, so the commit marks the input read.
 */
export function inputs({
  format,
}: {
  format: FormatInput;
}): Fragment<Omit<UserMessage, "timestamp">[]> {
  const item: Fragment<Omit<UserMessage, "timestamp">[]> = {
    name: "inputs",
    render: (values) => values.ctx.inputs.map((input) => format(input).message),
  };
  inputFormats.set(item, format);
  return item;
}

/**
 * The `format` of an `inputs()` fragment, or undefined for any other
 * fragment. Core calls it.
 */
export function inputFormatOf(item: Fragment): FormatInput | undefined {
  return inputFormats.get(item);
}

/** One named, static section of the system prompt. */
export type SystemPromptSection = { name: string; text: string };

/**
 * The sections of the system prompt, and the fragments of the messages. Check
 * it with `definePromptLayout` once at startup, and give the result to core.
 */
export type PromptLayout = {
  /** Their texts are joined, in order, into the system prompt. */
  readonly systemPrompt: readonly SystemPromptSection[];
  /** Their messages go after the history, in order. */
  readonly messages: readonly Fragment<FragmentMessage | FragmentMessage[]>[];
};

/**
 * Checks a layout (rules above) and returns the frozen copy core builds from.
 * Throws on repeated or empty names, reused fragments, or not one `inputs()`.
 * @example
 * const layout = definePromptLayout({ systemPrompt: [identity],
 *   messages: [recalledMemories, inputs({ format: formatInput })] });
 */
export function definePromptLayout(layout: PromptLayout): PromptLayout {
  const sectionNames = new Set<string>();
  for (const { name } of layout.systemPrompt) {
    if (name === "") {
      throw new Error("A system prompt section has no name");
    }
    if (sectionNames.has(name)) {
      throw new Error(`Two system prompt sections are named "${name}"`);
    }
    sectionNames.add(name);
  }

  const inputFragments = layout.messages.filter((item) =>
    inputFormats.has(item),
  ).length;
  if (inputFragments !== 1) {
    throw new Error(
      `A prompt layout needs exactly one inputs() fragment, not ${inputFragments}`,
    );
  }

  const seenFragments = new Set<Fragment>();
  const names = new Set<string>();
  const loaders = new Map<string, Loader<unknown>>();
  for (const item of layout.messages) {
    if (seenFragments.has(item)) {
      throw new Error(`Fragment "${item.name}" is used more than once`);
    }
    seenFragments.add(item);
    if (names.has(item.name)) {
      throw new Error(`Two fragments are named "${item.name}"`);
    }
    names.add(item.name);
    if (!item.loader) {
      continue;
    }
    const known = loaders.get(item.loader.label);
    if (known && known !== item.loader) {
      throw new Error(`Two loaders are labeled "${item.loader.label}"`);
    }
    loaders.set(item.loader.label, item.loader);
  }

  return {
    systemPrompt: Object.freeze(
      layout.systemPrompt.map(({ name, text }) =>
        Object.freeze({ name, text }),
      ),
    ),
    messages: Object.freeze([...layout.messages]),
  };
}
