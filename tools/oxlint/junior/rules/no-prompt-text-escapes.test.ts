import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noPromptTextEscapesRule } from "./no-prompt-text-escapes.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const localEscape = [{ messageId: "localEscape" }];
const removedHelper = [{ messageId: "removedHelper" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("no-prompt-text-escapes", noPromptTextEscapesRule, {
  valid: [
    `import { escapeTagText } from "@sentry/junior-plugin-api";`,
    `escapeTagText(text);`,
    // Decoding entities from fetched HTML is not an escape.
    `text.replace(/&amp;/g, "&");`,
    `const entities = { "&lt;": "<", "&gt;": ">" };`,
    `text.replaceAll("\\u0000", " ");`,
  ],
  invalid: [
    {
      code: `text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");`,
      errors: [...localEscape, ...localEscape],
    },
    { code: `text.replace(/</g, "&lt;");`, errors: localEscape },
    { code: `const map = { "<": "&lt;" };`, errors: localEscape },
    { code: `import { escapeXml } from "@/chat/xml";`, errors: removedHelper },
    { code: `import { escapeXml } from "./escape";`, errors: removedHelper },
  ],
});
