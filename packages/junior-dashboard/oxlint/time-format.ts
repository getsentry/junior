import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";

const INTL_TIME_FORMATS = new Set([
  "DateTimeFormat",
  "DurationFormat",
  "RelativeTimeFormat",
]);
const DATE_LOCALE_METHODS = new Set([
  "toLocaleDateString",
  "toLocaleTimeString",
]);

/**
 * Keep dashboard time labels in one module. Raw Intl time formatters and Date
 * locale methods use the browser locale, but the dashboard UI is English only.
 */
export const noRawTimeFormatRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Format dashboard dates, times, and durations with client/time.ts.",
    },
    messages: {
      rawTimeFormat:
        "Format dates, times, and durations with client/time.ts, not `{{name}}`. It keeps every label in English and in the dashboard timezone.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (node.computed || node.property.type !== "Identifier") return;
        const property = node.property.name;
        const isIntlFormat =
          node.object.type === "Identifier" &&
          node.object.name === "Intl" &&
          INTL_TIME_FORMATS.has(property);
        if (!isIntlFormat && !DATE_LOCALE_METHODS.has(property)) return;
        context.report({
          node,
          messageId: "rawTimeFormat",
          data: { name: isIntlFormat ? `Intl.${property}` : property },
        });
      },
    };
  },
});

/** Dashboard Oxlint rule that routes time formatting through client/time.ts. */
export default eslintCompatPlugin({
  meta: { name: "time-format" },
  rules: { "no-raw-time-format": noRawTimeFormatRule },
});
