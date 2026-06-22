import type {
  InvocationContext,
  PluginContext,
  PluginEmbedder,
  PluginModel,
} from "./context";
import type { PluginState } from "./state";

/** Delivered turn text and runtime context available to post-turn plugin hooks. */
export type TurnObservationContext = Pick<
  PluginContext,
  "db" | "log" | "plugin"
> &
  InvocationContext & {
    assistantText: string;
    embedder: PluginEmbedder;
    model: PluginModel;
    state: PluginState;
    toolCalls: string[];
    turnId: string;
    userText: string;
  };
