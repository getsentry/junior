---
name: candidate-executive-summary
description: Build a thorough executive candidate dossier from public signals. Use when asked to "summarize a candidate", "evaluate this candidate", "build a candidate profile", "do candidate research", "assess a hiring candidate", or "grade this candidate". Produces highlights, risks, timeline analysis, and a letter grade aligned to Sentry hiring signals.
---

Create an executive-grade candidate assessment using public evidence.

## Step 1: Confirm Candidate Identity

Disambiguate before research:

1. Require at least two identifiers:
- Full name
- Current or recent company
- GitHub handle
- LinkedIn URL
- X handle
- Location
2. If identity is ambiguous, ask a single focused follow-up question and pause.
3. Record all aliases and profile URLs used so findings are auditable.

## Step 2: Gather Evidence Thoroughly

Use broad and deep public research. Do not rely on one source class.

Collect evidence for each required signal:

1. GitHub contributions:
- Activity recency, consistency, and depth
- Owned repositories vs drive-by commits
- PR quality, reviews, issue triage, maintainership
- Evidence of architecture-level work
2. CV / work history:
- Scope, seniority progression, role clarity
- Short stints and plausible explanations
- Ownership of outcomes (not proximity to outcomes)
3. Public presence (especially X):
- Technical clarity and signal-to-noise
- Professional judgment and communication style
- Curiosity and informed opinions
4. Public speaking:
- Conference talks, meetups, podcasts, panels
- Topic depth and ability to explain tradeoffs
5. Notable achievements:
- Patents, papers, major OSS maintainership, awards
- Verify authorship and impact where possible
6. Tenure quality ("no short stints"):
- Build a timeline and flag patterns of <18 month stints
- Exclude reasonable cases (acquisition, contract role, internal transfer, clear promotion path)

Also capture location fit signals:
- Current location and work-region alignment with Sentry hubs (San Francisco, Vienna, Toronto)
- Remote history and cross-timezone collaboration indicators

For search strategy and minimum source coverage, read [references/research-checklist.md](references/research-checklist.md).

## Step 3: Evaluate Against Executive Signals

Assess the profile against these judgment signals:

- Sharpness and responsiveness
- Staying with the thread vs drifting/rambling
- Curiosity and opinion quality
- Tooling opinions and technical taste
- Ability to talk shop and explain prior work clearly
- Depth under drill-down: did they build it or just observe it
- Technical risk identification quality
- Collaboration, ambition, conflict handling
- Self-motivation and intellectual honesty
- Deliberate self-investment over time

When direct interview evidence is unavailable, infer only from public artifacts and clearly label each inference as:
- `High confidence` (direct evidence)
- `Medium confidence` (strong proxy)
- `Low confidence` (weak/indirect proxy)

For grading, weighting, and confidence handling, read [references/scoring-rubric.md](references/scoring-rubric.md).

## Step 4: Produce Output

Return a concise executive report in this exact structure:

```markdown
# Candidate Executive Summary: <Name>

## Identity Confidence
- Candidate: ...
- Disambiguation confidence: High | Medium | Low
- Identifiers used: ...

## Overall Grade
- Letter grade: A+/A/A-/B+/B/B-/C+/C/C-/D/F
- Confidence: High | Medium | Low
- One-line verdict: ...

## Highlights
- ...

## Lowlights / Risks
- ...

## Signal-by-Signal Assessment
### 1) GitHub Contributions
- Evidence:
- Interpretation:
- Confidence:

### 2) CV / Career Trajectory
- Evidence:
- Interpretation:
- Confidence:

### 3) Public Presence (X + other)
- Evidence:
- Interpretation:
- Confidence:

### 4) Public Speaking
- Evidence:
- Interpretation:
- Confidence:

### 5) Notable Achievements (patents/papers/etc.)
- Evidence:
- Interpretation:
- Confidence:

### 6) Tenure Quality (short stint analysis)
- Timeline summary:
- Flags:
- Legitimate exceptions:
- Confidence:

## Executive Signal Mapping (Dave Rubric)
- Sharpness:
- Communication precision:
- Curiosity/opinions:
- Technical depth under drill-in:
- Risk judgment:
- Collaboration/ambition:
- Self-motivation/integrity:

## Location Fit
- Current/likely location:
- Sentry hub alignment (SF/Vienna/Toronto):
- Timezone/collaboration implications:

## Open Questions for Interview Panel
- ...

## Sources
- [Title](URL) - what it supported
- ...
```

## Step 5: Quality Bar and Guardrails

1. Be evidence-first; avoid vibe-only conclusions.
2. Distinguish fact from inference.
3. Do not fabricate unavailable data.
4. If evidence is thin, say so explicitly and lower confidence.
5. Avoid protected-class speculation or non-job-relevant personal judgments.
6. Keep conclusions actionable for a hiring discussion.

## Exit Criteria

Complete only when all are true:

1. All six required signals are covered.
2. Tenure timeline is analyzed with exceptions considered.
3. Location fit is addressed.
4. Letter grade and confidence are provided.
5. Source list is included and traceable.
