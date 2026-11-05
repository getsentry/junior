import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { useGitHubApiRule } from "./use-github-api.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const useGitHubApi = [{ messageId: "useGitHubApi" }];

new RuleTester().run("use-github-api", useGitHubApiRule, {
  valid: [
    `await githubApi(ctx.egress, { operation: "github.pull.get", path });`,
    `await fetchEgress(egress);`,
    `await client.fetch(request);`,
  ],
  invalid: [
    {
      code: `await ctx.egress.fetch({ provider: "github", operation, request });`,
      errors: useGitHubApi,
    },
    {
      code: `await egress.fetch({ provider: "github", operation, request });`,
      errors: useGitHubApi,
    },
    {
      code: `await input.egress.fetch({ provider: "github", operation, request });`,
      errors: useGitHubApi,
    },
  ],
});
