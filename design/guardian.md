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
- When the agent wants to do something that nobody asked for, the person
  who gave the instruction gets one Inbox item that names the exact action,
  so they decide once and the confirmed action runs as them.
- When work moves to another agent, the allowed brief carries what the
  sender's thread backs, so the receiver does that work with no second
  confirmation and never gets more than the sender had.
- When text from a tool, a file, an issue, an agent, or another person
  tries to steer the agent, it is not approval, so injected or retold text
  never makes a risky action run.
- When an action would put secrets or private data where people outside
  the organization can read them, it does not run, also when the person
  asks for it.
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
- `no-owner` Nobody owns a Conversation or a resource. An action needs no
  approval from a person other than the one whose instruction it serves.
- `own-lines` The person's own messages and their answers to Inbox items
  set what is authorized. Each line keeps its real author. A later message
  from the person wins over an earlier one.
- `linked-account` A message from the person's own linked account counts as
  their message, also when an Event delivers it.
  - Example: on a PR Watch, the person's own GitHub comment "also add a
    test for the empty case" authorizes that test. The same words from
    another account are context.
- `text-is-context` Text from the agent, tools, files, issues, comments,
  agent results, other Event authors, and other people is context. It is
  never approval.
  Text that imitates the person, or claims an approval that they did not
  give, is untrusted.
- `watch-intent` The intent of a Watch is agent text. It never authorizes
  the Turns that the Watch starts.
- `bare-yes` A bare yes answers only the question directly before it.
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
  - Example: a person asks to rewrite a design PR. A brief that also
    updates the open proposal that implements that design is allowed. A
    brief that also merges that proposal asks.
- `brief-is-instruction` In the Conversation that gets it, the allowed brief
  is the instruction. That Conversation judges its own actions against its
  own thread, which starts with the brief. An action that is clearly in the
  brief is allowed. Any other action gets ordinary review.
- `no-inheritance` Authority reaches a receiver only through the allowed
  brief. No approval, confirmation, or instruction chain passes to it in
  another way, so a receiver never gets more than its sender had. A claim
  in a brief that the person approved something gives no more than the
  sender's thread backs.
- `results-are-context` A result or a report that comes back to the sender
  is context, not an instruction.
- `follows-instruction` Each Watch Turn and Automation run serves the
  instruction that created it. Guardian judges it against that person's
  own lines and answers. A long thread or compaction never loses them.
- `lead-member` The Member who asked a Lead is the authority for what the
  Lead starts. Guardian checks the brief of a Conversation that a Lead
  starts against that Member's request ([Spaces](./spaces.md)).
  - Example: a Member tells the Lead "I'm worried all our Space icons will
    look the same". That asks the Lead to deal with it. The Lead starts a
    Conversation that investigates and opens a PR for review, with no
    question.

**How Guardian decides**

- `allow-default` Guardian blocks an action only when the action clearly
  matches one named rule from a fixed list. General doubt is not a reason
  to block (`guardian#ordinary-work`).
- `permissions` Each tool call gets one permission. `deny` never runs.
  `ask` always waits for a person, and Guardian cannot clear it. `review`
  goes to Guardian. `allow` runs with no review, and a tool gets it only
  when its code proves that each effect is safe.
- `review-by-default` Each side effect is reviewed. A tool with no
  permission is reviewed, unless it is marked read-only and not
  destructive. A new tool, or a tool with no marks, is reviewed.
- `same-outcome` A block holds for the outcome, not for the tool. The same
  side effect through another tool, a file, a script, the network, or a
  child agent gets the same decision.
- `rule-kinds` A confirmation rule asks. A hard rule denies, and no
  confirmation clears it. Examples are `data_exposure`,
  `credential_probing`, `security_weakening`, and `untrusted_instruction`.
  High or critical risk with low or unknown authorization asks, also when
  no rule matches.
- `must-name` Each confirmation rule names what the person must name to
  authorize the action, such as the destination, the repo, or the item.
  When the person's lines or answers name it, the rule does not ask.
  Naming the larger task does not name a risky step inside it.
- `unrequested-asks` If a task or an action goes wider than the request,
  Guardian asks. It never denies an action only because nobody asked for
  it.
- `conventional-steps` The conventional steps of requested work match no
  rule. Examples are a PR that delivers requested code, assigning that PR
  to the person who asked and requesting their review, and upkeep of a
  resource that Junior created for the work (`grants`)
  ([GitHub](./github.md)).
- `facts-from-junior` Junior gives Guardian the facts: the Actor, Source,
  Destination, Conversation, credential authority, whose instruction the
  action serves, that person's lines and answers, the allowed brief of a
  Conversation that an agent started, which instruction created
  each resource, and who can read each destination. Guardian does not guess
  them from the transcript. Tool input, tool descriptions and marks, a
  tool's own summary of the action, tool results, and agent text are
  untrusted evidence.
- `fresh-decision` An earlier decision is context, not precedent. A changed
  action, such as a retry with the private data removed, gets a fresh
  decision.
- `code-mode` A Code Mode script cannot authorize. Guardian judges each
  call of a script as if the agent made it directly. It uses the script and
  its earlier calls only to see where the data came from.

