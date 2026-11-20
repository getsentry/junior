import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { zodNamespaceImportRule } from "./zod-namespace-import.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const namespaceImport = [{ messageId: "namespaceImport" }];

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("zod-namespace-import", zodNamespaceImportRule, {
  valid: [
    `import * as z from "zod";`,
    `import type { ZodType } from "zod";`,
    `import { ZodError } from "zod";`,
    `import type { z } from "zod";`,
    `import { type z } from "zod";`,
    `import { z } from "./local-zod";`,
  ],
  invalid: [
    { code: `import { z } from "zod";`, errors: namespaceImport },
    { code: `import { z as zod } from "zod";`, errors: namespaceImport },
    { code: `import { ZodError, z } from "zod";`, errors: namespaceImport },
  ],
});
