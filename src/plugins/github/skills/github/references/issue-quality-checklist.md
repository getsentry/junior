# Issue Quality Checklist

Run this checklist before create/update mutation.

## External Quality Signals

- Does the issue contain user names, slash commands, or channel references from the originating conversation? If so, generalize.
- Is the issue concise and still actionable?
- Are unknowns called out instead of guessed?
- Are concerns included only when material?

Useful external guidance:
- GitHub docs, creating and structuring issues: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-an-issue
- GitHub docs, issue templates: https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/about-issue-and-pull-request-templates
- Stack Overflow, minimal reproducible example standard: https://stackoverflow.com/help/minimal-reproducible-example
- Mozilla Bugzilla, bug writing guidance: https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html

## Internal Quality Bar

- Issue type chosen and stated (`bug`, `feature`, or `task`).
- Title is specific and <= 60 characters.
- Summary is short and clear.
- Analysis depth matches the issue type.
- Verified claims have sources.
- Timeline statements use exact dates when known.
- Confidence is explicit when certainty is low.
- Concerns are included only when meaningful.

## Negative Calibration

Avoid these anti-patterns:
- Overlong, sprawling issue bodies with no clear sections
- Confident solution claims that are weakly evidenced
- Speculative detail mixed into verified sections
