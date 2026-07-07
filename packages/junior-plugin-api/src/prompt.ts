import { z } from "zod";
import type {
  Destination,
  Platform,
  PluginContext,
  PluginEmbedder,
  Actor,
  Source,
} from "./context";
import type { PluginState } from "./state";

export const promptMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(8_000),
  })
  .strict();

/** Small plugin-owned prompt text block rendered by Junior core. */
export type PromptMessage = z.output<typeof promptMessageSchema>;

/** Stable platform context for plugin system prompt guidance. */
export type SystemPromptContext = Pick<
  PluginContext,
  "db" | "log" | "plugin"
> & {
  platform: Platform;
};

/** Runtime facts available while building plugin user prompt context. */
export type UserPromptContext = Pick<PluginContext, "db" | "log" | "plugin"> & {
  conversationId?: string;
  destination: Destination;
  embedder: PluginEmbedder;
  actor?: Actor;
  source: Source;
  state: PluginState;
  text: string;
};
