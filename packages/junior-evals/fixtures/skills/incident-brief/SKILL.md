---
name: incident-brief
description: Format a short incident brief. Use when users invoke /incident-brief with an incident name.
---

Generate a short brief for `/incident-brief` requests.

1. Parse the incident name from the command arguments.
2. Reply with:
   - **Incident:** the requested incident name
   - **Status:** Investigating
   - **Owner:** On-call
