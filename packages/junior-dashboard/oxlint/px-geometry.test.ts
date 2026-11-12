import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { pxConstantSizesElementRule } from "./px-geometry.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const unbacked = [{ messageId: "unbacked" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run("px-constant-sizes-element", pxConstantSizesElementRule, {
  valid: [
    // The class pins the items to the px size that the math uses.
    `const ITEM_PX = 8;
     const index = (y: number) => y / ITEM_PX;
     const Item = () => <button className="h-[8px] w-6" />;`,
    // The style sizes the element with the constant.
    `const BAR_PX = { base: 6, max: 24 };
     const scale = (width: number) => width / BAR_PX.max;
     const Bar = () => <span style={{ width: BAR_PX.max }} />;`,
    // Additive offsets do not map positions to elements.
    `const MARGIN_PX = 12;
     const top = (y: number) => y - MARGIN_PX;
     const Row = () => <div className="p-3" />;`,
    // Constants without the px suffix are not geometry.
    `const PAGE_SIZE = 25;
     const offset = (page: number) => page * PAGE_SIZE;`,
  ],
  invalid: [
    // The #3238 bug: the math uses 8px, but `h-2` is 0.5rem.
    {
      code: `const ITEM_PX = 8;
             const index = (y: number) => y / ITEM_PX;
             const Item = () => <button className="h-2 w-6" />;`,
      errors: unbacked,
    },
    {
      code: `const ITEM_PX = 8;
             const top = (index: number) => index * ITEM_PX;
             const Item = () => <button className="h-[10px]" />;`,
      errors: unbacked,
    },
    {
      code: `export const BAR_PX = { base: 6, max: 24 } as const;
             const scale = (width: number) => width / BAR_PX.max;
             const Bar = () => <span className="w-6" />;`,
      errors: unbacked,
    },
  ],
});
