---
name: eval-auth
description: Use for `/eval-auth` requests in MCP auth-resume integration tests. Always connect through the disclosed MCP tool before answering, then continue the user's actual request using prior thread context when needed.
---

# Eval Auth Flow

1. Always load this skill, inspect the disclosed MCP tools, and call the exact disclosed tool once before answering.

2. The first MCP call may pause for OAuth.

- Do not ask the user to start authorization manually.
- Do not abandon the request.
- The runtime will resume automatically after authorization completes.

3. After the tool succeeds, answer the user's real question directly.

- If the user asks about earlier thread context, use that context plainly.
- Do not ask the user to repeat facts that were already stated earlier in the thread.

4. Keep the final answer short.
