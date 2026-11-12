import type { PluginDecider, PluginModel } from "@sentry/junior-plugin-api";
import { vi } from "vitest";

/** Fake PR description model that returns the description context as the description. */
export function echoDescriptionModel() {
  return {
    completeObject: vi.fn(async ({ prompt }: { prompt: string }) => {
      const context =
        /<description-context[^>]*>\n([\s\S]*)\n<\/description-context>/.exec(
          prompt,
        )?.[1] ?? "";
      return {
        object: {
          body: context
            .replaceAll("&lt;", "<")
            .replaceAll("&gt;", ">")
            .replaceAll("&amp;", "&"),
        },
      };
    }),
  } satisfies PluginModel;
}

/** Fake decision model that picks the first choice, which needs no action in PR description checks. */
export function firstChoiceDecider() {
  return {
    decide: vi.fn(
      async <TChoice extends string>({
        criteria,
      }: {
        criteria: Record<TChoice, string>;
      }) => ({ choice: Object.keys(criteria)[0] as TChoice }),
    ),
  } satisfies PluginDecider;
}
