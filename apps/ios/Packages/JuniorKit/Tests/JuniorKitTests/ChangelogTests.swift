// The version-range cases are ported from armcknight/pippin
// (Tests/PippinCore/ChangelogParserTests.swift), https://github.com/armcknight/pippin,
// under the MIT License. Copyright (c) 2016 Andrew McKnight. The full license
// text is in Sources/JuniorKit/Changelog/Changelog.swift.

import Testing

@testable import JuniorKit

private let pull = "https://github.com/getsentry/junior/pull"

@Suite struct ChangelogTests {
  /// Craft's format, newest first: a summary, categories, and scope groups.
  private let changelog = """
    # Changelog

    ## 0.313.0

    Junior removes legacy brief handling.

    ### New Features ✨

    Inbox adds filters and navigation.

    #### Dashboard

    - Filter the Inbox by ask type by @BYK with @sentry-junior in [#3966](\(pull)/3966)

    #### Ios

    - Rename a conversation by @armcknight with @sentry-junior in [#4044](\(pull)/4044)

    ### Bug Fixes 🐛

    #### Other

    - (agent) Name the next call by @dcramer in [#4013](\(pull)/4013)
    - (ios) Read Conversations from Junior 0.310 by @armcknight and @claude in [#3884](\(pull)/3884)

    ### Internal Changes 🔧

    #### Ios

    - Build, test, and screenshot the iOS app by @armcknight in [#3605](\(pull)/3605)

    ## 0.312.0

    ### New Features ✨

    #### Ios

    - IPad layout by @armcknight with @sentry-junior in [#3892](\(pull)/3892)

    ## 0.311.0

    ### Bug Fixes 🐛

    - (slack) Not an iOS entry by @dcramer in [#3744](\(pull)/3744)

    ## 0.310.0

    ### New Features ✨

    - (ios) Add a native iOS client by @gricha and @claude in [#3544](\(pull)/3544)
    """

  private var releases: [ChangelogRelease] { ChangelogParser.parse(from: changelog) }

  private func versions(since: String, upTo: String) -> [String] {
    ChangelogParser.releases(since: since, upTo: upTo, from: releases).map(\.version)
  }

  @Test func keepsOnlyIOSEntries() {
    #expect(releases.map(\.version) == ["0.313.0", "0.312.0", "0.310.0"])
    #expect(
      releases[0].groups == [
        ChangelogGroup(
          title: "New Features ✨", entries: ["Rename a conversation ([#4044](\(pull)/4044))"]),
        ChangelogGroup(
          title: "Bug Fixes 🐛",
          entries: ["Read Conversations from Junior 0.310 ([#3884](\(pull)/3884))"]),
      ])
    #expect(releases[2].groups.map(\.entries) == [["Add a native iOS client ([#3544](\(pull)/3544))"]])
  }

  @Test func keepsAnEntryWithoutAuthors() {
    let entry = ChangelogParser.iosEntry("(iOS) Rename a conversation (#4044)", scope: nil)
    #expect(entry == "Rename a conversation (#4044)")
    #expect(ChangelogParser.iosEntry("Rename a conversation", scope: "Other") == nil)
  }

  @Test func oneVersionToTheNextShowsThatVersion() {
    #expect(versions(since: "0.312.0", upTo: "0.313.0") == ["0.313.0"])
  }

  @Test func oldReleaseToNewShowsAllReleasesInRange() {
    #expect(versions(since: "0.309.0", upTo: "0.313.0") == ["0.313.0", "0.312.0", "0.310.0"])
  }

  @Test func sinceBoundaryIsExclusiveAndCurrentIsInclusive() {
    #expect(versions(since: "0.310.0", upTo: "0.312.0") == ["0.312.0"])
  }

  @Test func sameVersionReturnsEmpty() {
    #expect(versions(since: "0.313.0", upTo: "0.313.0").isEmpty)
  }

  @Test func comparesVersionsByNumber() {
    #expect(versions(since: "0.99.0", upTo: "0.310.0") == ["0.310.0"])
  }

  @Test func sectionsWithoutAVersionAreSkipped() {
    let other = ChangelogParser.parse(from: "## Unreleased\n\n### New Features ✨\n\n- (ios) Next\n")
    #expect(other.map(\.version) == ["Unreleased"])
    #expect(ChangelogParser.releases(since: "0.1.0", upTo: "1.0.0", from: other).isEmpty)
  }

  @Test func whatsNewIsEmptyOnFirstLaunchAndSameVersion() {
    #expect(ChangelogParser.whatsNew(in: releases, lastSeenVersion: nil, currentVersion: "0.313.0").isEmpty)
    #expect(ChangelogParser.whatsNew(in: releases, lastSeenVersion: "0.313.0", currentVersion: "0.313.0").isEmpty)
    let update = ChangelogParser.whatsNew(in: releases, lastSeenVersion: "0.312.0", currentVersion: "0.313.0")
    #expect(update.map(\.version) == ["0.313.0"])
  }
}
