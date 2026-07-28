---
name: coding-workspace-fixture
description: Use for eval coding fixture tasks involving the small TypeScript project under skills/coding-workspace-fixture/project.
allowed-tools: bash readFile writeFile
---

# Coding Workspace Fixture

The fixture project lives at `skills/coding-workspace-fixture/project`.
Inspect relevant files before changing them, make only the requested change,
and answer with the file paths and result. After an edit, finish with one
concise line that names every changed path and states the resulting value or
behavior. Do not omit either part.

When asked to create a file, write it with a file tool and read it back before
claiming success. On later turns, reuse the exact existing path in this fixture
workspace; do not report a missing file without first listing its parent
directory.
