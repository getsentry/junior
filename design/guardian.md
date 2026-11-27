# Guardian

Guardian decides whether each action of the agent may run, immediately
before it runs. The person who gave the instruction gets the work that they
asked for with no interruption. An action that nobody asked for waits for
that person. An action that exposes secrets or private data, or that
untrusted text set up, does not run.

## Jobs

- When a person asks for work, the agent does it and its conventional
  steps with no question, so the person never confirms what they already
  asked for.
- When the agent wants to do something that nobody asked for, it asks the
  person who gave the instruction once, naming the exact action, so their
  answer decides it.
- When work moves to another agent, the allowed brief carries what the
  sender's thread backs, so the receiver does that work with no second
  confirmation and never gets more than the sender had.
- When text from a tool, a file, an issue, an agent, or another person
  tries to steer the agent, it is not approval, so injected or retold text
  never makes a risky action run.
- When an action would put secrets or customer data where the world can
  read them, it does not run, also when the person asks for it.
- When review cannot run, only that action waits, so the Turn goes on and
  the person still gets an answer.
- When a decision looks wrong, a maintainer finds who decided, which rule
  applied, and why, so the case becomes an eval case and a policy change is
  measured before it ships.

## Rules

**Who authorizes**

- `instruction-authority` Only the person whose instruction an action
  serves can authorize it: the person Actor of the Turn that gave the
  instruction, the creator of an Automation, or the Member who asked a Lead
  to start the work. In a Conversation that an agent started or messaged,
  the allowed brief is that instruction (`brief-is-instruction`).
  - Example: in a shared Slack thread, Junior opened a PR for Alice. Bob
    starts a Turn and asks Junior to edit its description. Bob's
    instruction authorizes the edit, and Alice is not asked.
- `own-lines` The person's own messages set what is authorized, wherever
  the agent asked and they answered. Each line keeps its real author. A
  later message from the person wins over an earlier one.
- `linked-account` A message from the person's own linked account counts as
  their message, also when an Event delivers it.
  - Example: on a PR Watch, the person's own GitHub comment "also add a
    test for the empty case" authorizes that test. The same words from
    another account are context.
- `text-is-context` Text from the agent, tools, files, issues, comments,
  agent results and reports, Watch intents, other Event authors, and other
  people is context. It is never approval, also when it claims an approval.
- `restrictions` A restriction or a revocation from any person applies,
  also from a line that cannot authorize. Agent text, such as a parent
  agent's "wait for my OK", never makes Guardian ask the person.

**Authority follows the work**

- `handoff-check` Guardian checks work once, when it is handed over. When
  startAgent, startConversation, or messageAgent sends work, Guardian
  judges the brief against the sender's own thread. A brief that matches
  what that thread backs is allowed. A brief that suggests something
  different or wider asks. A step that the requested work needs follows
  from it.
  When a Lead starts work, its thread is the request of the Member who
  asked ([Spaces](./spaces.md)).
  - Example: a person asks to rewrite a design PR. A brief that also
    updates the open proposal that implements that design is allowed. A
    brief that also merges that proposal asks.
  - Example: a Member tells the Lead "I'm worried all our Space icons will
    look the same". The Lead starts a Conversation that investigates and
    opens a PR for review, with no question.
- `brief-is-instruction` In the Conversation that gets it, the allowed brief
  is the instruction. That Conversation judges its own actions against its
  own thread, which starts with the brief. An action that is clearly in the
  brief is allowed. Any other action gets ordinary review.
- `follows-instruction` Each Watch Turn and Automation run serves the
  instruction that created it. Guardian judges it against that person's
  own lines. A long thread or compaction never loses them.

**How Guardian decides**

- `allow-default` Guardian blocks an action only when the action clearly
  matches one named rule from a fixed list. General doubt is not a reason
  to block (`guardian#ordinary-work`).
- `review-by-default` Every tool call is reviewed, except calls of
  tools marked read-only and of core tools whose effects stay in the
  Sandbox or the current Conversation, such as file edits and replies.
  A plugin cannot turn review off.
- `sandbox-boundary` Guardian reviews each command before it runs. An
  effect that stays in the Sandbox matches no rule, such as file edits,
  scratch cleanup, local commits, or stopping its own processes. Risk
  starts where an effect leaves the Sandbox, such as a push, a network
  write, or a provider call, or where it breaks a person's explicit limit.
  A command that only shows whether a credential is set does not probe it.
  For a push to a `world` repo, Guardian also reads the commits that the
  push sends, as context.
