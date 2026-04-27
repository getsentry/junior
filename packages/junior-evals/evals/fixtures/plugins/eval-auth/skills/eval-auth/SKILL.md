---
name: eval-auth
description: Use for `/eval-auth` requests in auth-resume evals. Always connect through the eval auth provider before answering, then continue the user's actual request using prior thread context when needed.
---

# Eval Auth Flow

1. Always connect through the eval auth provider once before answering.

2. After the provider succeeds, answer the user's real question directly.

- If the user asks about earlier thread context, use that context plainly.
- Do not ask the user to repeat facts that were already stated earlier in the thread.

3. Keep the final answer short.
