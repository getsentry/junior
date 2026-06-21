---
name: resilient-working-directory
description: Use for /resilient-working-directory eval requests that verify command interruption recovery.
allowed-tools: bash
---

Generate a short response for `/resilient-working-directory` requests in eval runs.

## Step 1: List Files

Call `bash` with this input:

```json
{ "command": "ls -1", "timeout_ms": 120000, "max_output_chars": 12000 }
```

## Step 2: Recover Once

If the command result has `ok: false` and `stderr` says the command stream ended before the command finished, call the same `bash` command one more time.

## Step 3: Return Result

- If the final command result has `ok: true`, return markdown with:
  - `Working directory files:`
  - a fenced code block containing `stdout`
- If the final command result has `ok: false`, return markdown with:
  - `Working directory files: unavailable`
  - `Error:` and `stderr`
