/**
 * Web fetch and search tool deps recorded and replayed through vitest-evals.
 */
import { executeWithReplay } from "vitest-evals/replay";
import { type JsonValue } from "vitest-evals/harness";
import { botConfig } from "@/chat/config";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { DEFAULT_MAX_CHARS, MAX_FETCH_CHARS } from "@/chat/tools/web/constants";
import { truncateWebFetchContent } from "@/chat/tools/web/fetch-content";
import { createWebFetchTool } from "@/chat/tools/web/fetch-tool";
import { createWebSearchTool } from "@/chat/tools/web/search";
import type {
  ToolHooks,
  WebFetchToolDeps,
  WebSearchToolDeps,
} from "@/chat/tools/types";

/** Wrap webFetch with vitest-evals replay so recorded pages replace live fetches. */
export function createReplayWebFetchDeps(
  baseOverrides: ToolHooks["toolOverrides"],
): WebFetchToolDeps {
  const liveTool = createWebFetchTool({ toolOverrides: {} });

  return {
    execute: async (input) => {
      const requestedMaxChars = input.max_chars ?? DEFAULT_MAX_CHARS;
      const args: Record<string, JsonValue> = {
        url: input.url,
        max_chars: MAX_FETCH_CHARS,
      };

      const { result } = await executeWithReplay({
        toolName: "webFetch",
        args,
        context: null,
        execute: async (replayArgs) => {
          const url = replayArgs.url;
          const maxChars = replayArgs.max_chars;
          if (typeof url !== "string") {
            throw new Error("webFetch replay args missing url");
          }
          const input = {
            url,
            ...(typeof maxChars === "number" ? { max_chars: maxChars } : {}),
          };
          const output = baseOverrides?.webFetch?.execute
            ? await baseOverrides.webFetch.execute(input)
            : await liveTool.execute!(input, {
                experimental_context: undefined,
              });
          return output as JsonValue;
        },
        replay: {
          version: "web-fetch-v2",
          key: (replayArgs) => ({
            url: replayArgs.url,
          }),
        },
      });
      const parsed = juniorToolOutputSchema.parse(result);
      if (typeof parsed.content !== "string") {
        return parsed;
      }
      const limited = truncateWebFetchContent(
        parsed.content,
        requestedMaxChars,
      );
      return {
        ...parsed,
        content: limited.content,
        truncated: parsed.truncated === true || limited.truncated,
      };
    },
  };
}

/** Wrap webSearch with vitest-evals replay so recorded results replace live searches. */
export function createReplayWebSearchDeps(
  baseOverrides: ToolHooks["toolOverrides"],
): WebSearchToolDeps {
  const liveTool = createWebSearchTool(botConfig.webSearchModelId, {
    execute: baseOverrides?.webSearch?.execute,
  });

  return {
    execute: async (input) => {
      const args: Record<string, JsonValue> = { query: input.query };
      if (input.max_results !== undefined) {
        args.max_results = input.max_results;
      }

      const { result } = await executeWithReplay({
        toolName: "webSearch",
        args,
        context: null,
        execute: async (replayArgs) => {
          const query = replayArgs.query;
          const maxResults = replayArgs.max_results;
          if (typeof query !== "string") {
            throw new Error("webSearch replay args missing query");
          }
          const output = await liveTool.execute!(
            {
              query,
              ...(typeof maxResults === "number"
                ? { max_results: maxResults }
                : {}),
            },
            { experimental_context: undefined },
          );
          return output as JsonValue;
        },
        replay: {
          version: "web-search-v1",
          key: (replayArgs) => ({
            query: replayArgs.query,
            max_results: replayArgs.max_results ?? null,
          }),
        },
      });
      return juniorToolOutputSchema.parse(result);
    },
  };
}
