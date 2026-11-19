import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noPromptTagMatchingRule } from "./no-prompt-tag-matching.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tagMatch = [{ messageId: "tagMatch" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("no-prompt-tag-matching", noPromptTagMatchingRule, {
  valid: [
    `findTag(text, "summary")?.body;`,
    `startsWithTag(text, ["agent-result"]);`,
    // Named groups, back references, and Slack syntax are not tags.
    `/^(?<login>[^@]+)@users\\.noreply\\.github\\.com$/;`,
    `/(?<word>\\w+) \\k<word>/;`,
    `/<(https?:[^>|]+)(?:\\|([^>]+))?>/;`,
    `text.startsWith("<https://");`,
    `text.includes("<@U123>");`,
    `/a < b/.test(text);`,
  ],
  invalid: [
    {
      code: `/<summary>([\\s\\S]*?)<\\/summary>/.exec(text);`,
      errors: tagMatch,
    },
    { code: `/<\\/?(?:thread-context|task)\\b/i;`, errors: tagMatch },
    { code: `new RegExp("<current-instruction>");`, errors: tagMatch },
    { code: `text.startsWith("<current-instruction");`, errors: tagMatch },
    { code: `text.indexOf("</INSTRUCTIONS>");`, errors: tagMatch },
    { code: "text.lastIndexOf(`</${name}>`);", errors: tagMatch },
    { code: `text.split("<message>");`, errors: tagMatch },
  ],
});
