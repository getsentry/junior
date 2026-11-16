import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noServiceFallbackRule } from "./no-service-fallback.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const fallback = [{ messageId: "fallback" }];

new RuleTester().run("no-service-fallback", noServiceFallbackRule, {
  valid: [
    `import { recordDenied } from "./audit";
     export async function deny() { await recordDenied(); }`,
    `import { DEFAULT_LIMIT } from "./limits";
     export function page(options) { return options.limit ?? DEFAULT_LIMIT; }`,
    `import { Circle } from "./icons";
     export function Icon(props) { return props.icon ?? Circle; }`,
    `export function read(options) { return options.fetch ?? fetch; }`,
    `export function name(args) {
       const fallback = () => "none";
       return args.name ?? fallback;
     }`,
    `export function render({ formatLabel }) { return formatLabel; }`,
  ],
  invalid: [
    {
      // getsentry/junior#3111 review: "whys this an optional dep?"
      code: `import { recordSandboxPolicyDenied } from "./audit";
        export async function deny(input, deps = {}) {
          await (deps.recordPolicyDenied ?? recordSandboxPolicyDenied)(input);
        }`,
      errors: fallback,
    },
    {
      code: `import { lookupSlackUser } from "./user";
        export function worker(options) {
          const actorLookup = options.lookupSlackUser ?? lookupSlackUser;
          return actorLookup;
        }`,
      errors: fallback,
    },
    {
      code: `function defaultWake() {}
        export function pause(options) { return options.wake || defaultWake; }`,
      errors: fallback,
    },
    {
      code: `const resolveBaseUrl = () => "https://example.com";
        export function publish({ baseUrl = resolveBaseUrl }) { return baseUrl(); }`,
      errors: fallback,
    },
    {
      code: `import { getSlackClient } from "./client";
        export function send({ getClient = getSlackClient } = {}) { return getClient(); }`,
      errors: fallback,
    },
  ],
});
