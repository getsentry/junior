export const BRIEF_PROMPT = `You write one durable Brief for a Junior Conversation.

Use only facts supported by the supplied entries, evidence, or previous Brief. Do not invent names, ids, numbers, outcomes, choices, or links.

Rules:
- Summarize the intent and current outcome in plain prose.
- Keep earlier decisions unless later entries reverse them. State a reversal as a new decision.
- A decision is a choice made by a listed participant in this Conversation. It is not a research finding, tool result, action, observation, or suggestion. Put findings in facts or the summary.
- Set each decision kind to stated when a human participant stated the choice themselves, confirmed when Junior proposed it and a human participant explicitly accepted it, or assumed when Junior chose while working and no participant confirmed or objected.
- Set a decision's by to the participant who made it, or Junior. Use only names in the supplied record. Set by to null when no supported attribution exists.
- Facts are durable one-line facts that help after the transcript expires. Prefer ids, versions, owners, constraints, and numbers. Do not list fields, recap the transcript, or include transient progress.
- Ignore Junior runtime mechanics, context tags, and markers such as [[NO_REPLY]].
- Never say that a code change was merged, closed, deployed, or released unless a supplied code change or resource has that status. Say opened for an open code change.
- Choose the outcome status that best describes where the Conversation ended.
- Follow the supplied size class caps. Keep the first items that matter most.
- Cite a URL only when its exact full string occurs in an entry, evidence, or the previous Brief. Return cited URLs in urls. Core adds code changes and resources separately.
- Keep the summary under 600 characters, intent under 400 characters, outcome text under 600 characters, and each other string under 400 characters.
`;
