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
    // A formatter prop with a default formatter of the same module
    // (ActivityChart.tsx).
    `export function formatCategoryLabel(label) { return label.toUpperCase(); }
     export function Axis(props) {
       const formatLabel = props.formatLabel ?? formatCategoryLabel;
       return formatLabel(props.value);
     }`,
    `function defaultLabel(value) { return String(value); }
     export function label(options) { return options.label || defaultLabel; }`,
    // A replacer helper of the same module (request-prefix-attributes.ts).
    `function withoutCacheControl(key, value) {
       return key === "cache_control" ? undefined : value;
     }
     function hashJson(value, replacer = withoutCacheControl) {
       return JSON.stringify(value, replacer);
     }
     export const hash = (value) => hashJson(value);`,
    // A table, or a subquery over it, that the helper reads columns from
    // (junior/src/chat/memory/embedding.ts).
    `import { juniorMemoryEmbeddings } from "./schema";
     export function sameModel(embedding, columns = juniorMemoryEmbeddings) {
       return and(
         eq(columns.provider, embedding.provider),
         eq(columns.model, embedding.model),
       );
     }`,
    `import { juniorMemoryEmbeddings } from "./schema";
     export function modelColumn(options) {
       const columns = options.columns ?? juniorMemoryEmbeddings;
       return columns.model;
     }`,
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
      // getsentry/junior#3523 review: an async function of the same module.
      code: `async function recordSandboxAuthRequired(input) {
          await setSignal(input);
        }
        export async function forward(input, deps) {
          const record = deps.recordAuthRequired ?? recordSandboxAuthRequired;
          await record(input);
        }`,
      errors: fallback,
    },
    {
      code: `const publicBaseUrl = async () => await readBaseUrl();
        export function publish({ baseUrl = publicBaseUrl }) { return baseUrl(); }`,
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
      code: `import { wakePausedTurn as defaultWake } from "./turn-wake";
        export function pause(options) { return options.wake || defaultWake; }`,
      errors: fallback,
    },
    {
      code: `import { resolveBaseUrl } from "./oauth-flow";
        export function publish({ baseUrl = resolveBaseUrl }) { return baseUrl(); }`,
      errors: fallback,
    },
    {
      code: `import { getSlackClient } from "./client";
        export function send({ getClient = getSlackClient } = {}) { return getClient(); }`,
      errors: fallback,
    },
    {
      // getsentry/junior#3404: a queue service with methods.
      code: `import { conversationWorkQueue } from "./queue";
        export async function enqueue(options, message) {
          const queue = options.conversationWorkQueue ?? conversationWorkQueue;
          await queue.send(message);
        }`,
      errors: fallback,
    },
    {
      code: `import { conversationWorkQueue } from "./queue";
        export async function wake(options) {
          await ensureWake(options.conversationWorkQueue ?? conversationWorkQueue);
        }`,
      errors: fallback,
    },
    {
      code: `import { conversationStore } from "./store";
        export async function load(id, { store = conversationStore } = {}) {
          return await store.get(id);
        }`,
      errors: fallback,
    },
  ],
});
