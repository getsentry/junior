import { z } from "zod";
import type { InvocationContext, Platform, PluginContext } from "./context";
import type { PluginState } from "./state";

const promptContributionIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);

export const promptContributionSchema = z
  .object({
    id: promptContributionIdSchema,
    text: z.string().trim().min(1).max(8_000),
  })
  .strict();

/** Small plugin-owned prompt text block rendered by Junior core. */
export type PromptContribution = z.output<typeof promptContributionSchema>;

/** Stable platform context for plugin system prompt guidance. */
export type SystemPromptHookContext = Pick<PluginContext, "log" | "plugin"> & {
  platform: Platform;
};

/** Runtime facts available while building plugin user prompt context. */
export type UserPromptHookContext = PluginContext &
  InvocationContext & {
    /** True for the first model-visible user prompt in the current session projection. */
    isFirstPrompt: boolean;
    state: PluginState;
    userText: string;
  };
