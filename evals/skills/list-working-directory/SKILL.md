---
name: list-working-directory
description: Lists files in the sandbox working directory for eval verification. Use when users ask to "list files in the working directory", "show files here", or invoke /list-working-directory in eval scenarios.
allowed-tools: bash
---

Generate a short response for `/list-working-directory` requests in eval runs.

## Step 1: List Files

Call `bash` with this input:

```json
{"command":"ls -1","timeout_ms":120000,"max_output_chars":12000}
```

## Step 2: Return Result

- If `ok` is true, return markdown with:
  - `Working directory files:`
  - A fenced code block containing `stdout`.
- If `ok` is false, return markdown with:
  - `Working directory files: unavailable`
  - `Error:` and `stderr`.
