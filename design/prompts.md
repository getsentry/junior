# Prompts

The model reads one system prompt with the rules for every Turn, then the
context of the request, then the words of the person. Operators add voice
and facts about their world. Plugins add guidance.

## Intent

- The system prompt is the same in every Turn of one deployment and mode.
  The prompt cache holds, and behavior stays stable. Facts for one request
  come after it, each in its own tagged block.
- The model can tell who wrote each block. Text from tools, other agents,
  and people outside the request is data. It never gives approval.
- Each rule has one home: code, a tool, the system prompt, or a skill. A
  rule that code can enforce lives in code, because the model does not
  follow text every time.
- Steering text is plain. Each rule says what to do and, when that is not
  obvious, why, so the model can apply it to new cases.

## Entry points

- Operators: `SOUL.md` for voice and `WORLD.md` for facts and workflow.
- Plugins: fixed guidance in the system prompt, and context for each
  request.
- Repos: `AGENTS.md` in a checkout, at Turn start and when it changes.

## Rules

- Core rules win over operator voice, operator facts, and plugin guidance.
- Core behavior works the same with no `SOUL.md` and no `WORLD.md`.
- Plugin guidance in the system prompt is the same in every request. Text
  that changes goes in the context of the request.
- Tags only help the model tell sources apart. They grant nothing. Junior
  takes approval from the stored record of who asked, and from Guardian.
- The words of a person never share a block with text from another source.
  Text from outside the request never goes in the system prompt.
- The author of a message comes from the platform that delivered it, never
  from the message text.
- Each kind of input has its own tag, with the same name in every Turn.
- Model-read text calls the agent "you" or uses its configured name. It
  never uses a fixed name.
- Capitals, "IMPORTANT", and "NEVER" mark only a hard limit, whose break
  fails the task or breaks safety.
- Length, count, and time are numbers, such as "1–3 sentences", not words
  such as "concise".
- A rule that stops an output habit quotes the output to avoid.
- A restraint, such as "do not widen scope", and its opposite failure, such
  as stopping early, are tested in the same evals.
- Text names only the tools, arguments, and modes that exist where it
  shows.

## Gaps

- Some core rules set length with words, not numbers: "concise",
  "briefly", and "as short as the job allows". The rules for child agents,
  Automation runs, and Quick questions use them. This breaks "length,
  count, and time are numbers".
- The rules of a child agent tell it to ask a person with `addInboxItem`.
  A child agent cannot use the Inbox, so that tool is disabled in its Turn.
  This breaks "text names only the tools, arguments, and modes that exist
  where it shows".
