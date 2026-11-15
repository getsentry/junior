import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noRawTimeFormatRule } from "./time-format.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const rawTimeFormat = [{ messageId: "rawTimeFormat" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run("no-raw-time-format", noRawTimeFormatRule, {
  valid: [
    `const label = formatTime(value, { month: "short" });`,
    "const parts = dateTimeFormat({ timeZone }).formatToParts(time);",
    // Numbers are not time labels.
    `const count = total.toLocaleString("en-US");`,
    `const total = new Intl.NumberFormat("en-US").format(count);`,
  ],
  invalid: [
    {
      code: `const label = new Intl.DateTimeFormat(undefined, { month: "short" }).format(time);`,
      errors: rawTimeFormat,
    },
    {
      code: "const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;",
      errors: rawTimeFormat,
    },
    {
      code: `const label = new Intl.RelativeTimeFormat("en-US").format(-1, "day");`,
      errors: rawTimeFormat,
    },
    {
      code: `const label = new Intl.DurationFormat("en-US").format({ hours: 1 });`,
      errors: rawTimeFormat,
    },
    { code: "const day = date.toLocaleDateString();", errors: rawTimeFormat },
    {
      code: `const clock = date.toLocaleTimeString(undefined, { hour: "numeric" });`,
      errors: rawTimeFormat,
    },
  ],
});
