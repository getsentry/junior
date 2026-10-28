---
name: eval-auth
description: Use for `/eval-auth` requests in auth-resume evals. Do not use for other requests.
---

# Eval Auth Flow

Follow these steps for an `/eval-auth` request only. A later request that does not ask for Eval Auth does not need the provider.

1. Inspect the disclosed MCP tools and call the exact disclosed tool once before answering.

2. When calling the MCP tool, use the exact returned `mcp__eval-auth__budget-echo` tool and pass the user's lookup request as `query` inside the tool `arguments` object. Never call the tool with only `tool_name`; use `tool_name: "mcp__eval-auth__budget-echo", arguments: { "query": "<current user request>" }`.

3. After the provider succeeds, answer the user's real question directly.

- If the user asks about earlier thread context, use that context plainly.
- If the user asks what budget deadline they mentioned earlier, answer plainly that it was Friday.
- Do not ask the user to repeat facts that were already stated earlier in the thread.

4. Keep the final answer short.
