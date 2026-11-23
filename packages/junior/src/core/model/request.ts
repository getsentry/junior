// The API that host code uses to declare how core builds each model request.
// `defineModelRequest` states the rules and shows an example.
import type { Message } from "@earendil-works/pi-ai";
import type { ModelSettings } from "@/core/model/client";
import type { UnreadInput } from "@/core/turn/inbox";
import type { ClaimedTurn } from "@/core/turn/state";

/** What a loader or a fragment knows about the step that it builds for. */
export type ModelRequestContext = {
  turn: ClaimedTurn;
  /** The Conversation history before this step's new messages. */
  history: Message[];
  /** The Turn's inputs that the history has not read, oldest first. */
  inputs: UnreadInput[];
};

/** Keeps the loaded values of one model request. Core makes one per request. */
export type LoadedValues = { readonly ctx: ModelRequestContext };

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
   * When true, a failed or timed-out load gives `undefined`, and the request
   * is built without it. Otherwise the failure stops the step.
   */
  optional?: boolean;
};

type Load<T> = (ctx: ModelRequestContext, signal: AbortSignal) => Promise<T>;

/**
 * Declares a loader. `label` names it in diagnostics and errors, and must be
 * unique in a spec. `load` does the I/O, and stops when `signal` aborts. Core
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
  // Weak keys, so the values go away with their request.
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

/** What `format` returns to leave its fragment out of this request. */
export type Skip = { skipped: string };

/** Leaves a fragment out of this request. `reason` goes into diagnostics. */
export function skip(reason: string): Skip {
  return { skipped: reason };
}

type Enabled = (ctx: ModelRequestContext) => boolean;

/**
 * One piece of a model request. Make one with `fragment`. Core calls
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
 * a spec. `format` turns the loader's value into the fragment's output, or
 * returns `skip(reason)`. `enabled` returning false leaves the fragment out,
 * and core does not run its loader for it.
 */
export function fragment<T, TResult>(
  name: string,
  definition: {
    loader: Loader<T>;
    enabled?: Enabled;
    format: (value: T, ctx: ModelRequestContext) => TResult;
  },
): Fragment<Exclude<TResult, Skip>>;
export function fragment<TResult>(
  name: string,
  definition: {
    loader?: undefined;
    enabled?: Enabled;
    format: (value: undefined, ctx: ModelRequestContext) => TResult;
  },
): Fragment<Exclude<TResult, Skip>>;
export function fragment(
  name: string,
  definition:
    | {
        loader: Loader<unknown>;
        enabled?: Enabled;
        format: (value: unknown, ctx: ModelRequestContext) => unknown;
      }
    | {
        loader?: undefined;
        enabled?: Enabled;
        format: (value: undefined, ctx: ModelRequestContext) => unknown;
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

/** One named, static part of the system prompt. */
export type SystemPromptPart = { name: string; text: string };

/** The parts of the system prompt, and the fragments of each other field. */
export type ModelRequestLayout = {
  /** Their texts are joined, in order, into the system prompt. */
  systemPrompt: readonly SystemPromptPart[];
  /** Their messages go after the history, in order. */
  messages: readonly Fragment<Message | Message[]>[];
  model: Fragment<ModelSettings>;
};

/** A checked layout. Build it once at startup, and give it to core. */
export type ModelRequestSpec = Readonly<ModelRequestLayout>;

/**
 * Checks a layout and makes the spec that core builds each model request
 * from. It throws on an empty or repeated system prompt part name, on two
 * fragments with one name, on one fragment used twice, and on two loaders
 * with one label. It freezes the system prompt parts.
 *
 * The rules:
 * - Loaders do all of the I/O. Core runs each needed loader once per step.
 * - Fragments are pure. `enabled` and `format` do no I/O, and read no clock
 *   and no random value, so the same inputs give the same request.
 * - Message fragments only append. Their messages go after the history, and
 *   a later step sees them in its history.
 * - The system prompt holds no Conversation data. The host builds its parts
 *   once at startup, so the model provider can cache that part of the
 *   request.
 * - Tools are not in the layout. A Turn's tools are bound to its Actor and
 *   sandbox, and the step gets them separately.
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
 *   format: (notes): Message | Skip =>
 *     notes && notes.length > 0
 *       ? { role: "user", content: notes.join("\n"), timestamp: 0 }
 *       : skip("no memories"),
 * });
 * const settings: ModelSettings = {
 *   id: "anthropic/claude-sonnet-4.5",
 *   reasoning: "low",
 *   privacy: "public",
 * };
 * const spec = defineModelRequest({
 *   systemPrompt: [
 *     { name: "identity", text: "You are Junior, Sentry's Slack bot." },
 *     { name: "personality", text: soul },
 *   ],
 *   messages: [recalled],
 *   model: fragment("model", { format: () => settings }),
 * });
 */
export function defineModelRequest(
  layout: ModelRequestLayout,
): ModelRequestSpec {
  const partNames = new Set<string>();
  for (const { name } of layout.systemPrompt) {
    if (name === "") {
      throw new Error("A system prompt part has no name");
    }
    if (partNames.has(name)) {
      throw new Error(`Two system prompt parts are named "${name}"`);
    }
    partNames.add(name);
  }

  const seenFragments = new Set<Fragment>();
  const names = new Set<string>();
  const loaders = new Map<string, Loader<unknown>>();
  for (const item of [...layout.messages, layout.model]) {
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
    ...layout,
    systemPrompt: Object.freeze(
      layout.systemPrompt.map(({ name, text }) =>
        Object.freeze({ name, text }),
      ),
    ),
  };
}
