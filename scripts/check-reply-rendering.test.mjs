import assert from "node:assert/strict";
import test from "node:test";
import { checkRegistry } from "./check-reply-rendering.mjs";

const FILES = {
  "markdown.tsx": [
    "const COMPONENTS: Components = {",
    "  p: ({ children }) => (",
    "    <p>{children}</p>",
    "  ),",
    "};",
    "",
  ].join("\n"),
  "mcp.ts": 'const text = data.text ?? "";',
};

const SURFACES = { dashboard: "Dashboard", mcp: "MCP" };
const HANDLERS = [
  {
    surface: "dashboard",
    file: "markdown.tsx",
    block: "const COMPONENTS: Components = {",
    name: /^ {2}(\w+):/gm,
  },
];
const MCP = { file: "mcp.ts", marker: "data.text" };
const PARAGRAPH = {
  id: "paragraph",
  support: {
    dashboard: {
      how: "native",
      file: "markdown.tsx",
      marker: "p:",
      handles: ["p"],
    },
    mcp: { how: "native", ...MCP },
  },
};

function check(constructs, files = FILES, baseline = []) {
  return checkRegistry({
    constructs,
    surfaces: SURFACES,
    handlers: HANDLERS,
    read: (file) => files[file],
    baseline: new Set(baseline),
  });
}

test("accepts constructs that render on every surface", () => {
  assert.deepEqual(check([PARAGRAPH]), []);
});

test("rejects a construct that a renderer handles but no construct lists", () => {
  const files = {
    ...FILES,
    "markdown.tsx": FILES["markdown.tsx"].replace(
      "};",
      "  details: ({ children }) => <details>{children}</details>,\n};",
    ),
  };
  assert.match(check([PARAGRAPH], files).join("\n"), /renders "details"/);
});

test("rejects an unsupported or missing surface entry", () => {
  const errors = check([
    {
      id: "object-card",
      support: {
        mcp: { how: "unsupported", note: "MCP drops cards", ...MCP },
      },
    },
  ]);
  assert.match(errors.join("\n"), /object-card has no entry for dashboard/);
  assert.match(errors.join("\n"), /object-card on mcp .* is unsupported/);
});

test("rejects an entry whose marker is not in its file", () => {
  const errors = check([
    {
      ...PARAGRAPH,
      support: {
        ...PARAGRAPH.support,
        mcp: { ...MCP, how: "native", marker: "gone" },
      },
    },
  ]);
  assert.match(errors.join("\n"), /does not contain "gone"/);
});

test("accepts a baselined gap and rejects a baseline entry that renders now", () => {
  const card = {
    id: "object-card",
    support: {
      dashboard: { how: "native", ...MCP },
      mcp: { how: "unsupported", note: "MCP drops cards", ...MCP },
    },
  };
  assert.deepEqual(check([PARAGRAPH, card], FILES, ["object-card/mcp"]), []);
  assert.match(
    check([PARAGRAPH], FILES, ["paragraph/mcp"]).join("\n"),
    /Remove "paragraph\/mcp"/,
  );
});
