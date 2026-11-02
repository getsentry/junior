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
    "<p>{format(message.text)}</p>",
  ],
  invalid: [
    // The queued message bar regression rendered the raw string.
    {
      code: 'const text = message.text ?? ""; <p>{text}</p>;',
      errors: [{ messageId: "rawDisplayText", data: { name: "text" } }],
    },
    {
      code: "<li>{item?.preview ?? item.body}</li>",
      errors: [{ messageId: "rawDisplayText", data: { name: "preview" } }],
    },
    {
      code: "<>{open ? watch.intent : null}</>",
      errors: [{ messageId: "rawDisplayText", data: { name: "intent" } }],
    },
  ],
});
