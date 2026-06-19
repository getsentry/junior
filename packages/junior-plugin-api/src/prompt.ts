import { z } from "zod";
import type { InvocationContext, Platform, PluginContext } from "./context";
import { pluginJsonValueSchema } from "./json";
import type {
  PluginSessionState,
  PluginSessionStateAppend,
  PluginState,
} from "./state";

const promptContributionIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);

/** Maximum encoded JSON size accepted for one plugin session-state append. */
export const pluginSessionStateValueMaxChars = 4_000;

export const pluginSessionStateKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_:-]{0,63}$/);

export const pluginSessionStateAppendSchema = z
  .object({
    key: pluginSessionStateKeySchema,
    value: pluginJsonValueSchema,
  })
  .strict()
  .superRefine((append, ctx) => {
    const encoded = JSON.stringify(append.value);
    if (
      encoded === undefined ||
      encoded.length > pluginSessionStateValueMaxChars
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Plugin session state value exceeds the maximum encoded size",
        path: ["value"],
      });
    }
  });

export const promptContributionSchema = z
  .object({
    id: promptContributionIdSchema,
    text: z.string().trim().min(1).max(8_000),
  })
  .strict();

export const userPromptContributionResultSchema = z
  .object({
    contributions: z.array(promptContributionSchema).min(1),
    sessionState: z.array(pluginSessionStateAppendSchema).optional(),
  })
  .strict();

/** Small plugin-owned prompt text block rendered by Junior core. */
export type PromptContribution = z.output<typeof promptContributionSchema>;

/** Stable platform context for plugin system prompt guidance. */
export type SystemPromptHookContext = Pick<PluginContext, "log" | "plugin"> & {
  platform: Platform;
};

/** Request-scoped plugin prompt result with optional matching session bookkeeping. */
export interface UserPromptContributionResult {
  contributions: PromptContribution[];
  sessionState?: PluginSessionStateAppend[];
}

/** Runtime facts available while building plugin user prompt context. */
export type UserPromptHookContext = PluginContext &
  InvocationContext & {
    /** True for the first model-visible user prompt in the current session projection. */
    isFirstPrompt: boolean;
    session: PluginSessionState;
    state: PluginState;
    userText: string;
  };
