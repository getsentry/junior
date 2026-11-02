# Credentials And OAuth

- Long-lived secrets never reach the model or the Sandbox. They stay in host
  storage and host-applied headers.
- Build credential context only with `credentialContextForActor` after the
  run Actor is set. Do not build a parallel Actor or credential shape.
- A subject other than the current Actor needs explicit delegation in the
  durable execution context: a system Actor and `credentialContext.subject`.
  Conversation membership grants no provider authority.
- Everyone who can talk to Junior can use what the service account allows,
  so the provider account must see only what all of them may see.
- Each surface asks `serviceAccountAllows` before it uses the service account
  and `serviceAccountOnly` before it falls back to Actor auth. A new surface
  adds one list to `accounts.service-account` and one request kind to
  `serviceAccountAllows`.
- Deliver authorization URLs privately. Public output has no reusable URL or
  token.
