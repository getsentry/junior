// The API that host code uses to declare how core builds each model request.
// A loader gets data from outside the request, such as a file, a database row
// or a service. A fragment formats a loader's value into one piece of the
// request. `defineModelRequest` lists, for each field of the request, the
// fragments that go into that field, in order.
//
// The rules:
// - Loaders do all the I/O. Core runs each loader at most once per step, and
//   a `deployment` loader once per spec.
// - Fragments are pure. `enabled` and `format` do no I/O and read no clock
//   and no random value, so the same inputs give the same request.
// - Message fragments only append. Their messages go after the history, and a
//   later step sees them in its history.
// - `systemPrompt` and `tools` fragments must not change between steps, so
//   the model provider can cache that part of the request. The types allow
//   them only `deployment` loaders, and no `enabled` or context in `format`.
import type { Message } from "@earendil-works/pi-ai";
import type { ModelSettings } from "@/core/model/client";
import type { ToolDefinition } from "@/core/tool";
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

/**
 * How long a loader's value stays valid. `deployment`: core loads it once per
 * spec and uses it for every step. `step`: core loads it again for each step.
 */
export type LoaderLifetime = "deployment" | "step";

/** Keeps the `step` values of one request. Core makes one for each request. */
export type StepValues = { readonly ctx: ModelRequestContext };

/**
 * Where core keeps loaded values: on the spec for `deployment` values, and on
 * the request's `StepValues` for `step` values.
 */
export type LoadedValueKeys = {
  deployment: ModelRequestSpec;
  step: StepValues;
};

/** A source of data for fragments. Make one with `loader`. */
export type Loader<T, L extends LoaderLifetime = LoaderLifetime> = {
  readonly label: string;
  readonly lifetime: L;
  readonly timeoutMs: number;
  /** When true, a failed or timed-out load gives `undefined`. */
  readonly optional: boolean;
  readonly load: (ctx: ModelRequestContext, signal: AbortSignal) => Promise<T>;
  /**
   * Core calls this. It runs `load` and keeps the value for this loader's
   * lifetime, unless `signal` aborts first.
   */
  readonly loadInto: (
    keys: LoadedValueKeys,
    signal: AbortSignal,
  ) => Promise<void>;
  /** Core calls this. True when a value is kept for this loader's lifetime. */
  readonly has: (keys: LoadedValueKeys) => boolean;
  /**
   * Core calls this. The kept value. With no value, an optional loader gives
   * `undefined`, and a required one throws.
   */
  readonly valueIn: (keys: LoadedValueKeys) => T;
};

type LoaderOptions<L extends LoaderLifetime> = {
  lifetime: L;
  /** Core aborts `signal` and stops waiting for the load after this time. */
  timeoutMs: number;
  /**
   * When true, a failed or timed-out load gives `undefined`, and the request
   * is built without it. Otherwise the failure stops the step.
   */
  optional?: boolean;
};

/**
 * Declares a loader. `label` names it in diagnostics and errors, and must be
 * unique in a spec. `load` does the I/O, and stops when `signal` aborts.
 */
export function loader<T, L extends LoaderLifetime>(
  label: string,
  load: (ctx: ModelRequestContext, signal: AbortSignal) => Promise<T>,
  options: LoaderOptions<L> & { optional: true },
): Loader<T | undefined, L>;
export function loader<T, L extends LoaderLifetime>(
  label: string,
  load: (ctx: ModelRequestContext, signal: AbortSignal) => Promise<T>,
  options: LoaderOptions<L> & { optional?: false },
): Loader<T, L>;
export function loader<T, L extends LoaderLifetime>(
  label: string,
  load: (ctx: ModelRequestContext, signal: AbortSignal) => Promise<T>,
  options: LoaderOptions<L>,
): Loader<T, L> | Loader<T | undefined, L> {
  if (options.optional) {
    return buildLoader<T | undefined, L>(label, load, options, () => undefined);
  }
  return buildLoader<T, L>(label, load, options, () => {
    throw new Error(`Loader "${label}" has no value`);
  });
}

