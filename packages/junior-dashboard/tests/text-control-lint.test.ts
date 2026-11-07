import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noRawTextControlRule } from "../oxlint/text-control";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

const rawTextControl = (name: string) => [
  { messageId: "rawTextControl", data: { name } },
];

// Plain case names keep JSX out of the JUnit report. Its XML parser has an
// entity limit that escaped `<` and `"` in test names can pass.
tester.run("text-control/no-raw-text-control", noRawTextControlRule, {
  valid: [
    { name: "Textarea", code: "<Textarea value={text} />" },
    { name: "BareTextarea", code: "<BareTextarea value={text} />" },
    { name: "Input", code: '<Input type="search" />' },
    { name: "file input", code: '<input type="file" />' },
    { name: "checkbox expression type", code: "<input type={'checkbox'} />" },
    {
      name: "other Base UI import",
      code: 'import { Button } from "@base-ui/react/button";',
    },
  ],
  invalid: [
    {
      name: "raw textarea",
      code: "<textarea value={text} />",
      errors: rawTextControl("textarea"),
    },
    {
      name: "input without type",
      code: "<input value={text} />",
      errors: rawTextControl("input"),
    },
    {
      name: "email input",
      code: '<input type="email" />',
      errors: rawTextControl("input"),
    },
    {
      name: "dynamic input type",
      code: "<input type={kind} />",
      errors: rawTextControl("input"),
    },
    {
      name: "Base UI input import",
      code: 'import { Input } from "@base-ui/react/input";',
      errors: [{ messageId: "primitiveImport" }],
    },
  ],
});
