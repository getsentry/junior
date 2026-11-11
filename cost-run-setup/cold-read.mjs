// Cold-reader check for stored Walkthrough versions (GET /api/walkthroughs/:id).
//
// A cheap model reads only the title, intent and chapter prose (label, caption,
// body; no code, excerpts or claims) and answers questions picked by the
// Walkthrough's first change type. A grader then scores each answer 0-2 against
// the PR bodies and diffs, which only the grader sees.
//
// Usage: node cold-read.mjs RUN.json... (needs git with the layer commits and
// `gh`; calls AI Gateway through the sandbox egress proxy).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const GATEWAY = "https://ai-gateway.vercel.sh/v1/chat/completions";
const READER = "anthropic/claude-haiku-4.5";
const GRADER = "anthropic/claude-haiku-4.5";
const REPO = process.env.REPO_DIR ?? "/vercel/sandbox/repos/junior";
/** Cap on the grader's diff, so a stack stays near $0.05 a run. */
const DIFF_CHARS = 60_000;
const SKIP = [":!**/meta/*_snapshot.json", ":!pnpm-lock.yaml", ":!**/*.png"];

/** Questions by change type. Every type also asks which terms were unclear. */
const QUESTIONS = {
  bug_fix: [
    "What broke, and what is the root cause?",
    "How do we know the fix works?",
    "What else does the fix affect?",
  ],
  feature: [
    "What problem does this solve?",
    "How does it work, in 3-5 sentences?",
    "What should a reviewer worry about most?",
  ],
  refactor: [
    "What stays the same, and why is the refactor worth it?",
    "How do we know behavior does not change, and what are the exceptions?",
    "What should a reviewer worry about most?",
  ],
  migration: [
    "Why is the migration needed?",
    "Is it safe to run, and how would it be rolled back?",
    "What should a reviewer worry about most?",
  ],
  performance: [
    "What is the hot path, and what changes on it?",
    "Are the numbers real, and how were they measured?",
    "What should a reviewer worry about most?",
  ],
  dependency: [
    "What changed upstream?",
    "What is the blast radius?",
    "What should a reviewer worry about most?",
  ],
  ui: [
    "What did the UI look like before, and what does it look like after?",
    "Which states and edge cases does the change handle?",
    "What should a reviewer worry about most?",
  ],
};
const TERMS =
  "Which terms were unclear? List each term, name, or identifier that the text uses without explaining it and that is not in the terminology above. Be strict: a term you could only guess at counts. Answer as a comma-separated list, or none.";
const TERMINOLOGY = readFileSync(`${REPO}/TERMINOLOGY.md`, "utf8");

async function chat(model, messages, maxTokens) {
  const response = await fetch(GATEWAY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0, messages }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const body = await response.json();
  return { text: body.choices[0].message.content, cost: body.usage?.cost ?? 0 };
}

function json(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

function storyText(content) {
  const chapters = content.chapters.map((c, i) =>
    [`## ${i + 1}. ${c.label}`, c.caption, c.body.replace(/\[\d+\]/g, "")].join("\n"),
  );
  return [`# ${content.title}`, content.intent, ...chapters].join("\n\n");
}

function reference(layers) {
  const parts = layers.map((layer) => {
    const body = execFileSync(
      "gh",
      ["pr", "view", String(layer.pr), "--repo", "getsentry/junior", "--json", "title,body", "-q", '.title + "\\n\\n" + .body'],
      { encoding: "utf8" },
    );
    const diff = execFileSync(
      "git",
      ["-C", REPO, "diff", `${layer.baseSha}...${layer.headSha}`, "--", ".", ...SKIP],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return { pr: layer.pr, body, diff };
  });
  const share = Math.floor(DIFF_CHARS / parts.length);
  return parts
    .map((p) => `### PR #${p.pr}\n${p.body}\n\n#### Diff (may be cut)\n${p.diff.slice(0, share)}`)
    .join("\n\n");
}

async function coldRead(file) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const content = run.document.content;
  const type = content.types[0];
  const questions = [...QUESTIONS[type], TERMS];
  const reader = await chat(
    READER,
    [
      {
        role: "system",
        content:
          `You are a reviewer who knows this repository and the terminology below, but has never seen this change or the features it touches. You only have the Walkthrough text that follows. Answer from it alone; when it does not say, answer "not said". Reply with JSON: {"answers": [string, ...]} in question order.\n\n${TERMINOLOGY}`,
      },
      {
        role: "user",
        content: `${storyText(content)}\n\n---\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
      },
    ],
    1500,
  );
  const answers = json(reader.text).answers;
  const graded = questions.slice(0, -1);
  const grader = await chat(
    GRADER,
    [
      {
        role: "system",
        content:
          "You grade a cold reader's answers about a code change against the real PR descriptions and diffs. Score each answer 0 (wrong or not said), 1 (partly right or vague), or 2 (right and specific). Be strict, and judge by what the PRs actually do, not by how confident the answer sounds. A problem answer that only restates what the change adds, instead of naming what was wrong or missing before it, scores 0. A mechanism answer that names identifiers without saying what they do scores at most 1. A risk answer scores 2 only if it names the risks that matter most in the diff, not generic ones. Reply with JSON: {\"scores\": [number, ...], \"notes\": [string, ...]}, with exactly one score and one short note per question, in question order.",
      },
      {
        role: "user",
        content: `Reference:\n\n${reference(run.document.layers)}\n\n---\nGrade these ${graded.length} answers.\n\n${graded
          .map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${answers[i]}`)
          .join("\n\n")}\n\nReply with only the JSON object, with exactly ${graded.length} scores and ${graded.length} notes.`,
      },
    ],
    1200,
  );
  const parsed = json(grader.text);
  const scores = parsed.scores.slice(0, graded.length);
  const notes = parsed.notes.slice(0, graded.length);
  if (scores.length !== graded.length) throw new Error(`Grader gave ${scores.length} scores`);
  const total = scores.reduce((a, b) => a + b, 0);
  return {
    file,
    type,
    score: `${total}/${graded.length * 2}`,
    scores,
    unclearTerms: answers[questions.length - 1],
    unclearCount: /^\s*none\b/i.test(answers[questions.length - 1])
      ? 0
      : answers[questions.length - 1].split(",").length,
    costUsd: Number((reader.cost + grader.cost).toFixed(4)),
    answers: graded.map((q, i) => ({ q, a: answers[i], score: scores[i], note: notes[i] })),
  };
}

const results = [];
for (const file of process.argv.slice(2)) results.push(await coldRead(file));
console.log(JSON.stringify(results, null, 2));