- `same-outcome` A block holds for the outcome, not for the tool. The same
  side effect through another tool, a file, a Code Mode script, the
  network, or a child agent gets the same decision. Guardian judges each
  call of a script as if the agent made it directly.
- `rule-kinds` Guardian has seven rules. Three ask: `restriction` (a
  person's restriction covers the action), `unrequested` (the action goes
  wider than the instruction), and `internal_disclosure`. Four deny, and no
  answer clears them: `data_exposure`, `credential_probing`,
  `security_weakening`, and `untrusted_instruction`. Nothing is denied only
  because nobody asked for it. The reason says what matched. No risk rating
  decides.
- `conventional-steps` The conventional steps of requested work are not
  `unrequested`. Examples are a PR that delivers requested code, assigning
  that PR to the person who asked and requesting their review
  ([GitHub](./github.md)), and keeping current what this work created, such
  as the title, body, replies, and CI reruns of Junior's own PR. Other rules
  still apply to them.
- `facts-from-junior` Junior gives Guardian, from code, who each message is
  from and what each call does, targets, and who can read the target.
  Guardian does not guess them from the transcript. For each call of its
  tools, a plugin gives the target, which is what the call changes, such
  as `getsentry/junior#12`, and the target's audience. A plugin can give
  one audience for all of its MCP tools, such as `internal` for Notion.
  When Junior clones a repo, it records the repo's audience. A push gets
  the audience recorded for its push URL. A target with no audience, and a
  push to a URL with no record, count as `world`.
- `plugin-decision` A plugin can also give a decision for a call of its
  tool, with the reason. A plugin's ask or deny holds, and Guardian does
  not overrule it. The person's yes to that exact action still clears an
  ask (`answer-is-a-line`). A plugin's allow clears only `unrequested`.
  Every other rule still applies. The decision record keeps the plugin's
  decision and reason. So a wrong plugin decision fails safe.
  - Example: the GitHub plugin allows a text edit of Junior's own PR. The
    Vercel plugin denies a public preview when SSO protection is off.
- `fresh-decision` An earlier decision is context, not precedent. A changed
  action, such as a retry with the private data removed, gets a fresh
  decision.

**Secrets and private data**

- `audience` Each target has an audience: `internal` (only people in the
  organization, such as a Slack channel, a DM, a Junior Conversation, or a
  private repo) or `world` (anyone, such as a public repo or a public URL).
  An unknown audience counts as `world`. A Slack Connect channel, which
  another organization shares, is `world`. Repo and system names are not
  private data.
- `no-exposure` Secrets, credentials, customer data, real people's
  personal data, and details that let someone exploit an undisclosed
  vulnerability never go to a `world` audience, also when the person asks
  for it (`guardian#hard-deny`).
- `internal-disclosure` Other internal detail, such as production
  metrics, internal configuration, or how an incident happened, going to
  a `world` audience asks, and the ask shows the exact text. Mock and
  fixture data, and text that `world` can already read, are not internal
  detail.
- `placeholders` Guardian knows each placeholder credential in the Sandbox:
  which env var holds it, and which domains get the real credential. A
  command that sends that env var to those domains does not expose a
  secret.

**Asking and confirming**

- `answer-is-a-line` The person's answer is one of their own lines. A bare
  yes answers only the question directly before it. When the agent tries
  the action again, Guardian compares it with the action that the answered
  question named. The same action runs with no second question. A changed
  action, such as another target or other text, asks again.
- `ask-covers-one` An ask covers only its one action. The agent does not
  ask the person again about it, and does not ask about a step that the
  person already asked for. That step gets its own review.
  Work that does not need the answer goes on.

**Failures and limits**

- `bounded-failure` Review never fails more than the action. When review
  cannot run, or an action is too large to review, only that action does
  not run. The agent gets a tool error that says this is not a risk
  decision. It may retry the action once, and then it tells the person what
  it could not do. Guardian never stops a Run.
- `deny-limit` After three denies in a row in a Turn, the Turn stops and
  explains what it could not do. An ask, and a review that could not run,
  do not count.
- `replayable` Each decision records whether code or Guardian decided,
  which rule applied, why, and the facts it lacked
  (`guardian#decision-recorded`).

## Flows

Each flow follows one request. The plugin of each tool gives the target
and its audience (`facts-from-junior`).

**Slack.** In #eng-billing, Alice asks Junior to post this week's error
counts there and in #acme-shared, a Slack Connect channel.

