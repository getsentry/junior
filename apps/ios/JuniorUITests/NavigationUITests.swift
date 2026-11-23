import XCTest

/// Journeys through the app against the mock MCP server
/// (`scripts/mock-server.mjs`). Run one suite at a time with
/// `scripts/sim.sh ui-test NavigationUITests`.
@MainActor
final class NavigationUITests: XCTestCase {
  enum Auth { case token, signedOut, kept }

  /// `scripts/sim.sh` sets it from `JUNIOR_IOS_SERVER`.
  private let server = ProcessInfo.processInfo.environment["JUNIOR_IOS_SERVER"] ?? "http://127.0.0.1:4317"

  override func setUp() async throws {
    // Undo writes from earlier journeys (`scripts/mock-server.mjs`).
    var request = URLRequest(url: URL(string: "\(server)/__reset")!)
    request.httpMethod = "POST"
    _ = try await URLSession.shared.data(for: request)
  }

  private func launch(open path: String = "/", auth: Auth = .token) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = [
      "-JuniorServer", server, "-JuniorFixedNow", "2026-08-07T12:00:00Z",
      "-JuniorOpen", path, "-JuniorTheme", "dark",
    ]
    switch auth {
    case .token: app.launchArguments += ["-JuniorAccessToken", "mock-access-token"]
    case .signedOut: app.launchArguments += ["-JuniorSignOut", "YES"]
    case .kept: break
    }
    app.launch()
    return app
  }

  private func card(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", title)).firstMatch
  }

  /// The whole OAuth flow: the browser sheet, the mock's consent, the
  /// `junior-ios` redirect, the token exchange, and a Keychain that survives a
  /// relaunch. Sign out returns to Sign in.
  func testSignInAndOut() {
    var app = launch(auth: .signedOut)
    let signIn = app.buttons["sign-in"]
    XCTAssertTrue(signIn.waitForExistence(timeout: 10))
    signIn.tap()
    XCTAssertTrue(card(app, "Investigate checkout latency").waitForExistence(timeout: 30))
    app.terminate()

    app = launch(open: "/settings", auth: .kept)
    let signOut = app.buttons["sign-out"]
    XCTAssertTrue(signOut.waitForExistence(timeout: 10))
    signOut.tap()
    XCTAssertTrue(app.buttons["sign-in"].waitForExistence(timeout: 10))
  }

  /// The built-in demo answers without the mock server: a reply to a sent
  /// message, and a notice instead of the dashboard it does not have.
  func testTryDemo() {
    let app = launch(auth: .signedOut)
    let tryDemo = app.buttons["try-demo"]
    XCTAssertTrue(tryDemo.waitForExistence(timeout: 10))
    tryDemo.tap()
    let field = app.descendants(matching: .any).matching(
      NSPredicate(
        format: "label == 'Message Junior…' AND (elementType == %d OR elementType == %d)",
        XCUIElement.ElementType.textView.rawValue, XCUIElement.ElementType.textField.rawValue)
    ).firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.tap()
    field.typeText("Summarize this week's deploys")
    app.buttons["Send"].tap()
    let reply = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'This is the demo'")).firstMatch
    XCTAssertTrue(reply.waitForExistence(timeout: 20))

    app.buttons["Conversation menu"].tap()
    app.buttons["Open on the web"].tap()
    XCTAssertTrue(app.alerts["The demo has no web dashboard"].waitForExistence(timeout: 10))
  }

  func testHomeOpensConversation() {
    let app = launch()
    let row = card(app, "Investigate checkout latency")
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    XCTAssertTrue(app.buttons["Conversation menu"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["Junior is working…"].waitForExistence(timeout: 10))
  }

  /// Open a Conversation and return its composer field, focused.
  private func openComposer(_ app: XCUIApplication) -> XCUIElement {
    let row = card(app, "Investigate checkout latency")
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    XCTAssertTrue(app.buttons["Conversation menu"].waitForExistence(timeout: 10))
    // The Conversation's composer, not the home one under it.
    let fields = app.descendants(matching: .any).matching(
      NSPredicate(
        format: "label == 'Message Junior…' AND (elementType == %d OR elementType == %d)",
        XCUIElement.ElementType.textView.rawValue, XCUIElement.ElementType.textField.rawValue))
    XCTAssertTrue(fields.firstMatch.waitForExistence(timeout: 10))
    let field = fields.element(boundBy: fields.count - 1)
    field.tap()
    return field
  }

  private func message(_ app: XCUIApplication, containing text: String) -> XCUIElement {
    app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
  }

  func testSendMessage() {
    let app = launch()
    let field = openComposer(app)
    field.typeText("Check the EU region too")
    app.buttons["composer-send"].tap()
    XCTAssertTrue(message(app, containing: "Check the EU region too").waitForExistence(timeout: 10))
  }

  /// The software keyboard's Return key reads "send" and sends.
  func testKeyboardReturnSends() {
    let app = launch()
    let field = openComposer(app)
    field.typeText("Check the EU region too")
    let send = app.keyboards.buttons.matching(NSPredicate(format: "label ==[c] 'send'")).firstMatch
    XCTAssertTrue(send.waitForExistence(timeout: 10))
    send.tap()
    XCTAssertTrue(message(app, containing: "Check the EU region too").waitForExistence(timeout: 10))
  }

  /// On a hardware keyboard, Shift-Return inserts a newline and Return sends.
  func testHardwareKeyboardReturn() {
    let app = launch()
    let field = openComposer(app)
    field.typeText("Check the EU region")
    field.typeKey(.return, modifierFlags: .shift)
    field.typeText("and the US one")
    XCTAssertEqual(field.value as? String, "Check the EU region\nand the US one")
    field.typeKey(.return, modifierFlags: [])
    XCTAssertTrue(message(app, containing: "and the US one").waitForExistence(timeout: 10))
  }

  /// Rename from the Conversation menu; the header shows the saved title.
  func testRenameConversation() {
    let app = launch()
    let row = card(app, "Investigate checkout latency")
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    let menu = app.buttons["Conversation menu"]
    XCTAssertTrue(menu.waitForExistence(timeout: 10))
    menu.tap()
    app.buttons["Rename"].tap()
    let alert = app.alerts["Rename conversation"]
    let field = alert.textFields.firstMatch
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    // The field opens focused, with the current title and the cursor at its end.
    let current = (field.value as? String) ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
    field.typeText("Checkout latency fix")
    alert.buttons["Save"].tap()
    XCTAssertTrue(app.staticTexts["Checkout latency fix"].waitForExistence(timeout: 10))
  }

  func testDrawerNavigatesToInbox() {
    let app = launch()
    app.buttons["Open navigation"].tap()
    let inbox = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Inbox'")).firstMatch
    XCTAssertTrue(inbox.waitForExistence(timeout: 10))
    inbox.tap()
    let row = app.buttons.matching(identifier: "inbox-row").firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    XCTAssertTrue(app.buttons["answer-on-web"].waitForExistence(timeout: 10))
  }

  func testDrawerLogsOut() {
    let app = launch()
    app.buttons["Open navigation"].tap()
    let logOut = app.buttons["Log out"]
    XCTAssertTrue(logOut.waitForExistence(timeout: 10))
    logOut.tap()
    XCTAssertTrue(app.buttons["sign-in"].waitForExistence(timeout: 10))
  }

  func testAutomationShowsRuns() {
    let app = launch(open: "/automations")
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Listening' OR label CONTAINS 'Next'"))
      .firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    row.tap()
    XCTAssertTrue(app.staticTexts["Recent runs"].waitForExistence(timeout: 10))
  }
}
