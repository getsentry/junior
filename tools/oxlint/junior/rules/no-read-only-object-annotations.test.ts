import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noReadOnlyObjectAnnotationsRule } from "./no-read-only-object-annotations.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const readOnly = [{ messageId: "readOnly" }];

new RuleTester().run(
  "no-read-only-object-annotations",
  noReadOnlyObjectAnnotationsRule,
  {
    valid: [
      `definePluginTool({
        annotations: { readOnlyHint: false },
        execute: () => ({ objectAnnotations: [annotation] }),
      });`,
      `definePluginTool({
        annotations: { readOnlyHint: true },
        execute: () => ({ target: "getIssue" }),
      });`,
      `const result = { objectAnnotations: [annotation] };`,
    ],
    invalid: [
      {
        code: `definePluginTool({
          annotations: { readOnlyHint: true },
          execute: () => ({ objectAnnotations: [annotation] }),
        });`,
        errors: readOnly,
      },
      {
        code: `zodTool({
          annotations: { destructiveHint: false, readOnlyHint: true },
          async execute() {
            const objectAnnotations = [annotation];
            return { objectAnnotations };
          },
        });`,
        errors: readOnly,
      },
    ],
  },
);
