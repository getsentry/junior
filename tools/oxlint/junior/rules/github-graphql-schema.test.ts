import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { githubGraphqlSchemaRule } from "./github-graphql-schema.ts";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester().run("github-graphql-schema", githubGraphqlSchemaRule, {
  valid: [
    "githubGraphql(`query Viewer { viewer { login } }`);",
    `githubGraphql("mutation Resolve($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }");`,
    "graphql(`query { nope }`);",
  ],
  invalid: [
    {
      code: "githubGraphql(`query Viewer { viewer { nope } }`);",
      errors: [{ messageId: "invalidDocument" }],
    },
    {
      code: "githubGraphql(`query Viewer { viewer { login }`);",
      errors: [{ messageId: "invalidDocument" }],
    },
    {
      code: "githubGraphql(`query Viewer { viewer { ${field} } }`);",
      errors: [{ messageId: "staticDocument" }],
    },
    {
      code: "githubGraphql(document);",
      errors: [{ messageId: "staticDocument" }],
    },
  ],
});
