import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { RuleTester } from "oxlint/plugins-dev";

import { noRegexMarkdownRule } from "./no-regex-markdown.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const noRegexMarkdown = [{ messageId: "noRegexMarkdown" }];
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const legacy = {
  filename: path.join(REPO_ROOT, "packages/junior/src/legacy.ts"),
  options: [{ baseline: { "packages/junior/src/legacy.ts": 1 } }],
};

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("no-regex-markdown", noRegexMarkdownRule, {
  valid: [
    `text.replace(/\\s+/g, " ");`,
    `/^[a-z0-9_-]+$/i.test(slug);`,
    `value.replace(/[*]/g, "");`,
    `new RegExp("[_-]", "g");`,
    // A baseline file keeps the regexes it had.
    {
      code: "text.replace(/[*_~]/g, '');",
      ...legacy,
    },
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
    // It cannot add one.
    {
      code: "text.replace(/[*_~]/g, '').replace(/```/g, '');",
      ...legacy,
      errors: [...noRegexMarkdown, ...noRegexMarkdown],
    },
  ],
});
