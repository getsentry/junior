# Attach GitHub Assets Specification

## Intent

Upload local image and video files to GitHub's user-attachment service and return markdown-ready links for pull requests and issues.

## Scope

In scope:

- Concrete local image and video paths.
- GitHub pull request and issue bodies or comments.
- Repository resolution from an explicit target, Junior config, or the current checkout.

Out of scope:

- Remote URLs, arbitrary file types, or speculative screenshot requests.
- Editing a pull request or issue after upload; the calling workflow owns placement.
- Persisting or printing GitHub credentials.

## Runtime Contract

- Run `scripts/upload.sh` once per local file.
- Return image markdown or a bare video URL.
- Surface per-file failures exactly enough for the user to act.
- Use the GitHub plugin's host-managed credential injection; do not retrieve tokens in the script.

## Reference Architecture

- `SKILL.md` contains trigger, execution, and output rules.
- `scripts/upload.sh` performs deterministic validation, repository resolution, and upload.
- `LICENSE` preserves the upstream MIT license and copyright notice.

## Validation

- `pnpm skills:check` validates skill structure.
- Shell syntax and mocked upload smoke checks cover deterministic script behavior.
- GitHub plugin tests cover credential routing to `uploads.github.com`.

## Known Limitations

- GitHub's user-attachment endpoint is not part of the documented public REST API.
- A real upload requires GitHub to accept the active user credential for the target repository.

## Maintenance Notes

- Keep supported extensions synchronized between `SKILL.md` and `scripts/upload.sh`.
- Preserve `LICENSE` when adapting or moving the skill.
