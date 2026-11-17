import XCTest

/// Journeys through the app against the mock dashboard
/// (`scripts/mock-server.mjs`). Run one suite at a time with
/// `scripts/sim.sh ui-test NavigationUITests`.
@MainActor
final class NavigationUITests: XCTestCase {
  override func setUp() async throws {
    // Undo writes from earlier journeys (`scripts/mock-server.mjs`).
    var request = URLRequest(url: URL(string: "http://127.0.0.1:4317/__reset")!)
    request.httpMethod = "POST"
    _ = try await URLSession.shared.data(for: request)
  }

  private func launch(open path: String = "/") -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = [
      "-JuniorServer", "http://127.0.0.1:4317", "-JuniorFixedNow", "2026-08-07T12:00:00Z",
      "-JuniorOpen", path, "-JuniorTheme", "dark",
    ]
    app.launch()
    return app
  }

  func testHomeOpensConversation() {
    let app = launch()
    let card = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Investigate checkout latency'")).firstMatch
    XCTAssertTrue(card.waitForExistence(timeout: 10))
    card.tap()
    XCTAssertTrue(app.buttons["Conversation menu"].waitForExistence(timeout: 10))
    XCTAssertTrue(
      app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Working for'")).firstMatch.waitForExistence(
        timeout: 10))
  }

  func testDrawerNavigatesToInbox() {
    let app = launch()
    app.buttons["Open navigation"].tap()
    let inbox = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Inbox'")).firstMatch
    XCTAssertTrue(inbox.waitForExistence(timeout: 10))
    inbox.tap()
    XCTAssertTrue(app.staticTexts["Inbox"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons.matching(identifier: "inbox-row").firstMatch.waitForExistence(timeout: 10))
  }

  func testAnswerQuestion() {
    let app = launch(open: "/review?item=qa-migration-window")
    let option = app.buttons.matching(identifier: "review-option").firstMatch
    XCTAssertTrue(option.waitForExistence(timeout: 10))
    option.tap()
    let closed = NSPredicate(format: "label CONTAINS 'closed this' OR label CONTAINS 'dismissed this'")
    XCTAssertTrue(app.staticTexts.matching(closed).firstMatch.waitForExistence(timeout: 10))
  }

  /// The token lives in the Keychain and survives a relaunch.
  func testTokenPersists() {
    var app = launch(open: "/settings")
    let field = app.secureTextFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText("jr_pat_uitest")
    app.buttons["save-connection"].tap()
    XCTAssertTrue(app.buttons["Remove token"].waitForExistence(timeout: 5))
    app.terminate()
    app = launch(open: "/settings")
    let remove = app.buttons["Remove token"]
    XCTAssertTrue(remove.waitForExistence(timeout: 10))
    remove.tap()
  }
}
