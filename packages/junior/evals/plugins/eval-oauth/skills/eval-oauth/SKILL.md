---
name: eval-oauth
description: Use for `/eval-oauth` requests in generic OAuth auth-resume evals. You must start the OAuth credential flow before answering anything else.
allowed-tools: bash
requires-capabilities: eval-oauth.read
---

# Eval OAuth Flow

Run this command before doing anything else:

`jr-rpc issue-credential eval-oauth.read`

Rules:

- Do not answer the user's question until that command succeeds.
- If the first run starts OAuth, stop there. Do not summarize, apologize, or ask the user to repeat anything.
- The runtime will resume automatically after authorization completes.
- After resume, run the same command again if needed, then answer the user's real question directly.
- If the user asks about earlier thread context, use that context plainly.
- Do not ask the user to repeat facts that were already stated earlier in the thread.
- Keep the final answer short.
