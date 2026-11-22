import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import {
  promptTagAttributesRule,
  readBaseline,
} from "./prompt-tag-attributes.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FILE = "packages/junior/src/chat/example.ts";
const filename = path.join(REPO_ROOT, FILE);
const baseline = {
  [FILE]: {
    "agent-result": ["source", "status"],
    message: ["author_id", "author_name"],
    "*": ["for"],
  },
};
const options = [{ baseline }];
// Every listed attribute is written, so no entry is stale.
const allWritten = [
  `renderTag("agent-result", { source: s, status: t }, lines);`,
  `renderTag(tag, { for: sender }, lines);`,
  // A helper with fixed attributes counts as its attribute names.
  `renderTag("message", { ...authorAttrs(author) }, lines);`,
].join("\n");

new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } },
}).run("prompt-tag-attributes", promptTagAttributesRule, {
  valid: [
    { code: allWritten, filename, options },
    {
      code: [
        allWritten,
        `const RESULT_TAG = "agent-result";`,
        `renderInlineTag(RESULT_TAG, text, { status: t });`,
        `renderTag("task", {}, lines);`,
        `renderEmptyTag(name, {});`,
        `openingTag("runtime-turn-context");`,
      ].join("\n"),
      filename,
      options,
    },
    {
      // A writer passes its own attributes parameter on.
      code: [
        allWritten,
        "function renderUntrustedTag(name, attrs, text) {",
        "  return renderTag(name, attrs, [text]);",
        "}",
      ].join("\n"),
      filename,
      options,
    },
    // A file with no entry may write tags without attributes.
    {
      code: `renderTag("task", {}, lines);`,
      filename: path.join(REPO_ROOT, "packages/junior/src/other.ts"),
      options,
    },
  ],
  invalid: [
    {
      code: `${allWritten}\nrenderTag("agent-result", { title: t }, lines);`,
      filename,
      options,
      errors: [{ messageId: "newAttribute" }],
    },
    {
      code: `${allWritten}\nopeningTag("todo-delta", { version: 3 });`,
      filename,
      options,
      errors: [{ messageId: "newAttribute" }],
    },
    {
      code: `${allWritten}\nrenderTag("task", { ...authorAttrs(author) }, lines);`,
      filename,
      options,
      errors: [{ messageId: "newAttribute" }, { messageId: "newAttribute" }],
    },
    {
      code: `${allWritten}\nrenderTag("todo-delta", { version: 3 }, lines);`,
      filename,
      options,
      errors: [{ messageId: "newAttribute" }],
    },
    {
      code: `renderTag("agent-result", { source: s }, lines);\nrenderTag(tag, { for: x }, lines);\nrenderTag("message", { ...authorAttrs(a) }, lines);`,
      filename,
      options,
      errors: [{ messageId: "staleAttribute" }],
    },
    {
      code: `${allWritten}\nrenderTag("agent-result", attributes, lines);`,
      filename,
      options,
      errors: [{ messageId: "literalAttributes" }],
    },
    {
      code: `${allWritten}\nrenderTag("agent-result", { ...extra }, lines);`,
      filename,
      options,
      errors: [{ messageId: "literalAttributes" }],
    },
  ],
});

describe("prompt-tag-attributes.json", () => {
  it("lists only files that exist", () => {
    for (const file of Object.keys(readBaseline())) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), file);
    }
  });
});
