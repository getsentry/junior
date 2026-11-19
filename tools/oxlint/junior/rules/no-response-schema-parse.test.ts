import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noResponseSchemaParseRule } from "./no-response-schema-parse.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const filename = path.join(
  REPO_ROOT,
  "packages/junior/src/api/conversations/example.ts",
);
const responseSchemaParse = [{ messageId: "responseSchemaParse" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("no-response-schema-parse", noResponseSchemaParseRule, {
  valid: [
    {
      code: `import { reportSchema } from "./schema"; reportSchema.parse(value);`,
      filename,
    },
    {
      code: `import type { reportSchema } from "../schema/report"; reportSchema.parse(value);`,
      filename,
    },
    {
      code: `import { reportSchema } from "../schema/report"; reportSchema.extend({});`,
      filename,
    },
    {
      code: `import { userSchema } from "@sentry/junior-plugin-api"; userSchema.parse(value);`,
      filename,
    },
  ],
  invalid: [
    {
      code: `import { reportSchema } from "../schema/report"; reportSchema.parse(value);`,
      filename,
      errors: responseSchemaParse,
    },
    {
      code: `import { reportSchema as schema } from "@/api/schema/report"; schema.safeParse(value);`,
      filename,
      errors: responseSchemaParse,
    },
    {
      code: `import { reportSchema } from "../schema"; reportSchema.parseAsync(value);`,
      filename,
      errors: responseSchemaParse,
    },
    {
      code: `import * as schemas from "@/api/schema"; schemas.reportSchema.parse(value);`,
      filename,
      errors: responseSchemaParse,
    },
  ],
});
