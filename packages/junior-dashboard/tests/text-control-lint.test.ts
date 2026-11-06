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

tester.run("text-control/no-raw-text-control", noRawTextControlRule, {
  valid: [
    "<Textarea value={text} />",
    "<BareTextarea value={text} />",
    '<Input type="search" />',
    '<input type="file" />',
    "<input type={'checkbox'} />",
    'import { Button } from "@base-ui/react/button";',
  ],
  invalid: [
    { code: "<textarea value={text} />", errors: rawTextControl("textarea") },
    { code: "<input value={text} />", errors: rawTextControl("input") },
    { code: '<input type="email" />', errors: rawTextControl("input") },
    // A dynamic type can be a text type.
    { code: "<input type={kind} />", errors: rawTextControl("input") },
    {
      code: 'import { Input } from "@base-ui/react/input";',
      errors: [{ messageId: "primitiveImport" }],
    },
  ],
});
