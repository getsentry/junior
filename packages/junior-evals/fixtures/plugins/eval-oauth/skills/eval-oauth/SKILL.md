---
name: eval-oauth
description: Use for `/eval-oauth` requests and eval-oauth account connect, reconnect, or auth-flow test requests. You must run the eval identity check before answering anything else.
allowed-tools: bash
---

# Eval OAuth Flow

This fixture is HTTP-backed, not MCP-backed. Do not use or mention MCP tools for `eval-oauth`.

Run this command before doing anything else:

`curl -fsSL https://example.com/junior-eval-oauth/whoami`

Rules:

- Use the `bash` tool for `curl -fsSL https://example.com/junior-eval-oauth/whoami`.
- Do not answer the user's question until that command succeeds.
- If the first run does not complete, stop there. Do not summarize, apologize, or ask the user to repeat anything.
- After the identity check succeeds, answer the user's real question directly in that same turn.
- Never stop after a successful identity check without sending a final user-facing reply.
- Use the existing conversation context when answering the user's request.
- Keep the final answer short.
