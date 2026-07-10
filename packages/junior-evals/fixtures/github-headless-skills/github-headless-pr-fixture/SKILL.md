---
name: github-headless-pr-fixture
description: Use for subscribed GitHub pull request events involving the local headless PR fixture repository.
---

# Headless Pull Request Fixture

The watched repository is at `skills/github-headless-pr-fixture/project`.

The setup creates a local bare Git remote and checks out the existing pull
request branch. Run `setup.sh`, fix the reported failure in the project, commit
and push the existing branch, then run `verify.sh`. Do not request GitHub OAuth
or contact GitHub.
