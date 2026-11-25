import JuniorKit
import Testing

@testable import junior_changelog

@Suite struct BetaTests {
  private let rename = IOSCommit(subject: "feat(ios): Rename a conversation (#4044)")!
  private let fix = IOSCommit(subject: "fix(ios,dashboard): Keep the drawer open (#4050)")!

  @Test func picksTheHighestReleaseTag() {
    #expect(latestRelease(tags: ["0.99.0", "0.313.0", "0.312.1", "v2.0.0", "1.0.0-rc.1", "ios/1.0.0"]) == "0.313.0")
    #expect(latestRelease(tags: ["nightly"]) == nil)
  }

  @Test func readsTheCommitOnTheLastLineOfTheNotes() {
    #expect(betaCommit(notes: "feat(ios): A (#1)\n\nCommit abc1234\n") == "abc1234")
    #expect(betaCommit(notes: "Commit abc1234\nfeat(ios): A (#1)") == nil)
    #expect(betaCommit(notes: "Commit main") == nil)
    #expect(betaCommit(notes: "") == nil)
  }

  @Test func keepsOnlyIOSScopedSubjects() {
    #expect(rename.title == "Rename a conversation (#4044)")
    #expect(rename.category == "New Features ✨")
    #expect(fix.category == "Bug Fixes 🐛")
    #expect(IOSCommit(subject: "feat(ios)!: Drop iOS 17 (#4060)")?.category == "Breaking Changes 🛠")
    #expect(IOSCommit(subject: "ref(ios): Split the shell (#4061)")?.category == "Internal Changes 🔧")
    #expect(IOSCommit(subject: "feat(dashboard): Not iOS (#4062)") == nil)
    #expect(IOSCommit(subject: "Merge main into ios-changelog") == nil)
  }

  @Test func notesEndWithTheCommit() {
    let notes = betaNotes(commits: [rename, fix], commit: "abc1234")
    #expect(notes == "\(rename.subject)\n\(fix.subject)\n\nCommit abc1234")
    #expect(betaNotes(commits: [], commit: "abc1234") == "No iOS changes since the last beta.\n\nCommit abc1234")
  }

  @Test func notesStayUnderTheTestFlightLimit() {
    let commits = Array(repeating: rename, count: 200)
    let notes = betaNotes(commits: commits, commit: "abc1234")
    #expect(notes.utf16.count <= whatToTestLimit)
    #expect(notes.hasSuffix("more.\n\nCommit abc1234"))
    #expect(betaCommit(notes: notes) == "abc1234")
  }

  @Test func addsAnUpcomingSectionThatTheAppReads() {
    let markdown = "# Changelog\n\n## 0.313.0\n\n### New Features ✨\n\n- (ios) Old by @a in [#1](https://x/1)\n"
    let updated = changelog(markdown, upcoming: [rename, fix])
    #expect(updated.hasPrefix("# Changelog\n\n## Upcoming\n\n### New Features ✨\n\n- (ios) Rename a conversation"))
    let releases = ChangelogParser.parse(from: updated)
    #expect(releases.map(\.version) == ["Upcoming", "0.313.0"])
    #expect(
      releases[0].groups == [
        ChangelogGroup(
          title: "New Features ✨",
          entries: ["Rename a conversation ([#4044](https://github.com/getsentry/junior/pull/4044))"]),
        ChangelogGroup(
          title: "Bug Fixes 🐛",
          entries: ["Keep the drawer open ([#4050](https://github.com/getsentry/junior/pull/4050))"]),
      ])
    #expect(changelog(markdown, upcoming: []) == markdown)
  }
}
