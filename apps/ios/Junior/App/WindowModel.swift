import Observation
import SwiftUI

/// One window's navigation: its place, the open item and what is pushed over
/// it, the drawer, and the in-app browser. Each iPad window has its own, so
/// two windows can show different work side by side.
@MainActor
@Observable
final class WindowModel {
  var place: Place = .conversations
  var path: [Route] = []
  var drawerOpen = false
  var webPage: URL?
  /// A demo link to a dashboard page was opened.
  var demoWebNotice = false
  /// Focus the home search field ("Go to conversation").
  var focusSearch = false
  /// Open the Conversation's details on arrival (`?details=1`).
  var openDetails = false

  private let app: AppModel

  init(app: AppModel, open: String? = LaunchOptions.current.open) {
    self.app = app
    if let open { self.open(dashboardPath: open) }
  }

  /// Open a dashboard path (`/`, `/inbox?item=…`, `/conversations/…`,
  /// `/automations/…`, `/settings`) the way the web router does.
  func open(dashboardPath: String) {
    guard let components = URLComponents(string: dashboardPath) else { return }
    let parts = components.path.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }
    let item = components.queryItems?.first { $0.name == "item" }?.value
    drawerOpen = false
    switch parts.first {
    case "conversations" where parts.count > 1:
      place = .conversations
      path = [.conversation(parts[1])]
    case "inbox":
      place = .inbox
      path = item.map { [.inboxItem($0)] } ?? []
    case "automations" where parts.count > 1 && parts[1] != "runs":
      place = .automations
      path = [.automation(parts[1])]
    case "automations":
      place = .automations
      path = []
    case "settings":
      path = [.settings]
    default:
      place = .conversations
      path = []
    }
    // `?drawer=1` opens the navigation drawer over the page (screenshots).
    drawerOpen = components.queryItems?.contains { $0.name == "drawer" } == true
    openDetails = components.queryItems?.contains { $0.name == "details" } == true
  }

  func go(_ place: Place) {
    self.place = place
    path = []
    drawerOpen = false
  }

  /// Open a dashboard page in the in-app browser, for what the public API
  /// cannot do (answer a Review item, change an Automation).
  func openOnWeb(_ dashboardPath: String) {
    show(app.server.page(dashboardPath))
  }

  /// Open a link from a tool result, such as a dashboard or Slack URL.
  func openLink(_ link: String?) {
    guard let link, let url = URL(string: link) else { return }
    show(url)
  }

  /// The demo has no dashboard, so its pages show a notice instead.
  private func show(_ url: URL?) {
    drawerOpen = false
    if app.server.isDemo, url?.host() == app.server.baseURL.host() {
      demoWebNotice = true
    } else {
      webPage = url
    }
  }

  /// Start over after sign-out.
  func reset() {
    path = []
    drawerOpen = false
    webPage = nil
    demoWebNotice = false
  }
}
