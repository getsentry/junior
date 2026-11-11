// One-off: convert format v1 Walkthrough runs (one diagram, question
// decisions) to format v2 (one diagram per PR, claim + concern decisions).
// Each PR's diagram is the part of the old diagram that its chapters show.
// Usage: node convert-v2.mjs FILE... (rewrites in place)
import { readFileSync, writeFileSync } from "node:fs";

// Written by hand from each question: the claim the PR makes, and the doubt.
const CLAIMS = {
  "stats-count-qq": {
    claim: "Stats and location counts can keep counting unkept Quick questions.",
    concern: "They may count them today, and this PR leaves them unchanged.",
  },
  "fork-prs": {
    claim: "Missing a stacked PR whose head is in a fork is acceptable.",
    concern: "The fallback walk matches parents by owner:branch, so it cannot find fork heads.",
  },
  "no-fk": {
    claim: "generation_conversation_id needs no foreign key.",
    concern: "A deleted generation Conversation leaves its version pointing at nothing.",
  },
  "list-probe-cost": {
    claim: "A synthetic 100k-row measurement of the extra list probe is enough to ship.",
    concern: "Every list and search pays for the probe, and no real data was measured.",
  },
  "sandbox-github": {
    claim: "A generation Turn can start without a check of sandbox GitHub access.",
    concern: "In this generation, gh and git failed with Missing GITHUB_APP_ID.",
  },
  "runs-as-clicker": {
    claim: "The generation sandbox can use the credentials of the person who clicked.",
    concern: "The Turn runs in a public Conversation.",
  },
  "error-path-finish": {
    claim: "A thrown or stopped generation Turn can wait for a click after 30 minutes to fail.",
    concern: "The reader waits 30 minutes to learn that the version failed.",
  },
  "limit-values": {
    claim: "The 80-call and $5 caps are safe defaults.",
    concern: "No real cost run backs them yet; the PR defers that.",
  },
  "no-outcome-metric": {
    claim: "Version rows are enough to see ready, failed, and timed-out versions.",
    concern: "No metric or log counts them.",
  },
};

function convertDecision(decision) {
  const { question, ...rest } = decision;
  const mapped = CLAIMS[decision.id];
  if (!mapped) throw new Error(`No claim for decision ${decision.id}`);
  return { ...rest, ...mapped };
}

function convert(document) {
  const content = document.content;
  const old = content.diagram;
  const chapterPr = (chapter) =>
    chapter.evidence.find((e) => e.kind === "code")?.pr ?? document.layers[0].pr;
  const shownBy = new Map();
  for (const chapter of content.chapters) {
    if (!chapter.view) continue;
    const pr = chapterPr(chapter);
    const ids = shownBy.get(pr) ?? new Set();
    for (const id of [
      ...chapter.view.show,
      ...chapter.view.highlight,
      ...chapter.view.added,
      ...chapter.view.broken.map((b) => b.id),
    ]) {
      ids.add(id);
    }
    shownBy.set(pr, ids);
  }
  const diagrams = [...shownBy].map(([pr, ids]) => {
    const nodes = old.nodes
      .filter((n) => ids.has(n.id))
      .map(({ id, label }) => ({ id, label }));
    const nodeIds = new Set(nodes.map((n) => n.id));
    // Keep an edge only when both of its nodes are in this diagram.
    const edges = old.edges.filter(
      (e) => ids.has(e.id) && nodeIds.has(e.from) && nodeIds.has(e.to),
    );
    const kept = new Set([...nodeIds, ...edges.map((e) => e.id)]);
    return { pr, nodes, edges, kept };
  });
  const keptFor = new Map(diagrams.map((d) => [d.pr, d.kept]));
  const chapters = content.chapters.map((chapter) => {
    const next = { ...chapter, decisions: chapter.decisions.map(convertDecision) };
    if (!chapter.view) return next;
    const pr = chapterPr(chapter);
    const kept = keptFor.get(pr);
    const keep = (ids) => ids.filter((id) => kept.has(id));
    next.view = {
      pr,
      ...chapter.view,
      show: keep(chapter.view.show),
      highlight: keep(chapter.view.highlight),
      added: keep(chapter.view.added),
      broken: chapter.view.broken.filter((b) => kept.has(b.id)),
    };
    return next;
  });
  const { diagram: _old, ...rest } = content;
  return {
    ...document,
    schemaVersion: 2,
    content: {
      ...rest,
      diagrams: diagrams.map(({ kept: _kept, ...d }) => d),
      chapters,
    },
  };
}

for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  run.document = convert(run.document);
  // Minified, so prettier lays it out the way the fixtures already are.
  writeFileSync(file, JSON.stringify(run));
  console.log(
    file,
    run.document.content.diagrams.map((d) => `#${d.pr}:${d.nodes.length}`).join(" "),
  );
}
