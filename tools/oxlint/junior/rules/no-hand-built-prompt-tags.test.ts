import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noHandBuiltPromptTagsRule } from "./no-hand-built-prompt-tags.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const handBuiltTag = [{ messageId: "handBuiltTag" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("no-hand-built-prompt-tags", noHandBuiltPromptTagsRule, {
  valid: [
    `renderTag("agent-result", { source: "child_agent" }, [text]);`,
    // Placeholders, prose mentions, and Slack syntax are not tags.
    `program.argument("<id>", "Memory id");`,
    `const usage = "--port <port>";`,
    "const note = `A \\`<inbox-item-answer id>\\` is an answer.`;",
    "const link = `<${url}|${label}>`;",
    "const mention = `<@${userId}>`;",
    `const prompt = "Return the summary inside " + tags + " tags.";`,
    // Searched text belongs to no-prompt-tag-matching.
    `text.includes("</thread-context>");`,
  ],
  invalid: [
    { code: `const close = "</agent-result>";`, errors: handBuiltTag },
    { code: `const close = "&lt;/todo-delta>";`, errors: handBuiltTag },
    { code: `const close = "</INSTRUCTIONS>";`, errors: handBuiltTag },
    {
      code: `const block = ["<runtime>", ...lines, "</runtime>"];`,
      errors: handBuiltTag,
    },
    { code: `const block = "<task>\\nDo it";`, errors: handBuiltTag },
    {
      code: 'const open = `<message index="${index}">`;',
      errors: handBuiltTag,
    },
    {
      code: 'const marker = `<truncated omitted="${count}" />`;',
      errors: handBuiltTag,
    },
    { code: "const close = `\\n</${name}>`;", errors: handBuiltTag },
    { code: "const open = `<${TAG}>`;", errors: handBuiltTag },
  ],
});
