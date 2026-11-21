# Changelog

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Add
entries under `[Unreleased]`, in categories such as `### Added` or `### Fixed`.
Do not add version sections, and do not change an entry after it ships.

Each TestFlight beta (`.github/workflows/ios-beta.yml`) changes only its own
copy of this file. The entries that no earlier build has become the section
`## [X.Y.Z+N] YYYY-MM-DD`, where `N` is the build number, and the "What to Test"
notes, at most 4,000 characters. The categories set the version: `Removed` or
`Breaking` is a major change (minor before 1.0), only `Fixed` or `Security` is a
patch, and all others are minor. After an update, the app shows the new
sections once. Settings shows the full file.

## [Unreleased]

### Added

- On iPad, the app uses the full screen. Each list shows next to the item that
  you open.
- On a wide screen, the details of a conversation show in a panel at the side.
- On iPad, the app works in all orientations.
- On iPad, you can open more than one window. Each window shows its own screen.
