import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { actionlessSuccessToastRule } from "./toast.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const actionless = [{ messageId: "actionless" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run("no-actionless-success", actionlessSuccessToastRule, {
  valid: [
    `toast.add({ actionProps: { children: "Undo", onClick: undo }, title: "Conversation archived", type: "success" });`,
    `add({ title: "Could not rename", type: "error" });`,
    `toast.add({ title: "Automation is still blocked", type: "warning" });`,
    `update(id, { actionProps: undoAction, type: "loading" });`,
    `add({ ...(retry ? { actionProps } : { priority: "high" }), title, type: "success" });`,
    `ids.add(item.id);`,
    `seen.add({ type: "success" }.type);`,
  ],
  invalid: [
    {
      // The answer toast before it was dropped.
      code: `add({ description: row.title, id: answerToastId, title: answerTitle, type: "success" });`,
      errors: actionless,
    },
    {
      code: `toast.add({ title: "Automation saved", description: "Changes apply to future work.", type: "success" });`,
      errors: actionless,
    },
    {
      code: `update(TIP_TOAST_ID, { actionProps: undefined, title: "Push notifications are on", type: "success" });`,
      errors: actionless,
    },
  ],
});
