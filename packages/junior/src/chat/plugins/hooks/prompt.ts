/** Plugin hooks that add to the prompt and format Markdown. */
import {
  type PromptHistoryMessage,
  promptContextSchema,
  promptMessageSchema,
} from "@sentry/junior-plugin-api";
import { getConfigDefaults } from "@/chat/configuration/defaults";
import { logWarn } from "@/chat/logging";
import {
  pluginConfigValues,
  withPluginHookSpan,
} from "@/chat/plugins/hook-context";
import { runPluginHooksAtOnce } from "@/chat/plugins/hook-runner";
import {
  PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS,
  toPromptContributionContext,
  type PluginPromptContributionContext,
} from "@/chat/plugins/prompt";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import * as z from "zod";
import { coreRegistrations } from "@/chat/plugins/core-registrations";
import { invocationPluginContext, safeErrorMessage } from "./context";
import { getPlugins } from "./registry";

const PLUGIN_PROMPT_CONTEXT_MAX_BYTES = 8_000;

const MISSING_CONTEXT_TEXT =
  "The context of this plugin could not load for this Turn.";

const PLUGIN_PROMPT_CONTEXT_TOTAL_MAX_BYTES = 16_000;
const promptContextContentSchema = z.record(z.string(), z.unknown());

function normalizePromptContext(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > PLUGIN_PROMPT_CONTEXT_MAX_BYTES
  ) {
    throw new TypeError("Plugin prompt context exceeded its serialized budget");
  }
  const parsed = promptContextContentSchema.safeParse(JSON.parse(serialized));
  if (!parsed.success) {
    throw new TypeError("Plugin prompt context must be a JSON object");
  }
  return parsed.data;
}

function toUserPromptContributionContext(args: {
  index: number;
  pluginName: string;
  value: unknown;
}): PluginPromptContributionContext | undefined {
  const message = promptMessageSchema.safeParse(args.value);
  if (message.success) {
    return toPromptContributionContext({
      hookName: "userPrompt",
      index: args.index,
      message: message.data,
      pluginName: args.pluginName,
    });
  }
  const { value } = args;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("renderPrompt" in value) ||
    typeof value.renderPrompt !== "function"
  ) {
    return undefined;
  }
  const context = promptContextSchema.safeParse(
    "context" in value ? value.context : undefined,
  );
  if (!context.success) {
    return undefined;
  }
  // Call it on its object: plugins may write renderPrompt as a method that
  // reads `this`.
  const rendered: unknown = value.renderPrompt.call(value);
  const text = promptMessageSchema.safeParse({ text: rendered });
  if (!text.success) {
    return undefined;
  }
  return {
    id: `userPrompt:${args.index}`,
    pluginName: args.pluginName,
    text: text.data.text,
    context: {
      content: normalizePromptContext(context.data.content),
      kind: context.data.kind,
      loadedAtMs: Date.now(),
      pluginName: args.pluginName,
      version: context.data.version,
    },
  };
}

function logInvalidPromptContributions(args: {
  hookName: "systemPrompt" | "userPrompt";
  pluginName: string;
}): void {
  logWarn("plugin.prompt.contribution_result.invalid", {
    "app.plugin.hook": args.hookName,
    "app.plugin.name": args.pluginName,
    "app.plugin.validation_reason": "invalid_shape",
  });
}

/** Conversation facts that plugin Markdown rewrites may use. */
export interface PluginMarkdownFormat {
  /** Config values by full key. Install defaults fill keys it does not set. */
  configuration?: Record<string, unknown> | undefined;
  /** Slack mentions of known people, by lowercase `provider:handle`. */
  mentions?: ReadonlyMap<string, string> | undefined;
  /** Where the text shows. Defaults to Slack. */
  platform?: "slack" | "web";
  /** The provider that wrote the text or that it went to. */
  provider?: string;
}

/** Apply plugin Markdown rewrites before destination delivery formatting. */
export function applyPluginFormatMarkdown(
  text: string,
  format: PluginMarkdownFormat = {},
): string {
  const resolved = { ...getConfigDefaults(), ...format.configuration };
  const platform = format.platform ?? "slack";
  const mention = ({
    provider,
    handle,
  }: {
    provider: string;
    handle: string;
  }) =>
    platform === "slack"
      ? format.mentions?.get(`${provider}:${handle}`.toLowerCase())
      : undefined;
  let transformed = text;
  for (const plugin of getPlugins()) {
    const hook = plugin.hooks?.formatMarkdown;
    if (!hook) {
      continue;
    }
    try {
      const next = hook({
        config: pluginConfigValues(plugin.manifest.name, resolved),
        mention,
        platform,
        ...(format.provider ? { provider: format.provider } : undefined),
        text: transformed,
      });
      if (typeof next === "string") {
        transformed = next;
      }
    } catch (error) {
      // Fail open: reply delivery must not depend on optional provider formatting.
      logWarn("plugin.format_markdown.hook.failed", {
        "app.plugin.name": plugin.manifest.name,
        "exception.message": safeErrorMessage(error),
      });
    }
  }
  return transformed;
}

