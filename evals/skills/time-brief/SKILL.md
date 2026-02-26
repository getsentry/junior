---
name: time-brief
description: Produces a lightweight test brief that includes current system time. Use when users invoke /time-brief in eval scenarios where a fast, deterministic skill is preferred over production briefing logic.
allowed-tools: system_time
---

Generate a short response for `/time-brief` requests in eval runs.

## Step 1: Capture Current Time

Call `system_time` with `{}`.

## Step 2: Validate Time Output

Read the tool result and extract `iso_utc`.

- If `iso_utc` is empty, call `system_time` one more time.
- If the second attempt is empty, use `Generated at: unavailable`.

## Step 3: Produce Brief Response

Return exactly this markdown shape:

- `Brief Request:` include original `/time-brief` arguments if present, otherwise `none`
- `Generated at:` timestamp from `iso_utc` (or `unavailable`)
- `Summary:` `Lightweight eval brief completed via test skill.`
