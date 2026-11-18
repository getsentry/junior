import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

// `rounded-xl` and up, on any side or corner and behind any variant, or an
// arbitrary radius. `rounded-[inherit]` follows a parent, so it stays.
const LARGE_RADIUS =
  /(?<![\w-])(?:[^\s:]+:)*-?rounded(?:-(?:t|b|l|r|s|e|tl|tr|bl|br|ss|se|es|ee))?-(?:[2-4]?xl|\[(?!inherit\])[^\]]*\])(?![\w-])/;

/**
 * Keep the classic radii in the new UI: `rounded-lg` for cards, rows, and
 * panels, and `rounded-md` for buttons, tabs, inputs, and icon tiles. Both
 * UIs share these radii, so the new UI cannot drift into rounder shapes.
 */
export const largeRadiusRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Use the classic radii, `rounded-lg` and `rounded-md`, not larger or arbitrary radii.",
    },
    messages: {
      large:
        "`{{found}}` is rounder than the classic UI. Use `rounded-lg` for a card, row, or panel and `rounded-md` for a control, or a shared class from `client/styles.ts`, so both UIs keep one style.",
    },
  },
  create(context) {
    const report = (node: ESTree.Node, text: string) => {
      const match = LARGE_RADIUS.exec(text);
      if (match) {
        context.report({ node, messageId: "large", data: { found: match[0] } });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") report(node, node.value);
      },
      TemplateElement(node: ESTree.TemplateElement) {
        report(node, node.value.raw);
      },
    };
  },
});

/** Dashboard Oxlint rules that keep the new UI on the classic shapes. */
export default eslintCompatPlugin({
  meta: { name: "radius" },
  rules: { "no-large-radius": largeRadiusRule },
});
