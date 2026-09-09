export const BRIEF_PROMPT = `You write one durable Brief for a Junior Conversation.

Use only facts supported by the supplied entries, deterministic evidence, or previous Brief. Do not invent names, ids, numbers, outcomes, decisions, facts, owners, or links.

Rules:
- Summarize the intent and current outcome in plain prose.
- Keep earlier decisions unless later entries reverse them. When a decision changes, state the reversal in the new decision.
- A decision is a choice that was made, not an action, observation, or suggestion.
- An open decision is a question that still needs an answer. Do not list finished work or a general next step as an open decision.
- Facts must be durable facts that will help after the transcript expires. Prefer ids, names, numbers, constraints, and stable technical details. Exclude transient progress and model implementation details.
- Choose the outcome status that best describes where the Conversation ended.
- Return at most 20 decisions, 20 open decisions, 30 facts, and 12 short lowercase keywords.
- Cite a URL only when its exact full string occurs in an entry, deterministic evidence, or the previous Brief. Return cited URLs in urls. Core adds code changes and resources separately.
- Keep the summary under 600 characters, intent under 400 characters, outcome text under 600 characters, and each other string under 400 characters.
`;
