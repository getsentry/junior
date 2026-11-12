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

/** Fake decision model that answers yes to every PR note question, so no gaps come back. */
export function noteDecider() {
  return {
    decide: vi.fn(async () => ({ choice: "yes" as never })),
  } satisfies PluginDecider;
}
