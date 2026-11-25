import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noSplitUrlQueryRule } from "./no-split-url-query.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const noSplitQuery = [{ messageId: "noSplitQuery" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("no-split-url-query", noSplitUrlQueryRule, {
  valid: [
    `const { pathname, search } = parsePath(path);`,
    `new URL(path, origin).searchParams.get("view");`,
    `identifier.split("#");`,
    // A question mark in text is not a query separator.
    `sentence.lastIndexOf("?");`,
    `text.includes("?");`,
  ],
  invalid: [
    { code: `path.split("?", 1)[0];`, errors: noSplitQuery },
    {
      code: `const [pathname, search = ""] = path.split("?", 2);`,
      errors: noSplitQuery,
    },
    { code: "path.split(`?`);", errors: noSplitQuery },
    { code: `const separator = pathname.indexOf("?");`, errors: noSplitQuery },
  ],
});
