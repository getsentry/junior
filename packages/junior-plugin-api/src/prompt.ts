import type { InvocationContext, PluginContext } from "./context";
import type {
  PluginSessionState,
  PluginSessionStateAppend,
  PluginState,
} from "./state";

export interface UserPromptContribution {
  id: string;
  text: string;
}

export interface UserPromptContributionResult {
  contributions?: UserPromptContribution[];
  sessionState?: PluginSessionStateAppend[];
}

export type UserPromptHookContext = PluginContext &
  InvocationContext & {
    isFirstPrompt: boolean;
    session: PluginSessionState;
    state: PluginState;
    userText: string;
  };

export interface PluginTaskEnqueueOptions {
  idempotencyKey: string;
  name: string;
  payload?: unknown;
}

export interface PluginTaskEnqueueResult {
  id: string;
  status: "created" | "already_exists";
}

export interface PluginTaskQueue {
  enqueue(options: PluginTaskEnqueueOptions): Promise<PluginTaskEnqueueResult>;
}

export type TurnObservationHookContext = PluginContext &
  InvocationContext & {
    observationId: string;
    tasks: PluginTaskQueue;
  };

export interface PluginTaskContext extends PluginContext {
  id: string;
  name: string;
  observation?: {
    load(): Promise<unknown | undefined>;
  };
  payload?: unknown;
  state: PluginState;
}

export type PluginTaskHandler = (
  ctx: PluginTaskContext,
) => Promise<void> | void;
