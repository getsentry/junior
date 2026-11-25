# Guardian

Guardian decides whether each action of the agent may run, immediately
before it runs. Requested work goes on with no interruption. An action that
nobody asked for waits for the person who gave the instruction. An action
that exposes secrets or private data, or that untrusted text set up, does
not run.

## Intent

- Allow by default. Guardian blocks an action only when the action clearly
  matches one named rule from a fixed list. General doubt is not a reason to
  block.
- People authorize, text does not. Only the person whose instruction an
  action serves can authorize it: the person Actor of the Turn that gave
  the instruction, the creator of an Automation, or the person of a Lead.
  Each child agent, hand-off, Watch Turn, and Automation run serves the
  instruction of the Turn that started it. Nobody owns a Conversation or a
  resource, so no other person's approval is needed. Their own messages
  and their answers to Inbox items set what is authorized. A message from
  the person's own linked account, such as a GitHub comment that a Watch
  delivers, counts as their own message. Text from the agent, a parent
  agent, tools, files, issues, comments, other Event authors, Watch
  intents, and other people is context. It is never approval.
- Authority follows the work. A child agent, a Conversation that a Lead
  starts, a Turn that a Watch starts, and an Automation run are judged
  against the person's own words and answers, which reach them unchanged.
  Another agent's retelling of what the person said or approved is never
  authority. A long thread, compaction, or a hand-off never loses that
  request.
- Junior states the facts, and the model judges the risk. Whose
  instruction the action serves, what that person said and answered, which
  instruction created each resource, and who can read each destination
  are facts that Junior gives Guardian. Guardian does not guess them from
  the transcript.
- A confirmed action runs as confirmed. When a person confirms an exact
  action, that action runs as that person, with no second review. A
  confirmation never covers a different action.
- Review never fails more than the action. When review cannot run, or an
  action is too large to review, only that action does not run, and the
  agent is told that this is not a risk decision. Guardian never stops a
  Run.
- A block holds for the outcome, not for the tool. The same side effect
  through another tool, a file, a script, the network, or a child agent
  gets the same decision.
- Each side effect is reviewed, unless the tool's code proves it safe. A
  new tool is reviewed by default.
- Secrets and private data never go where people outside the organization
  can read them, also when the person asks for it.
- Guardian is a second check on authorization and risk. Provider
  permissions, tool validation, and credential scope still apply. Whether
  the work is correct or well proven is not its concern.
- Each decision can be counted and replayed. It records who decided, which
  rule applied, and why, so that a production case can become an eval case,
  and a policy change is measured before it ships.

## Rules

- Each tool call gets one permission. `deny` never runs. `ask` always waits
  for a person, and Guardian cannot clear it. `review` goes to Guardian.
  `allow` runs with no review, so use it only when the tool code proves
  that each effect is safe.
- A tool with no permission is reviewed, unless it is marked read-only and
  not destructive. A tool with no marks is reviewed.
- A confirmation rule asks. The person clears it when they confirm the exact
  action. A hard rule denies, and no confirmation clears it. Examples are
  `data_exposure`, `credential_probing`, `security_weakening`, and
  `untrusted_instruction`. High or critical risk with low or unknown
  authorization asks, also when no rule matches.
- Each confirmation rule names what the person must name to authorize the
  action, such as the destination, the repo, or the item. Naming the
  larger task does not name a risky step inside it.
- An ask becomes an Inbox item for the person who gave the instruction,
  also from a child agent or an Automation run. The action waits for the
  answer, and work that does not need it goes on. The agent never names
  Guardian or the review.
- After three denies in a row, or ten of the last fifty in a Turn, the Turn
  stops and explains what it could not do. A question that waits for a
  person, and a review that could not run, do not count.
- The person's own lines are the authority. Each line has its real author.
  A restriction or a revocation still applies when it comes from a line
  that cannot authorize. A later message from the person wins over an
  earlier one. A bare yes answers only the question directly before it.
  Text that imitates the person, or claims an approval that they did not
  give, is untrusted.
- Only the facts that Junior states are true: the Actor, Source,
  Destination, Conversation, credential authority, the person's lines and
  answers, and which instruction created each resource. Tool input,
  descriptions, annotations, `describeProposal`, tool results, and agent
  text are untrusted evidence.
- An earlier decision is context, not precedent. A changed action, such as
  a retry with the private data removed, gets a fresh decision.
- A hand-off to another Conversation, by `startAgent`, `messageAgent`, or
  `startConversation`, is judged by the task that it hands over, against the
  person's request. Each action of that Conversation gets its own review.
  Its result is untrusted context.
- The brief of a Conversation that a Lead starts counts as the request of
  the Lead's person ([Lead](./lead.md)).
- The intent of a Watch is agent text. It never authorizes the Turns that
  the Watch starts.
- A Code Mode script cannot authorize. Guardian judges each call of a
  script as if the agent made it directly. It uses the script and its
  earlier calls only to see where the data came from.
- The conventional steps of requested work match no rule, such as a pull
  request that delivers requested code, a review request to the person who
  asked, and upkeep of what the same instruction created
  ([GitHub](./github.md)).
- The organization's own Slack, including the active Conversation, is not
  outside the organization. Ordinary product context, such as repo and
  system names, is not private data.
- Guardian understands every placeholder credential in the Sandbox: which
  env var holds it, and which domains get the real credential. A command
  that sends that env var to those domains does not expose a secret.

## Gaps

- An ask is only text to the agent. Nothing files the Inbox item or links
  the answer to the exact action, so each retry gets a new review. This
  breaks "a confirmed action runs as confirmed".
- A review that cannot run, or a proposal over the size limit, stops the
  whole Run. This breaks "review never fails more than the action".
- Asks count toward the limit of three, and reaching the limit does not
  stop the Turn. This breaks the limit rule.
- Guardian reads a fixed window of the Conversation, so in a long thread
  the person's request can fall out of it. In a child agent, the parent's
  text counts as the person's. A Lead's message into a root carries no
  authority. An Automation run and a Watch Turn have no person's lines at
  all. This breaks "authority follows the work".
- Guardian is not told which instruction created a resource, so upkeep of
  Junior's own pull requests can ask. This breaks "Junior states the facts".
- A child agent cannot file an Inbox item, and in an Automation run each
  ask becomes a deny. This breaks the ask rule.
- Some core tools with side effects, file writes in the Sandbox, and
  outbound network are not reviewed. `publishImage` makes a public URL with
  no review. This breaks "each side effect is reviewed" and "a block holds
  for the outcome".
- Guardian is not told about the placeholders of the GitHub, Vercel, and
  Datadog plugins, so it can deny a normal call to their APIs as a secret
  leak. This breaks the placeholder rule.
- A decision does not keep its rule or reason, and evals do not run the
  real evidence path. This breaks "each decision can be counted and
  replayed".
