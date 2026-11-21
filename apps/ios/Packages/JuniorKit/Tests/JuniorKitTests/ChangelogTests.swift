// The build-range cases are ported from armcknight/pippin
// (Tests/PippinCore/ChangelogParserTests.swift), https://github.com/armcknight/pippin,
// under the MIT License. Copyright (c) 2016 Andrew McKnight. The full license
// text is in Sources/JuniorKit/Changelog/Changelog.swift.

import Testing

@testable import JuniorKit

@Suite struct ChangelogTests {
  /// A release candidate cycle, then a final release. Newest first.
  private let changelog = """
    # Changelog

    ## [Unreleased]
    - Next note

    ## [1.0.1+44] 2026-04-16
    - Final release note

    ## [1.0.1-RC2+43] 2026-04-15
    - RC2 note

    ## [1.0.1-RC1+42] 2026-04-14
    - RC1 note

    ## [1.0.0+40] 2026-03-01
    - Previous release note

    ## [0.9.0+10] 2026-01-01
    - Old note
    """

  /// After the release candidate sections become one final section.
  private let consolidatedChangelog = """
    ## [Unreleased]

    ## [1.0.1+44] 2026-04-16
    - RC1 note
    - RC2 note
    - Final release note

    ## [1.0.0+40] 2026-03-01
    - Previous release note
    """

  private func versions(since: Int, upTo: Int, in markdown: String) -> [String] {
    ChangelogParser.entriesSince(build: since, upTo: upTo, from: ChangelogParser.parse(from: markdown)).map(\.version)
  }

  @Test func parsesSections() {
    let entries = ChangelogParser.parse(from: changelog)
    #expect(
      entries.map(\.version) == ["Unreleased", "1.0.1+44", "1.0.1-RC2+43", "1.0.1-RC1+42", "1.0.0+40", "0.9.0+10"])
    #expect(entries[0] == ChangelogEntry(version: "Unreleased", date: nil, content: "- Next note"))
    #expect(entries[1] == ChangelogEntry(version: "1.0.1+44", date: "2026-04-16", content: "- Final release note"))
    #expect(entries[1].title == "1.0.1 (44)")
    #expect(entries[2].build == 43)
    #expect(entries[0].build == nil)
    #expect(entries[0].title == "Unreleased")
  }

  @Test func keepsSubsectionsAndDashDates() {
    let entries = ChangelogParser.parse(from: "## [0.1.0+2] - 2026-11-20\n\n### Added\n\n- A note\n")
    #expect(entries == [ChangelogEntry(version: "0.1.0+2", date: "2026-11-20", content: "### Added\n\n- A note")])
  }

  @Test func rc1ToRC2ShowsRC2Entry() {
    #expect(versions(since: 42, upTo: 43, in: changelog) == ["1.0.1-RC2+43"])
  }

  @Test func rc2ToFinalAfterConsolidationShowsFinalEntry() {
    // Build 43 is gone from the file, but the final section (44) is found.
    #expect(versions(since: 43, upTo: 44, in: consolidatedChangelog) == ["1.0.1+44"])
  }

  @Test func oldReleaseToNewShowsAllEntriesInRange() {
    #expect(versions(since: 40, upTo: 44, in: changelog) == ["1.0.1+44", "1.0.1-RC2+43", "1.0.1-RC1+42"])
  }

  @Test func sameBuildReturnsEmpty() {
    #expect(versions(since: 44, upTo: 44, in: changelog).isEmpty)
  }

  @Test func entriesWithoutBuildNumberAreSkipped() {
    let legacy = """
      ## [1.1.0] 2026-05-01
      - No build number here

      ## [1.0.1+44] 2026-04-16
      - Has build number
      """
    #expect(versions(since: 43, upTo: 44, in: legacy) == ["1.0.1+44"])
  }

  @Test func sinceBoundaryIsExclusiveAndCurrentIsInclusive() {
    #expect(versions(since: 42, upTo: 44, in: changelog) == ["1.0.1+44", "1.0.1-RC2+43"])
  }

  @Test func whatsNewIsEmptyOnFirstLaunchAndSameBuild() {
    #expect(ChangelogParser.whatsNew(in: changelog, lastLaunchedBuild: nil, currentBuild: 44).isEmpty)
    #expect(ChangelogParser.whatsNew(in: changelog, lastLaunchedBuild: 44, currentBuild: 44).isEmpty)
    let update = ChangelogParser.whatsNew(in: changelog, lastLaunchedBuild: 43, currentBuild: 44)
    #expect(update.map(\.version) == ["1.0.1+44"])
  }
}