// Say that a plugin's Turn context is missing, so the model does not take
// its absence as no state.
function missingContextNote(
  pluginName: string,
): PluginPromptContributionContext {
  return toPromptContributionContext({
    hookName: "userPrompt",
    index: 0,
    message: { text: MISSING_CONTEXT_TEXT },
    pluginName,
  });
}

/** Collect request-scoped plugin prompt contributions. */
export async function getPluginUserPromptContributions(args: {
  context: Pick<
    ToolRuntimeContext,
    | "conversationId"
    | "locationId"
    | "destination"
    | "actor"
    | "resolveActorIdentity"
    | "source"
    | "userText"
  >;
  /** Read the model history that the prompt replays, for one plugin. */
  historyMessages?: (pluginName: string) => PromptHistoryMessage[];
  turnId?: string;
}): Promise<PluginPromptContributionContext[]> {
  const { historyMessages } = args;
  const contributions: PluginPromptContributionContext[] = [];
  let totalChars = 0;
  let totalContextBytes = 0;
  // Core registrations go first, so app plugins cannot use up the shared
  // budget before them.
  const registrations = [...coreRegistrations(), ...getPlugins()];
  const outcomes = await runPluginHooksAtOnce(registrations, (plugin) => {
    const hook = plugin.hooks?.userPrompt;
    return (
      hook &&
      (() =>
        withPluginHookSpan(
          plugin.manifest.name,
          "userPrompt",
          async (setSpanAttributes) =>
            await hook({
              ...invocationPluginContext(
                plugin,
                args.context,
                setSpanAttributes,
                args.turnId,
              ),
              ...(historyMessages
                ? {
                    historyMessages: () =>
                      historyMessages(plugin.manifest.name),
                  }
                : undefined),
            }),
        ))
    );
  });
  for (const outcome of outcomes) {
    const pluginName = outcome.plugin.manifest.name;
    try {
      if ("error" in outcome) throw outcome.error;
      const rawResult = outcome.value;
      if (rawResult === undefined) {
        continue;
      }
      if (!Array.isArray(rawResult)) {
        logInvalidPromptContributions({
          hookName: "userPrompt",
          pluginName,
        });
        continue;
      }

      const acceptedContributions = rawResult.map((value, index) =>
        toUserPromptContributionContext({ index, pluginName, value }),
      );
      if (acceptedContributions.some((contribution) => !contribution)) {
        logInvalidPromptContributions({
          hookName: "userPrompt",
          pluginName,
        });
        continue;
      }
      const validContributions = acceptedContributions.filter(
        (contribution): contribution is PluginPromptContributionContext =>
          contribution !== undefined,
      );
      const pluginContributionChars = validContributions.reduce(
        (sum, contribution) => sum + contribution.text.length,
        0,
      );
      const pluginContextBytes = validContributions.reduce(
        (sum, contribution) =>
          sum +
          (contribution.context
            ? Buffer.byteLength(
                JSON.stringify(contribution.context.content),
                "utf8",
              )
            : 0),
        0,
      );
      if (
        totalChars + pluginContributionChars >
          PLUGIN_PROMPT_CONTRIBUTION_TOTAL_MAX_CHARS ||
        totalContextBytes + pluginContextBytes >
          PLUGIN_PROMPT_CONTEXT_TOTAL_MAX_BYTES
      ) {
        logWarn("plugin.user_prompt.contribution_budget_exceeded", {
          "app.plugin.name": pluginName,
        });
        contributions.push(missingContextNote(pluginName));
        continue;
      }
      totalChars += pluginContributionChars;
      totalContextBytes += pluginContextBytes;
      contributions.push(...validContributions);
    } catch (error) {
      logWarn("plugin.user_prompt.hook.failed", {
        "app.plugin.name": pluginName,
        "exception.message": safeErrorMessage(error),
      });
      contributions.push(missingContextNote(pluginName));
    }
  }
  return contributions;
}
