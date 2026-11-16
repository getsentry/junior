---
name: maintain-feature-docs
description: Audit the intent docs in `features/` against the code and the file contract. Read-only subagents check each feature file. One PR fixes drift and cuts lines that break the contract. Broken behavior and behavior IDs with no eval or test are reported, not fixed. Use for the daily or weekly feature docs check, "audit the feature docs", or "check features/ for drift or bloat". Do not use to write a doc for a new or changed feature (feature-docs), or to change product code.
---

# Maintain feature docs

Feature docs become wrong when the product changes, and they grow when
people append lines. This pass keeps each file true and inside the contract
in `features/README.md`. The unit of work is the feature file, not each
sentence.

## Outcomes

Give exactly one:

- **clean**: every file in scope was checked, and nothing needs to change.
  No branch, no PR.
- **changed**: one PR with proven corrections.
- **blocked**: the check could not finish, or a fix could not ship safely.
  Say exactly what blocked it.

## Edit scope

Edit only files in `features/`. Never edit product code, tests, or evals. If
the product no longer does what a doc says, decide which one is wrong. Doc
drift: fix the doc. Product regression: report it, and keep the doc.

## Scope

- **Daily**: the feature files that the last day of commits on the default
  branch could affect. Match the commits to files by the user-visible
  behavior they change. When no file is affected, the outcome is clean.
- **Full**: every feature file. Use this for a weekly run and when a person
  asks for an audit without a scope.

## Pass

1. **Index.** Read `features/README.md` and list the files in `features/`.
   Fix missing, extra, duplicate, or dead index entries.
2. **Source wave.** Start one read-only subagent per file in scope, all at
   the same time. Give each one the contract, its file, and this return
   shape. Subagents do not edit files.
   - per behavior ID: `holds`, `drift` (with a source citation), or `gone`
   - per rule: `holds`, or `gap` (the code does not meet it, with a source
     citation)
   - per `Gap:` rule: `open`, or `closed` (the code now meets it)
   - lines that break the contract (implementation, history, a repeat of
     another line or file, a line with no outcome that a user can see)
   - user-facing behavior that is missing, each with a source path
   - per behavior ID: the eval or test that proves it, or `none`
3. **Reconcile.** Spot-check each cited drift and each missing behavior. Do
   not prove claims that hold again. Add a missing behavior only when it is
   a main behavior of the system, not a detail of a behavior that is
   already in the file.
4. **Live check.** Only when source cannot decide a claim, follow the
   `junior-qa` skill (`pnpm cli -- chat ...`) to see the behavior.
5. **Triage.**
   - drift or a gone behavior: fix or delete the line
   - a rule that the code does not meet: do not change it to match the
     code. If a commit or PR in scope changed the intent on purpose, fix the
     rule. Otherwise, report the gap outside the PR.
   - a closed `Gap:` rule: rewrite it as a plain rule
   - contract break: cut it, or rewrite it as one bullet in the contract
   - missing main behavior: add one bullet, and follow `feature-docs`
   - product regression: report it, outside the PR
   - no eval or test: put it on the coverage list, outside the PR
6. **Ship or stop.** For changed, follow the `github-code` skill to open one
   PR. Read every changed file again first. The PR body lists the fixes and
   the cuts. A cut needs no reason. An addition needs a source path.

## Report

Keep it short:

- outcome and scope, with the files checked
- the PR link, when changed
- regressions and new gaps, each with its `<file>#<id>` or rule and a
  source citation
- the coverage list: `<file>#<id>` entries with no eval or test

Keep run notes in scratch space. Do not commit them.