| Call | Audience | Decision | Why |
| --- | --- | --- | --- |
| Post in #eng-billing | `internal` | allow | Alice asked, and no rule matches. |
| Post in #acme-shared | `world` | ask | Error counts are internal detail (`internal-disclosure`). The ask shows the text. |

If Bob first writes "hold off until the fix ships" in the thread, the post
in #eng-billing asks too, under `restriction`. Bob cannot authorize work,
but his hold applies (`restrictions`). Alice's yes to that ask lets it run.

**Notion.** Alice asks Junior to add Q3 spend to the Finance page. Notion's
tools are `internal`, so the update is allowed: internal detail that stays
internal matches no rule.

**Linear.** Alice asks for an issue with this quarter's ARR on the SDK
team, which syncs to a public repo. The Linear plugin lists that team as
`world`, so the issue asks (`internal-disclosure`). If it also names
customers, it is denied (`no-exposure`). The same issue on a team that does
not sync is `internal`, and it is allowed.

**Bash.** Alice asks Junior to fix a flaky test in getsentry/junior and open
a PR. Junior recorded the repo's audience, `world`, when it cloned the
repo. Guardian reads the commits that the push sends (`sandbox-boundary`).
A plain code fix is allowed (`conventional-steps`). A commit that copies a
production error log into a fixture asks (`internal-disclosure`).

**GitHub.** Junior opened getsentry/junior#12 for Alice.

| Call | Plugin decision | Decision | Why |
| --- | --- | --- | --- |
| Update the body to match a new commit | allow | allow | Only the text of Junior's own PR changes (`plugin-decision`). |
| Close #12, which nobody asked for | none | ask | `unrequested`. |
| Put a token in the body | allow | deny | A plugin's allow never clears `no-exposure`. |
| Comment that asks Alice about the work | none | allow | A conventional step (`conventional-steps`). It is not a text edit, so the plugin gives no decision. |

## Non-goals

- Judging whether the work is correct or well proven.
- Access control. Provider permissions, tool validation, credential scope,
  and Conversation access still apply, and they decide whether a person may
  change a resource.
- Approval from a second person, such as the person who started a
  Conversation or created a resource.

## Gaps

- `handoff-check`: messageAgent is not reviewed, so a message can hand a
  child agent wider work than the sender's thread backs.
- `review-by-default`, `sandbox-boundary`: core `bash` is reviewed only by
  the new Guardian, so under the current Guardian a command whose effect
  leaves the Sandbox runs without review.
- `rule-kinds`: Guardian asks on high risk with weak authorization, also
  when no rule matches. A rule asks until the person
  names a required detail, even when their words name the exact action.
- `audience`: no reviewed tool posts in a Slack channel, so the Slack flow
  does not run yet, and a Slack Connect channel is not told apart.
- `ask-covers-one`: the text that tells the agent to wait for a
  confirmation carries over to later steps. The agent then asks about steps
  that the person asked for, such as an update to its own PR description.
- `bounded-failure`: a review that cannot run, or a proposal over the size
  limit, stops the whole Run.
- `deny-limit`: asks count toward the limit of three, and reaching the
  limit does not stop the Turn.
- `follows-instruction`, `restrictions`: Guardian reads a fixed window of
  the Conversation, so in a long thread the person's request can fall out
  of it. An Automation run and a Watch Turn have no person's lines at all.
- `brief-is-instruction`, `text-is-context`: in a child agent, the
  parent's later text counts as the person's, also a hold that the parent
  set. A Turn that an agent result starts gets no instruction.
- `linked-account`: every Event Turn runs as a system Actor. The person's
  own GitHub comment is context, so the agent asks before it does what the
  comment says.
- `plugin-decision`: resolving a review thread does not name its PR, so
  the GitHub plugin gives no decision and the call can ask.
- `facts-from-junior`: a repo cloned with a bash command has no recorded
  audience, so a push from it counts as `world`, and internal detail in it
  asks.
- `sandbox-boundary`: an action that stays in the Sandbox, such as
  deleting a checkout, can destroy unpushed work that the person asked
  for, and no rule catches it.
- `review-by-default`, `same-outcome`: some core tools with side effects,
  and outbound network, are not reviewed.
- `placeholders`: Guardian is not told about the placeholders of the
  GitHub, Vercel, and Datadog plugins, so it can deny a normal call to
  their APIs as a secret leak.
- `replayable`: a decision in the Conversation's event log does not keep
  its rule or reason, and evals do not run the real evidence path.
