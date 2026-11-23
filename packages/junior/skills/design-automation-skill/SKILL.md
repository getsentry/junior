---
name: design-automation-skill
description: Write, change, or review a skill that Automations run, or turn a long Automation instruction into one. Gives the required sections, the inputs and scope contract, checks for work already in progress, the report and empty result, words to leave out, validation, and naming. Use when asked to write or review such a skill, or to move an Automation instruction into a skill. Do not use to create or edit the Automation itself, or for a skill that only people run.
---

# Design an automation skill

An automation skill does one kind of recurring work. An Automation runs it after a schedule or an event, and a person can run it by hand with the same result. The skill owns the work. The Automation owns when it runs, where the result goes, and the values for one setup.

When you turn an instruction into a skill, move its steps, defaults, and report format into the skill. The rest stays in the Automation context.

## Required sections

Use this order:

1. **Frontmatter description.** Say what one run produces, name both scopes, and write triggers as the work, such as "when a CI check fails and might be flaky". Do not name the caller.
2. **Purpose.** One or two sentences: what a run produces, and how often a run finds nothing.
3. **Inputs.** Only when values change between setups: one line each, with its default.
4. **Rules.** Hard limits, then a **Side effects** list with each kind of write the skill can make.
5. **Workflow.** Numbered steps. The first step reads the target's own conventions: agent docs, contributing guide, and CI files.
6. **Report.** The format, and the one empty-result line.

Put only a brief for parallel workers or a long template in `references/`.

## Inputs and scope

- Values that change between setups are inputs: repos, projects, teams, thresholds, people to tag, and paths that need sign-off. Do not write them into the steps. A skill for one named system can keep its fixed values.
- Do not explain how to find an input in the request, the item it points at, or the checkout. The agent does that.
- Use two scopes:
  - **One item**: the request points at one thing. Decide about that thing, and look back over a short window, such as 7 days, for the same problem.
  - **Sweep**: all other requests. Check every item in a default window, such as the last 48 hours.
- The skill never asks whether a person or an Automation started it.

## Evidence

When a run acts on problems that it finds:

- Before you act on an item, prove that the evidence caused the problem. Compare with healthy cases of the same kind. Evidence that also shows in healthy cases is noise.
- Require repeats before a write. One occurrence is not enough unless the request says so.
- Group by cause, not by name. One cause in many places is one item. Two causes in one place are two items.

## Work already in progress

Runs can overlap, and people work on the same problems.

- Give each item a stable key that a search finds, such as a branch name `fix-<kind>/<slug>`, an issue title prefix, or a marker in a comment. Use the target's own convention when it has one.
- Before you act, search open pull requests, recent branches, open issues, and changes merged since the problem started. When something covers the item, skip it and keep the link for the report.
- Search again right before each write.
- Do not push to, rebase, or comment on work that someone else owns, unless the request says to.

## Parallel work

When items are independent, write a brief in `references/` that one worker can follow with no other context: the item key, the evidence with links, the suspect change, and the standard the result must meet. Write "when you can hand work to parallel workers", and do not name a tool. Do not report before every worker returns.

## Report

- The first line gives the outcome.
- Then one block for each item, with the same fields each time and a link for each claim.
- The empty result is exactly one line, such as `No new <items> in <scope> since <time>.`
- The skill does not say whether to post the report or the empty line. The Automation context says when to post nothing.

## Side effects

List each kind of write under **Side effects**, such as "opens pull requests in the target repo" or "comments on the issue that the request names". Action review does not read the skill. Until it does, the Automation context must restate the scope that a run needs, such as the repos it can write to or the teams it can read.

## Leave out

Do not put these in `SKILL.md` or `references/`:

- Schedules, Destinations, and where to post.
- How a run ends, or which tool ends it.
- Different steps for an Automation run and a request by hand, and columns such as "Automation run" and "Manual request".
- Automation instruction templates or setup steps.
- Runtime words:

| Do not write | Write |
| --- | --- |
| `reply`, `noReply`, `reportBlocked`, "Ending a run" | the report, or no report |
| `spawnAgent`, `messageAgent`, Task, Thread | parallel workers |
| `addInboxItem`, Inbox item, review item | ask a person |
| Automation creator, Automation run, Turn, Destination, outcome | the requester, a run |
| `createAutomation`, `watchEvents`, `loadSkill`, how the skill is invoked | nothing |
| "when a scheduled task names this skill" | the work that starts it |
| Guardian, action review | the scope in **Side effects** |

## Validate

You do not need a spec file. Do these steps:

1. Run `junior check` and fix each error.
2. Search the skill for each word in **Leave out**.
3. Run the skill by hand in a local agent turn, such as `junior chat -p "<request>"`, on four cases:
   - an item that needs action
   - an item that needs no action
   - a sweep window with nothing in it: expect only the empty line
   - an item with work already in progress: expect a skip with its link

   Keep the replies and tool calls as evidence for review.
4. When the skill replaces an instruction, compare its decisions with the last runs of the old Automation on the same items.
5. Switch the Automation to the skill with a short context, and read its first runs.

## Name

- Use `automate-<outcome>` when an Automation is the main caller and the skill works on any repo or project. `<outcome>` is what a run produces, as a plural noun: `automate-flaky-test-fixes`, `automate-dependency-updates`.
- A skill for one named system keeps a domain name.
- Do not use caller or schedule words, such as `-daily`, `-sweep`, `-responder`, or `-cron`.
- The directory name is the same as `name`.
