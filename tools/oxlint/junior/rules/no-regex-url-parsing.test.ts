import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noRegexUrlParsingRule } from "./no-regex-url-parsing.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const noRegexUrl = [{ messageId: "noRegexUrl" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("no-regex-url-parsing", noRegexUrlParsingRule, {
  valid: [
    `new URL(value).protocol === "https:";`,
    `value.startsWith("https://");`,
    `new URLPattern("https://*.example.com/*").test(value);`,
    // Finding URLs in free text needs a global regex.
    `text.match(/https?:\\/\\/[^\\s]+/g);`,
    `new RegExp("https://[^ ]+", "g");`,
    `/^\\/api\\/images\\/[\\w-]+$/.test(path);`,
  ],
  invalid: [
    { code: `/^https?:\\/\\//.test(value);`, errors: noRegexUrl },
    { code: `/^https:\\/\\/api\\.github\\.com\\/(.+)$/;`, errors: noRegexUrl },
    { code: `url.protocol.match(/^https?:$/);`, errors: noRegexUrl },
    { code: `new RegExp("^https://example\\\\.com/");`, errors: noRegexUrl },
  ],
});
