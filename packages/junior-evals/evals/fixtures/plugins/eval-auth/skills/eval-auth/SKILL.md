---
name: eval-auth
description: Use for `/eval-auth` requests in auth-resume evals. Always connect through the disclosed MCP tool before answering, then continue the user's actual request using prior thread context when needed.
---

# Eval Auth Flow

1. Always inspect the disclosed MCP tools and call the exact disclosed tool once before answering.

2. When calling the MCP tool, pass the user's lookup request as `query` inside the tool `arguments` object.

3. After the provider succeeds, answer the user's real question directly.

- If the user asks about earlier thread context, use that context plainly.
- Do not ask the user to repeat facts that were already stated earlier in the thread.

4. Keep the final answer short.
