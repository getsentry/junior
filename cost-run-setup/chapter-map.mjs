// Print each run's chapters (label, cited PRs, caption) and, for a stack,
// whether any chapter maps one-to-one onto a PR.
// Usage: node chapter-map.mjs FILE...
import { readFileSync } from "node:fs";
for (const file of process.argv.slice(2)) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const c = run.document.content;
  const layers = run.document.layers.map((l) => l.number ?? l.pr);
  console.log(`\n${file} types=${JSON.stringify(c.types ?? null)} also_changed=${(c.also_changed ?? c.not_covered ?? []).length}`);
  const byPr = new Map();
  for (const ch of c.chapters) {
    const prs = new Set(ch.evidence.filter((e) => e.pr).map((e) => e.pr));
    for (const pr of prs) byPr.set(pr, [...(byPr.get(pr) ?? []), ch.id]);
    console.log(`  ${ch.label ?? `${ch.type}/${ch.slot}`} | PRs ${[...prs].join(",")} | ${ch.caption}`);
  }
  if (layers.length > 1) {
    // One-to-one: the chapter cites only one PR, and no other chapter cites that PR.
    const oneToOne = c.chapters.filter((ch) => {
      const prs = new Set(ch.evidence.filter((e) => e.pr).map((e) => e.pr));
      return prs.size === 1 && byPr.get([...prs][0]).length === 1;
    });
    const singlePr = c.chapters.filter((ch) => new Set(ch.evidence.filter((e) => e.pr).map((e) => e.pr)).size === 1);
    console.log(`  chapters citing one PR: ${singlePr.length}/${c.chapters.length}; one-to-one with a PR: ${oneToOne.map((x) => x.id).join(",") || "none"}`);
  }
}
