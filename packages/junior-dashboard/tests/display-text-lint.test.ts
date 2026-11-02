import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noRawDisplayTextRule } from "../oxlint/display-text";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

tester.run("display-text/no-raw-display-text", noRawDisplayTextRule, {
  valid: [
    "<DisplayText inline mentions={mentions} text={message.text} />",
    "<p title={text}>{message.label}</p>",
    // Component inputs: the caller decides how to render them.
    "function Chip(props: { text: string }) { return <text>{props.text}</text>; }",
    "function Leaf({ text }: { text: string }) { return <>{text}</>; }",
    // Locals that do not read a display-text field.
    "function Row() { const summary = countLabel(rows); const body = open ? <div /> : null; return <p>{summary}{body}</p>; }",
  ],
  invalid: [
    // The queued message bar regression rendered the raw string.
    {
      code: 'function Row(props: { message: Message }) { const text = props.message.text ?? ""; return <p>{text}</p>; }',
      errors: [{ messageId: "rawDisplayText", data: { name: "text" } }],
    },
    {
      code: "function Row({ item }: { item: Item }) { const { preview } = item; return <li>{open ? preview : null}</li>; }",
      errors: [{ messageId: "rawDisplayText", data: { name: "preview" } }],
    },
  ],
});
