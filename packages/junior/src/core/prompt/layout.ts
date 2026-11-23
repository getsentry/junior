// The API that host code uses to declare how core builds the prompt of each
// model request. `definePromptLayout` states the rules and shows an example.
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
 * Checks a layout and returns the copy that core builds each prompt from. It
 * throws on an empty or repeated system prompt section name, on two
 * fragments with one name, on one fragment used twice, on two loaders with
 * one label, and unless the messages hold exactly one `inputs()` fragment.
 * It freezes the system prompt sections and the messages list.
 *
 * The rules:
 * - Loaders do all of the I/O. Core runs each needed loader once per step.
 * - Fragments are pure. `enabled` and `format` do no I/O, and read no clock
 *   and no random value, so the same inputs give the same prompt. Their
 *   messages have no timestamp: core gives each one the step's time, and
 *   each input its send time.
 * - Message fragments only append. Their messages go after the history, and
 *   a later step sees them in its history. Core builds them only for a step
 *   that sends a model request, not for a step that runs tool calls.
 * - The `inputs()` fragment sets where the Turn's unread inputs go.
 * - The system prompt holds no Conversation data. The host builds its
 *   sections once at startup, so the model provider can cache that part of
 *   the request.
 * - Tools and model settings are not in the layout. They belong to the Turn,
 *   and the step gets them separately.
 *
 * @example
 * // At startup:
 * const soul = await readFile("SOUL.md", "utf8");
 * const memories = loader(
 *   "memories",
 *   (ctx, signal) => memoryStore.recall(ctx.turn.conversationId, signal),
 *   { timeoutMs: 2_000, optional: true },
 * );
 * const recalled = fragment("recalled-memories", {
 *   loader: memories,
 *   // Recall only for a step that has new inputs.
 *   enabled: (ctx) => ctx.inputs.length > 0,
 *   format: (notes): FragmentMessage | Skip =>
 *     notes && notes.length > 0
 *       ? { role: "user", content: notes.join("\n") }
 *       : skip("no memories"),
 * });
 * const layout = definePromptLayout({
 *   systemPrompt: [
 *     { name: "identity", text: "You are Junior, Sentry's Slack bot." },
 *     { name: "personality", text: soul },
 *   ],
 *   messages: [
 *     recalled,
 *     inputs({
 *       format: (input) => ({
 *         message: { role: "user", content: String(input.payload["text"]) },
 *         provenance: { authority: "instruction" },
 *       }),
 *     }),
 *   ],
 * });
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