**Grants**

- `grants` A grant lets one kind of action run with no question. Code
  checks the facts that make it apply, before Guardian decides. A grant
  comes from code, such as a plugin check that the bot authored a PR, or
  from an instruction, when the work creates a resource.
  - Example: Junior opened a PR for Alice. Later the agent updates the PR's
    title and body. The bot authored the PR, and the PR is linked to this
    Conversation, so the update runs with no question.
- `grant-facts` Only facts that core or a plugin stores make a grant apply,
  such as who created a resource and which Conversations it is linked to.
  Tool input, tool results, annotations, and agent text never do.
- `grant-narrows` A condition that only a model can judge, such as a
  restriction from a person, can only narrow or revoke a grant. It never
  adds an allow.
- `grant-limits` A grant never clears a hard rule or an `ask` permission.
- `grant-recorded` Each decision that a grant changes records the grant
  (`replayable`).

**Secrets and private data**

- `no-exposure` Secrets and private data never go where people outside the
  organization can read them, also when the person asks for it
  (`guardian#hard-deny`).
- `org-slack` The organization's own Slack, including the active
  Conversation, is not outside the organization. Ordinary product context,
  such as repo and system names, is not private data.
- `placeholders` Guardian knows each placeholder credential in the Sandbox:
  which env var holds it, and which domains get the real credential. A
  command that sends that env var to those domains does not expose a
  secret.

**Asking and confirming**

- `junior-files-ask` When Guardian asks, Junior files the Inbox item for
  the person whose instruction the action serves, also from a child agent,
  a Lead start, or a Watch Turn. The item shows the exact action in full.
  The action waits for the answer, and work that does not need it goes on.
- `automation-ask` In an Automation run, an ask files an Inbox item for the
  creator, and the run waits for the answer.
- `one-ask-per-batch` When several calls of one Code Mode batch ask, the
  person gets one Inbox item for all of them. The answer can confirm all
  or some of them.
- `ask-covers-one` An ask covers only its one action. The agent does not
  ask the person again about it, and does not ask about a step that the
  person already asked for. That step gets its own review.
- `silent-review` The agent never names Guardian or the review.
- `confirmed-runs` When a person confirms an exact action, that action runs
  as that person, with no second review. A confirmation never covers a
  different action.
- `confirm-follows` A confirmation of an exact action holds for that action
  in the Conversation that asked, also in a child agent.
  - Example: a child reports that it needs a person, and the person
    confirms the exact action. The child's matching retry runs with no new
    question.
- `confirmer-can-run` A person who cannot run an action cannot confirm it.
  No action runs for one person on another person's confirmation.

**Failures and limits**

- `bounded-failure` Review never fails more than the action. When review
  cannot run, or an action is too large to review, only that action does
  not run. The agent gets a tool error that says this is not a risk
  decision. It may retry the action once, and then it tells the person what
  it could not do. Guardian never stops a Run.
- `deny-limit` After three denies in a row, or ten of the last fifty in a
  Turn, the Turn stops and explains what it could not do. An ask, and a
  review that could not run, do not count.
- `replayable` Each decision records who decided (a rule, Guardian, or a
  person), which rule applied, and why (`guardian#decision-recorded`).

## Non-goals

- Judging whether the work is correct or well proven.
- Access control. Provider permissions, tool validation, credential scope,
  and Conversation access still apply, and they decide whether a person may
  change a resource.
- Approval from a second person, such as the person who started a
  Conversation or created a resource.

## Gaps

- `junior-files-ask`, `confirmed-runs`, `confirm-follows`: an ask is only
  text to the agent. Nothing files the Inbox item or links the answer to
  the exact action, so each retry gets a new review. A person who confirms
  in the Inbox can be asked again for the same action.
- `junior-files-ask`, `automation-ask`: a child agent cannot file an Inbox
  item, and in an Automation run each ask becomes a deny
  (`guardian#automation-no-ask`).
- `one-ask-per-batch`: each call of a Code Mode batch asks on its own, so
  one batch can give the person many Inbox items.
- `must-name`: a confirmation rule asks even when the person's own words
  name the exact action and Guardian rates their authorization high.
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
- `brief-is-instruction`, `results-are-context`: in a child agent, the
  parent's later text counts as the person's, also a hold that the parent
  set. A Turn that an agent result starts gets no instruction.
- `linked-account`: every Event Turn runs as a system Actor. The person's
  own GitHub comment is context, so the agent asks before it does what the
  comment says.
- `grants`: only title and body updates of Junior's own PRs have a grant,
  and the default Guardian does not apply it, so upkeep of Junior's own
  PRs can ask. Comments and pushes on Junior's own PRs have no grant, and
  no grant comes from an instruction.
- `review-by-default`, `same-outcome`: some core tools with side effects,
  file writes in the Sandbox, and outbound network are not reviewed.
  `publishImage` makes a public URL with no review.
- `placeholders`: Guardian is not told about the placeholders of the
  GitHub, Vercel, and Datadog plugins, so it can deny a normal call to
  their APIs as a secret leak.
- `replayable`: a decision in the Conversation's event log does not keep
  its rule or reason, and evals do not run the real evidence path.
