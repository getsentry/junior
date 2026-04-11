# Task Issue Rules

Use this file only when issue type is `task`.

## Primary Goal

Create a concise execution ticket for maintenance, cleanup, docs, refactors, or operational chores.

## Research Guidance

- Minimal research by default. Prefer first-party repository context when available.
- Include implementation steps only when the thread discusses approach. Otherwise, state the goal and scope.
- Include dependencies or risks only when material.

## Context Generalization

When deriving task content from conversation, generalize to the goal and scope.

Before (session-specific):

> @bob asked in #eng-chat to clean up the unused `legacyAuth` middleware that he noticed while reviewing PR #312

After (generalized):

> Remove unused `legacyAuth` middleware to reduce maintenance surface
