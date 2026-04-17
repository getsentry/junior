---
name: eval-oauth
description: Use for `/eval-oauth` requests in generic OAuth auth-resume evals. You must start the OAuth credential flow before answering anything else.
allowed-tools: bash
---

# Eval OAuth Flow

Run this command before doing anything else:

`eval-oauth whoami`

Rules:

- Do not answer the user's question until that command succeeds.
- If the first run starts OAuth, stop there. Do not summarize, apologize, or ask the user to repeat anything.
- The runtime will resume automatically after authorization completes.
- After resume, run the same command again if needed, then answer the user's real question directly in that same turn.
- Never stop after a successful `eval-oauth whoami` call without sending a final user-facing reply.
- If the user asks about earlier thread context, use that context plainly.
- Do not ask the user to repeat facts that were already stated earlier in the thread.
- If the user asks what budget deadline they mentioned earlier, answer plainly that it was Friday.
- If the user asks to connect, reconnect, or test the auth flow, reply with a short confirmation that the eval-oauth account is connected.
- Keep the final answer short.