function buildLoader<T, L extends LoaderLifetime>(
  label: string,
  load: (ctx: ModelRequestContext, signal: AbortSignal) => Promise<T>,
  { lifetime, timeoutMs, optional = false }: LoaderOptions<L>,
  missing: () => T,
): Loader<T, L> {
  // Weak keys, so the values go away with their spec or request.
  const values = new WeakMap<LoadedValueKeys[L], { value: T }>();
  return {
    label,
    lifetime,
    timeoutMs,
    optional,
    load,
    loadInto: async (keys, signal) => {
      const value = await load(keys.step.ctx, signal);
      if (!signal.aborted) {
        values.set(keys[lifetime], { value });
      }
    },
    has: (keys) => values.has(keys[lifetime]),
    valueIn: (keys) => {
      const kept = values.get(keys[lifetime]);
      return kept ? kept.value : missing();
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

type Format = (value: never, ctx: ModelRequestContext) => unknown;

/**
 * One piece of a model request. Make one with `fragment`. The type keeps the
 * exact `format` and `enabled`, so `defineModelRequest` can check where the
 * fragment may go.
 */
export type Fragment<
  TLifetime extends LoaderLifetime = LoaderLifetime,
  TEnabled extends Enabled | undefined = Enabled | undefined,
  TFormat extends Format = Format,
> = {
  readonly name: string;
  readonly loader?: Loader<unknown, TLifetime>;
  readonly enabled?: TEnabled;
  readonly format: TFormat;
  /** Core calls this. It runs `format` on the loader's kept value. */
  readonly render: (keys: LoadedValueKeys) => ReturnType<TFormat>;
};

/**
 * Declares a fragment. `name` names it in diagnostics, and must be unique in
 * a spec. `format` turns the loader's value into the fragment's output, or
 * returns `skip(reason)`. `enabled` returning false leaves the fragment out,
 * and core does not run its loader for it.
 */
export function fragment<
  T,
  L extends LoaderLifetime,
  TFormat extends (value: T, ctx: ModelRequestContext) => unknown,
  TEnabled extends Enabled | undefined = undefined,
>(
  name: string,
  definition: { loader: Loader<T, L>; enabled?: TEnabled; format: TFormat },
): Fragment<L, TEnabled, TFormat>;
export function fragment<
  TFormat extends (value: undefined, ctx: ModelRequestContext) => unknown,
  TEnabled extends Enabled | undefined = undefined,
>(
  name: string,
  definition: { loader?: undefined; enabled?: TEnabled; format: TFormat },
): Fragment<never, TEnabled, TFormat>;
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
  if (definition.loader) {
    const { loader: source, format } = definition;
    return {
      name,
      ...definition,
      render: (keys) => format(source.valueIn(keys), keys.step.ctx),
    };
  }
  const { format } = definition;
  return {
    name,
    ...definition,
    render: (keys) => format(undefined, keys.step.ctx),
  };
}

/**
 * A fragment that gives the same output at every step: a `deployment` loader
 * or none, no `enabled`, and a `format` that reads only its value.
 */
type StableFragment<TOutput> = Fragment<
  "deployment",
  undefined,
  (value: never) => TOutput | Skip
>;

/** A fragment whose output goes into a field of type `TOutput`. */
type FieldFragment<TOutput> = Fragment<
  LoaderLifetime,
  Enabled | undefined,
  (value: never, ctx: ModelRequestContext) => TOutput | Skip
>;

/** The fragments of each field of the model request, in order. */
export type ModelRequestLayout = {
  /** Their outputs are joined, in order, into the system prompt. */
  systemPrompt: StableFragment<string>[];
  tools: StableFragment<ToolDefinition[]>[];
  /** Their messages go after the history, in order. */
  messages: FieldFragment<Message | Message[]>[];
  model: FieldFragment<ModelSettings>;
};

/**
 * A checked layout. Build it once, and give it to core for every step: core
 * keeps `deployment` values for as long as the spec lives.
 */
export type ModelRequestSpec = Readonly<ModelRequestLayout>;

/**
 * Checks a layout and makes the spec that core builds each model request
 * from. It throws on two fragments with one name, on one fragment used twice,
 * and on two loaders with one label.
 */
export function defineModelRequest(
  layout: ModelRequestLayout,
): ModelRequestSpec {
  const fragments: Fragment[] = [
    ...layout.systemPrompt,
    ...layout.tools,
    ...layout.messages,
    layout.model,
  ];
  const seenFragments = new Set<Fragment>();
  const names = new Set<string>();
  const loaders = new Map<string, Loader<unknown>>();
  for (const item of fragments) {
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
  // A new object, because core keeps `deployment` values per spec.
  return { ...layout };
}
