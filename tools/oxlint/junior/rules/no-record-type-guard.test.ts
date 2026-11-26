import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noRecordTypeGuardRule } from "./no-record-type-guard.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const recordGuard = [{ messageId: "recordGuard" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("no-record-type-guard", noRecordTypeGuardRule, {
  valid: [
    `function isUser(value: unknown): value is User { return true; }`,
    `function isRecordedConversation(value: unknown): value is Conversation { return true; }`,
    `const guard = (value: unknown): value is Record<string, string> => true;`,
    `if (typeof value === "object" && value !== null && "id" in value) {}`,
    `record.isRecord();`,
  ],
  invalid: [
    {
      code: `function isRecord(value: unknown): boolean { return true; }`,
      errors: recordGuard,
    },
    {
      code: `const isRecord = (value: unknown) => typeof value === "object";`,
      errors: recordGuard,
    },
    {
      code: `function isObject(value: unknown): value is Record<string, unknown> { return true; }`,
      errors: recordGuard,
    },
    {
      code: `items.filter((item): item is Record<string, any> => item !== null);`,
      errors: recordGuard,
    },
  ],
});
