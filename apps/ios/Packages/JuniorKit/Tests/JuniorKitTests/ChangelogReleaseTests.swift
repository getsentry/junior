import Testing

@testable import JuniorKit
@testable import junior_changelog

@Suite struct ChangelogReleaseTests {
  private let changelog = """
    # Changelog

    Intro text.

    ## [Unreleased]

    ### Added

    - On iPad, lists show next to the open item.
    - You can open more than one
      window.

    ### Fixed

    - The drawer closes after a tap.
    """

  private func shipped(_ build: Int, _ version: String, _ notes: String) -> ShippedBuild {
    ShippedBuild(version: version, build: build, date: "2026-11-0\(build % 10)", notes: notes)
  }

  @Test func firstBetaUsesTheBaseVersion() throws {
    let release = try prepareRelease(
      changelog: changelog, shipped: [], build: 1, baseVersion: "0.1.0", date: "2026-11-20")
    #expect(release.version == "0.1.0")
    #expect(
      release.notes == """
        ### Added

        - On iPad, lists show next to the open item.
        - You can open more than one window.

        ### Fixed

        - The drawer closes after a tap.
        """)
    #expect(release.changelog == "# Changelog\n\nIntro text.\n\n## [0.1.0+1] 2026-11-20\n\n\(release.notes)\n")
    let whatsNew = ChangelogParser.whatsNew(in: release.changelog, lastLaunchedBuild: 0, currentBuild: 1)
    #expect(whatsNew.map(\.version) == ["0.1.0+1"])
  }

  @Test func leavesOutEntriesThatShippedAndRebuildsTheirSections() throws {
    let earlier = shipped(4, "0.2.0", "### Added\n\n- You can open more than one window.")
    let release = try prepareRelease(
      changelog: changelog, shipped: [shipped(3, "0.1.0", ""), earlier], build: 5, baseVersion: "0.1.0",
      date: "2026-11-20")
    #expect(release.version == "0.3.0")
    #expect(
      release.notes
        == "### Added\n\n- On iPad, lists show next to the open item.\n\n### Fixed\n\n- The drawer closes after a tap.")
    let sections = ChangelogParser.parse(from: release.changelog)
    #expect(sections.map(\.version) == ["0.3.0+5", "0.2.0+4"])
    #expect(sections[1] == ChangelogEntry(version: "0.2.0+4", date: "2026-11-04", content: earlier.notes))
    let whatsNew = ChangelogParser.whatsNew(in: release.changelog, lastLaunchedBuild: 3, currentBuild: 5)
    #expect(whatsNew.map(\.version) == ["0.3.0+5", "0.2.0+4"])
  }

  @Test func repeatsNoBumpWhenEverythingShipped() throws {
    let notes = """
      - On iPad, lists show next to the open item.
      - You can open more than one window.
      - The drawer closes after a tap.
      """
    let release = try prepareRelease(
      changelog: changelog, shipped: [shipped(7, "0.4.0", notes)], build: 8, baseVersion: "0.1.0", date: "2026-11-20")
    #expect(release.version == "0.4.0")
    #expect(release.notes.isEmpty)
    #expect(ChangelogParser.parse(from: release.changelog).map(\.version) == ["0.4.0+7"])
  }

  @Test func bumpsFromTheCategories() throws {
    #expect(versionBump(for: "Fixed") == .patch)
    #expect(versionBump(for: "Security") == .patch)
    #expect(versionBump(for: "Added") == .minor)
    #expect(versionBump(for: "Changed") == .minor)
    #expect(versionBump(for: nil) == .minor)
    #expect(versionBump(for: "Removed") == .major)
    #expect(versionBump(for: "Breaking changes") == .major)
    #expect(try nextVersion("1.2.3", .patch) == "1.2.4")
    #expect(try nextVersion("1.2.3", .minor) == "1.3.0")
    #expect(try nextVersion("1.2.3", .major) == "2.0.0")
    #expect(try nextVersion("0.2.3", .major) == "0.3.0")
    #expect(try nextVersion("0.2", .patch) == "0.2.1")
    #expect(throws: ReleaseError.self) { try nextVersion("beta", .patch) }

    let fixOnly = "## [Unreleased]\n\n### Fixed\n\n- A fix.\n"
    let release = try prepareRelease(
      changelog: fixOnly, shipped: [shipped(2, "0.2.0", "")], build: 3, baseVersion: "0.1.0", date: "2026-11-20")
    #expect(release.version == "0.2.1")
  }

  @Test func keepsRepoSectionsThatTestFlightLacks() throws {
    let file = "## [Unreleased]\n\n- New.\n\n## [0.1.0+1] 2026-10-01\n\n- Old.\n"
    let release = try prepareRelease(
      changelog: file, shipped: [shipped(2, "0.2.0", "- Middle.")], build: 3, baseVersion: "0.1.0", date: "2026-11-20")
    #expect(ChangelogParser.parse(from: release.changelog).map(\.version) == ["0.3.0+3", "0.2.0+2", "0.1.0+1"])
  }

  @Test func rejectsNotesOverTheTestFlightLimit() {
    let long = "## [Unreleased]\n\n" + (1...100).map { "- Entry \($0) " + String(repeating: "x", count: 40) }
      .joined(separator: "\n")
    #expect(throws: ReleaseError.self) {
      try prepareRelease(changelog: long, shipped: [], build: 1, baseVersion: "0.1.0", date: "2026-11-20")
    }
  }
}
