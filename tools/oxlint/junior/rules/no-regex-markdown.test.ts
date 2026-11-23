import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noRegexMarkdownRule } from "./no-regex-markdown.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const noRegexMarkdown = [{ messageId: "noRegexMarkdown" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("no-regex-markdown", noRegexMarkdownRule, {
  valid: [
    `text.replace(/\\s+/g, " ");`,
    `/^[a-z0-9_-]+$/i.test(slug);`,
    `value.replace(/[*]/g, "");`,
    `new RegExp("[_-]", "g");`,
  ],
  invalid: [
    {
      code: "text.replace(/```[\\s\\S]*?```/g, ' ');",
      errors: noRegexMarkdown,
    },
    { code: "text.replace(/`{3}[^`]*`{3}/g, '');", errors: noRegexMarkdown },
    {
      code: `text.replace(/\\[([^\\]]+)\\]\\([^)]*\\)/g, "$1");`,
      errors: noRegexMarkdown,
    },
    { code: "text.replace(/[`*_~>#|]/g, '');", errors: noRegexMarkdown },
    { code: `new RegExp("[*_~]", "g");`, errors: noRegexMarkdown },
  ],
});
