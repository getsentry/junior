import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { largeRadiusRule } from "./radius.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const large = [{ messageId: "large" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run("no-large-radius", largeRadiusRule, {
  valid: [
    `const Card = () => <div className="rounded-lg border" />;`,
    `const Button = () => <button className="rounded-md px-3" />;`,
    `const Dot = () => <span className="size-2 rounded-full" />;`,
    `const card = "before:rounded-[inherit] rounded-b-none";`,
    `const label = "Corners use rounded-lg.".length;`,
    `const name = "xl-rounded";`,
  ],
  invalid: [
    {
      code: `const Row = () => <li className="rounded-xl border" />;`,
      errors: large,
    },
    { code: `const fab = "grid size-14 rounded-2xl";`, errors: large },
    { code: `const tab = "rounded-[0.625rem] px-3";`, errors: large },
    {
      code: "const sheet = `data-[open]:rounded-t-xl ${base}`;",
      errors: large,
    },
    { code: `const corner = "hover:rounded-tl-3xl";`, errors: large },
  ],
});
