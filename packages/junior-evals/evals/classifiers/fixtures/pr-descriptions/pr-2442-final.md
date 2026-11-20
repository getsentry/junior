## What this does

Today an event automation can point at one thing in two ways:

- an **identifier**, such as `getsentry/junior#7`, or
- **filters**, such as `repo: getsentry/junior, pullRequest: 7`.

#2407 added filters. This PR starts to move everyone to filters, so later we can delete identifiers (#2362).

When someone creates or edits an event automation and gives an identifier, Junior now saves filters that match exactly the same events. The automation runs exactly as before. It does not start to run for more things.

This PR does not change automations that are already saved. They keep running as they are. A separate draft PR, #2447, converts them later.

Refs #2362

## What it looks like

Someone asks: "tell me when a review is posted on getsentry/junior#7".

The agent still sends this to `createEventAutomation`:

```json
{
  "namespace": "github",
  "resourceType": "pull_request",
  "identifier": "getsentry/junior#7",
  "events": ["pull_request.review.commented"]
}
```

Junior now saves this:

```json
{
  "namespace": "github",
  "events": ["pull_request.review.commented"],
  "match": { "repo": "getsentry/junior", "pullRequest": 7 }
}
```

The dashboard and the automation details show the filters.

What each plugin converts:

| Plugin | Saved as filters                                              | Stays an identifier                                   |
| ------ | ------------------------------------------------------------- | ----------------------------------------------------- |
| GitHub | repo, issue or PR number, release tag, deployment environment | identifiers in a form that GitHub webhooks never send |
| Linear | team key, issue key (`ENG-123`)                               | identifiers in a form that Linear webhooks never send |
| Vercel | project, target, commit                                       | identifiers in a form that Vercel webhooks never send |
| Slack  | channel                                                       | none                                                  |
| Sentry | none                                                          | all of them                                           |

When Junior keeps an identifier, the automation still works. Its details show a short note that says why.

Sentry keeps identifiers because each Sentry identifier contains an org name, and Junior has no way to check that org. If Junior converted an identifier with an old or wrong org, an automation that never ran could start to run for the wrong things.

## Changes to updating an automation

This is the part that changes behavior. It only affects `updateEventAutomation`, the tool that the agent uses.

Before this PR, a new `match` replaced all saved filters. After conversion, the filters are the thing that keeps an automation pointed at one PR. So "also skip drafts" could quietly turn "PR #7" into "every PR in the repo".

Now `match` changes only the filters that it names:

| Update                           | Saved before             | Saved after                                |
| -------------------------------- | ------------------------ | ------------------------------------------ |
| `match: { isDraft: false }`      | `repo`, `pullRequest: 7` | `repo`, `pullRequest: 7`, `isDraft: false` |
| `match: { pullRequest: null }`   | `repo`, `pullRequest: 7` | `repo` (every PR in the repo)              |
| `match: { pullRequest: [7, 8] }` | `repo`, `pullRequest: 7` | `repo`, `pullRequest: [7, 8]`              |
| `match: {}`                      | anything                 | no change                                  |
| `match: { repo: null }`          | `repo`, `pullRequest: 7` | rejected: GitHub PR events need `repo`     |

The identifier rules from #2407 stay the same: leave out `identifier` to keep it, and set it to `null` to drop it.

The dashboard editor shows every filter and saves the whole trigger, so it works the same as before.

Junior now also rejects a trigger that can never run. An example is identifier `getsentry/junior#7` with filter `pullRequest: 5`. The error names the filter. Before, Junior saved the trigger, and it never ran.

## What might break

- **Agent updates that clear filters.** `match: {}` used to remove all filters. Now it does nothing. To remove a filter, set it to `null`.
- **Agent updates that replace filters.** A new `match` used to drop the filters that it left out. Now they stay.
- **Triggers that contradict themselves** now fail to save with an error, instead of saving and never running.
- **Rollback.** No release has #2407 yet. Release 0.266.0 and earlier cannot read an automation with no identifier: one such row breaks the automation list for its whole Slack workspace. Once this ships and people create or edit automations, rolling back past #2407 has that problem. #2407 alone already has the same limit. Each change also saves a version with the old trigger, so a person can restore it from version history.
- **Plugins.** Plugins get a new optional hook, `identifierMatch`, that turns an identifier into filters. Plugins that do not add it keep identifiers. It is temporary, and a later change removes it with identifiers.

## Smaller changes

- Slack channel-message automations now save the channel as a filter.
- A GitHub automation for one PR no longer loads PR data for every PR in the repo when a check suite finishes.
- Version history can show "Junior" as the editor. Nothing writes that yet. #2447 uses it, and this PR adds it first so that #2447 can roll back safely.
- One integration eval now checks the saved trigger instead of the exact tool input, because both forms save the same trigger.

## Checks (head `e9711e4c3`)

- Typecheck, lint, and the GitHub, Sentry, Vercel, and Linear plugin tests pass.
- Core integration tests cover create, the rejected contradiction, each update rule in the table, and that the converted automation runs for PR #7 and not for PR #8.
- Dashboard tests and dashboard e2e pass.
- One core test ("delivers the current automation card") fails the same way on `main`. Some event automation delivery evals and one scheduler eval also fail on other open PRs. These failures are not caused by this PR.
