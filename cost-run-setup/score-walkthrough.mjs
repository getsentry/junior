// Score stored Walkthrough versions (GET /api/walkthroughs/:id output) on the
// polish-slice eval checks. Reads both format v1 (`diagram`, `question`) and
// v2 (`diagrams`, `claim`). Usage: node score-walkthrough.mjs FILE...
import { readFileSync } from "node:fs";

const QUESTION_START =
  /^(is|are|was|were|does|do|did|should|can|could|will|would|what|why|how|which|who|has|have)\b/i;

function score(file) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const doc = run.document;
  const content = doc.content;
  const chapters = [
    ...content.chapters,
    ...doc.updates.flatMap((u) => u.added_chapters ?? []),
  ];
  const captions = chapters.map((c) => c.caption.trim().toLowerCase());
  const repeated = captions.filter((c, i) => captions.indexOf(c) !== i);
  const diagrams = content.diagrams ?? [content.diagram];
  const nodeCounts = diagrams.map((d) => d.nodes.length);
  const decisions = [
    ...chapters.flatMap((c) => c.decisions),
    ...doc.updates.flatMap((u) => u.items.flatMap((i) => i.decisions)),
  ];
  const statements = decisions.map((d) => d.claim ?? d.question);
  const questions = statements.filter(
    (s) => s.trim().endsWith("?") || QUESTION_START.test(s.trim()),
  );
  return {
    file,
    layers: doc.layers.map((l) => l.pr).join(","),
    costUsd: Number((run.costUsd ?? doc.meta.costUsd ?? 0).toFixed(2)),
    minutes: Number(
      ((Date.parse(run.completedAt) - Date.parse(run.createdAt)) / 60000).toFixed(1),
    ),
    chapters: chapters.length,
    uniqueCaptions: repeated.length === 0,
    repeatedCaptions: repeated.length,
    diagrams: diagrams.length,
    maxNodes: Math.max(...nodeCounts),
    diagramsAtMost10: nodeCounts.every((n) => n <= 10),
    decisions: decisions.length,
    questionDecisions: questions.length,
    claimsNotQuestions: questions.length === 0,
    concerns: decisions.filter((d) => d.concern).length,
  };
}

const rows = process.argv.slice(2).map(score);
console.log(JSON.stringify(rows, null, 2));
