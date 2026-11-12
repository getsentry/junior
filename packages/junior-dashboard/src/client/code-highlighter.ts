import {
  createBundledHighlighter,
  createSingletonShorthands,
  guessEmbeddedLanguages,
} from "shiki/core";

import { dashboardCodeLanguages } from "./code-languages";

/**
 * Highlight code with the dashboard languages and themes. Themes, grammars,
 * and the engine load in on-demand chunks.
 */
export const { codeToHtml } = createSingletonShorthands(
  createBundledHighlighter({
    langs: dashboardCodeLanguages,
    themes: {
      "github-dark": () => import("shiki/themes/github-dark.mjs"),
      "github-light": () => import("shiki/themes/github-light.mjs"),
    },
    engine: async () => {
      const { createOnigurumaEngine } = await import("shiki/engine/oniguruma");
      return createOnigurumaEngine(import("shiki/wasm"));
    },
  }),
  { guessEmbeddedLanguages },
);
