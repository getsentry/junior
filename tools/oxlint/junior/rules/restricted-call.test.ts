import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { RuleTester } from "oxlint/plugins-dev";

import { restrictedCallRule } from "./restricted-call.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const src = "packages/junior/src";

const options = [
  {
    entries: [
      {
        module: `${src}/chat/pi/client`,
        names: ["completeText"],
        allow: [`${src}/chat/core-model.ts`],
        message: "Use core-model.",
      },
      {
        module: `${src}/chat/slack/outbound`,
        names: ["postSlackMessage"],
        slackMethods: ["chat.postMessage"],
        allow: [`${src}/chat/slack/outbound.ts`],
        message: "Use sendSlackReply.",
      },
    ],
  },
];

function inFile(file: string) {
  return (code: string) => ({
    code,
    filename: path.join(repoRoot, src, file),
    options,
  });
}

const nonOwner = inFile("chat/services/example.ts");
const restricted = (count = 1) =>
  Array.from({ length: count }, () => ({ messageId: "restricted" }));

new RuleTester({ cwd: repoRoot }).run("restricted-call", restrictedCallRule, {
  valid: [
    inFile("chat/core-model.ts")(
      `import * as gateway from "@/chat/pi/client"; gateway.completeText({});`,
    ),
    inFile("chat/slack/outbound.ts")(
      `getSlackClient().chat.postMessage({ channel, text });`,
    ),
    nonOwner(
      `import { resolveGatewayModel } from "@/chat/pi/client"; resolveGatewayModel("m");`,
    ),
    nonOwner(
      `import * as gateway from "@/chat/pi/client"; gateway.resolveGatewayModel("m");`,
    ),
    nonOwner(
      `import { completeText } from "@/chat/core-model"; completeText({});`,
    ),
    nonOwner(
      `import type { completeText } from "@/chat/pi/client"; let f: typeof completeText;`,
    ),
    nonOwner(
      `import * as gateway from "@/chat/pi/client"; type P = Parameters<typeof gateway.completeText>;`,
    ),
    nonOwner(
      `const { completeText } = await import("@/chat/pi/client.other");`,
    ),
    nonOwner(`getSlackClient().chat.update({ channel, ts, text });`),
    nonOwner(`getSlackClient().apiCall("assistant.search.context", {});`),
    nonOwner(`const { postMessage } = client.views;`),
  ],
  invalid: [
    {
      ...nonOwner(
        `import { completeText } from "@/chat/pi/client"; completeText({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import { completeText as run } from "@/chat/pi/client"; run({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import * as gateway from "@/chat/pi/client"; gateway.completeText({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import * as gateway from "@/chat/pi/client"; gateway["completeText"]({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import * as gateway from "@/chat/pi/client"; const { completeText: run } = gateway; run({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import * as gateway from "@/chat/pi/client"; const g = gateway; g.completeText({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import * as gateway from "@/chat/pi/client"; forward(gateway);`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import { completeText } from "../pi/client"; completeText({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import { completeText } from "@/chat/pi/client.js"; completeText({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import { completeText } from "../pi/client.ts"; const run = completeText; run({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `const { completeText } = await import("@/chat/pi/client"); completeText({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(`(await import("@/chat/pi/client")).completeText({});`),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import("@/chat/pi/client").then((m) => m.completeText({}));`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(`export { completeText as run } from "@/chat/pi/client";`),
      errors: restricted(),
    },
    {
      ...nonOwner(`export * from "@/chat/pi/client";`),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `import { postSlackMessage as post } from "@/chat/slack/outbound"; await post({ channelId, text });`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `await getSlackClient().chat.postMessage({ channel, text });`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(`await client?.chat["postMessage"]({ channel, text });`),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `const { postMessage } = getSlackClient().chat; await postMessage({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `const { chat: { postMessage } } = getSlackClient(); await postMessage({});`,
      ),
      errors: restricted(),
    },
    {
      ...nonOwner(
        `await getSlackClient().apiCall("chat.postMessage", { channel, text });`,
      ),
      errors: restricted(),
    },
  ],
});

const oxlintBin = path.join(repoRoot, "node_modules/.bin/oxlint");
const pluginPath = path.join(repoRoot, "tools/oxlint/junior/index.ts");

// Disable directives are handled by the linter, not the rule, so these run
// the oxlint CLI with the repo's `reportUnusedDisableDirectives` setting.
async function lintFile(code: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restricted-call-"));
  fs.mkdirSync(path.join(root, "src/chat/pi"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "src/chat/example.ts"), code);
  fs.writeFileSync(
    path.join(root, ".oxlintrc.json"),
    JSON.stringify({
      plugins: [],
      jsPlugins: [{ name: "junior", specifier: pluginPath }],
      rules: {
        "junior/restricted-call": [
          "error",
          {
            entries: [
              {
                module: "src/chat/pi/client",
                names: ["completeText"],
                allow: [],
                message: "Use core-model.",
              },
            ],
          },
        ],
      },
      options: { reportUnusedDisableDirectives: "error" },
    }),
  );
  try {
    await promisify(execFile)(oxlintBin, ["--format=unix", "src"], {
      cwd: root,
    });
    return { failed: false, output: "" };
  } catch (error) {
    const { stdout } = error as { stdout: string };
    return { failed: true, output: stdout };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("restricted-call disable directives", () => {
  it("accepts a disable with a reason", async () => {
    const result = await lintFile(
      [
        `import * as gateway from "@/chat/pi/client";`,
        `// oxlint-disable-next-line junior/restricted-call -- eval harness has no Conversation`,
        `gateway.completeText({});`,
        ``,
      ].join("\n"),
    );
    assert.deepEqual(result, { failed: false, output: "" });
  });

  it("reports a namespace call without a disable", async () => {
    const result = await lintFile(
      `import * as gateway from "@/chat/pi/client";\ngateway.completeText({});\n`,
    );
    assert.equal(result.failed, true);
    assert.match(
      result.output,
      /Do not use `completeText` from `src\/chat\/pi\/client` here\. Use core-model\. For a one-off exception, put `\/\/ oxlint-disable-next-line junior\/restricted-call -- <reason>`/,
    );
  });

  it("reports an unused disable", async () => {
    const result = await lintFile(
      [
        `import { resolveGatewayModel } from "@/chat/pi/client";`,
        `// oxlint-disable-next-line junior/restricted-call -- not needed`,
        `resolveGatewayModel("m");`,
        ``,
      ].join("\n"),
    );
    assert.equal(result.failed, true);
    assert.match(result.output, /Unused oxlint-disable directive/);
  });
});
