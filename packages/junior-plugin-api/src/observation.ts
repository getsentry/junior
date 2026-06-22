import type {
  Destination,
  PluginContext,
  PluginEmbedder,
  PluginModel,
  Requester,
  Source,
} from "./context";
import type { PluginState } from "./state";

/** Delivered turn text and runtime context available to post-turn plugin hooks. */
export interface TurnObservationContext extends Pick<
  PluginContext,
  "db" | "log" | "plugin"
> {
  assistantText: string;
  conversationId?: string;
  destination?: Destination;
  embedder: PluginEmbedder;
  model: PluginModel;
  requester?: Requester;
  source: Source;
  state: PluginState;
  toolCalls: string[];
  turnId: string;
  userText: string;
}
