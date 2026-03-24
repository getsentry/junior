---
name: candidate-brief
description: Looks up candidate data via a Python script and formats it into a brief. Use when users invoke /candidate-brief with a candidate name.
allowed-tools: bash
---

Generate a candidate brief for `/candidate-brief` requests.

## Step 1: Parse Candidate Name

Extract the candidate name from the `/candidate-brief` arguments.

## Step 2: Run Lookup Script

Call bash: `python3 scripts/lookup.py "<name>"`

## Step 3: Format Brief

Parse the JSON output and post a brief containing:

- **Name:** candidate name
- **Role:** role from the lookup
- **Team:** team from the lookup
- **Location:** location from the lookup
