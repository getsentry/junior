# Memory plugin

- The Source sets visibility. Model output never sets it.
- Location and subject are records. They do not grant access.
- Filter by visibility and status before content reaches the model.
- Only the main agent writes memory. Child agent runs get read tools only.
- Do not log or trace memory content, embeddings, source excerpts, or review
  prompts.
- Embeddings are derived indexes, not memory authority. Embedding distance
  only selects candidates; exact content and model review decide duplicates.
- Passive extraction never stores tasks, summaries, secrets, or guesses.
- Do not add provider raw scores together. Search fuses ranks with
  reciprocal rank fusion.
- Event `costUsd` is extra operation cost. Do not repeat cost that the agent
  model usage already records.
