import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPromptTokenStats,
  promptTokenTotal,
  promptTokensTitle,
  renderPromptTokensReport,
} from "./prompt-tokens.mjs";

function stats({ tools = [{ name: "bash", chars: 250, tokens: 100 }] } = {}) {
  return {
    version: 1,
    model: "anthropic/claude-test",
    sections: [
      { name: "task-execution", group: "rules", chars: 500, tokens: 200 },
      { name: "evidence", group: "rules", chars: 250, tokens: 100 },
      {
        name: "available-skills",
        group: "available-skills",
        chars: 125,
        tokens: 50,
      },
    ],
    tools,
    skills: [{ name: "github-code", chars: 125, tokens: 50 }],
    turnContext: { name: "turn context", chars: 100, tokens: 40 },
  };
}

test("totals the system prompt sections and the tools", () => {
  assert.equal(promptTokenTotal(stats()), 450);
  assert.equal(promptTokensTitle(stats()), "450 tokens");
});

test("reports each part without a base", () => {
  const report = renderPromptTokensReport(stats());
  assert.match(report, /^## Always-on prompt: 450 tokens$/m);
  assert.match(report, /^\| Core rules \| 300 \| 66\.7% \|$/m);
  assert.match(report, /^\| Skills list \| 50 \| 11\.1% \|$/m);
  assert.match(report, /^\| Tool definitions \| 100 \| 22\.2% \|$/m);
  assert.doesNotMatch(report, /Change|Changed/);
  assert.match(report, /adds 40 tokens to each request/);
});

test("reports the change from the base and the items that changed", () => {
  const current = stats({
    tools: [
      { name: "bash", chars: 300, tokens: 120 },
      { name: "newTool", chars: 75, tokens: 30 },
    ],
  });
  const base = stats({
    tools: [
      { name: "bash", chars: 250, tokens: 100 },
      { name: "oldTool", chars: 25, tokens: 10 },
    ],
  });
  const report = renderPromptTokensReport(current, base, "`abc1234`");

  assert.equal(
    promptTokensTitle(current, base, "abc1234"),
    "500 tokens (+40 vs abc1234)",
  );
  assert.match(report, /^\+40 tokens \(8\.7%\) vs `abc1234`\.$/m);
  assert.match(report, /^\| Tool definitions \| 150 \| 30\.0% \| \+40 \|$/m);
  assert.match(report, /^\| Core rules \| 300 \| 60\.0% \|  \|$/m);
  const changed = report.slice(report.indexOf("**Changed**"));
  assert.match(changed, /^\| tool `newTool` \(new\) \| 30 \| \+30 \|$/m);
  assert.match(changed, /^\| tool `bash` \| 120 \| \+20 \|$/m);
  assert.match(changed, /^\| tool `oldTool` \(removed\) \| - \| -10 \|$/m);
  assert.ok(changed.indexOf("newTool") < changed.indexOf("bash"));
  assert.doesNotMatch(changed.split("<details>")[0], /task-execution/);
});

test("rejects data that is not prompt token stats", () => {
  assert.throws(() => assertPromptTokenStats({ version: 2 }), /version 1/);
  assert.throws(
    () =>
      assertPromptTokenStats({
        ...stats(),
        tools: [{ name: "bash", tokens: "100" }],
      }),
    /version 1/,
  );
  assert.equal(assertPromptTokenStats(stats()).model, "anthropic/claude-test");
});
