import JuniorKit
import Observation
import Security
import SwiftUI

/// Theme the app shows: the saved choice, or the system appearance.
enum ThemeChoice: String, CaseIterable {
  case system, light, dark

  var colorScheme: ColorScheme? {
    switch self {
    case .system: nil
    case .light: .light
    case .dark: .dark
    }
  }
}

/// The three primary places, as the dashboard's primary nav names them.
enum Place: Hashable {
  case conversations, inbox, automations
}

/// A pushed screen. Paths mirror the dashboard routes they render.
enum Route: Hashable {
  case conversation(String)
  case reviewItem(String)
  case automation(String)
  case settings
}

/// App-wide state: the server, the signed-in viewer, shell data (spend, Inbox
/// count), navigation, and the versions poll that tells screens to refresh.
@MainActor
@Observable
final class AppModel {
  var server: JuniorServer {
    didSet {
      saveServer()
      client = JuniorClient(server: server)
      shellRefresh = Task { await refreshShell() }
    }
  }
  private(set) var client: JuniorClient
  /// The shell refresh a server change started, so a caller can await it.
  private(set) var shellRefresh: Task<Void, Never>?
  var theme: ThemeChoice {
    didSet { UserDefaults.standard.set(theme.rawValue, forKey: "theme") }
  }
  var openAtLatest: Bool {
    didSet { UserDefaults.standard.set(openAtLatest, forKey: "openAtLatest") }
  }

  var viewer: Viewer?
  var config: DashboardConfig?
  var spend: Spend?
  var inboxCount = 0
  var shellError: JuniorAPIError?
  /// The dashboard rejected the token, or there is none and it needs one.
  var needsConnect: Bool { shellError == .signedOut }

  var place: Place = .conversations
  var path: [Route] = []
  var drawerOpen = false
  var webPage: URL?
  /// Focus the home search field ("Go to conversation").
  var focusSearch = false
  /// The Automations page shows its Runs tab (`/automations/runs`).
  var showRuns = false
  /// Open the Conversation's details on arrival (`?details=1`).
  var openDetails = false
  /// The app is in front; polling stops otherwise.
  var isActive = true

  /// Bumps when the versions poll sees new data, per area.
  private(set) var conversationsVersion = 0
  private(set) var reviewItemsVersion = 0
  private(set) var conversationVersion = 0
  /// The Conversation on screen, for the versions poll.
  var openConversationId: String?

  /// A pinned "now" for deterministic screenshots (`-JuniorFixedNow`).
  let fixedNow: Date?
  let agentName = "Junior"

  private var versions: DataVersions?
  private var versionsConversationId: String?
  private var polling: Task<Void, Never>?
  private var lastInput = Date()

  init(launch: LaunchOptions = .current) {
    let defaults = UserDefaults.standard
    // Builds before the Keychain kept the whole server, token included, in
    // defaults; move the token and drop that copy.
    var legacyToken: String?
    if let legacy = defaults.data(forKey: "server"),
      let old = try? JSONDecoder().decode(JuniorServer.self, from: legacy)
    {
      legacyToken = old.token
      let moved = TokenStore.read() != nil || old.token == nil || TokenStore.write(old.token)
      defaults.set(old.baseURL.absoluteString, forKey: "serverURL")
      // Keep the old copy until the Keychain holds the token.
      if moved { defaults.removeObject(forKey: "server") }
    }
    let savedURL = defaults.string(forKey: "serverURL").flatMap(URL.init(string:))
    let baseURL = launch.server ?? savedURL ?? URL(string: "http://127.0.0.1:4317")!
    let server = JuniorServer(baseURL: baseURL, token: TokenStore.read() ?? legacyToken)
    self.server = server
    self.client = JuniorClient(server: server)
    self.theme = launch.theme ?? ThemeChoice(rawValue: defaults.string(forKey: "theme") ?? "") ?? .system
    self.openAtLatest = defaults.bool(forKey: "openAtLatest")
    self.fixedNow = launch.fixedNow
    if let open = launch.open { self.open(dashboardPath: open) }
  }

  var clock: DisplayClock {
    DisplayClock(now: fixedNow ?? Date())
  }

  /// Open a dashboard path (`/`, `/review?item=…`, `/conversations/…`,
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
    case "review":
      place = .inbox
      path = item.map { [.reviewItem($0)] } ?? []
    case "automations" where parts.count > 1 && parts[1] != "runs":
      place = .automations
      path = [.automation(parts[1])]
    case "automations":
      place = .automations
      path = []
      showRuns = parts.count > 1 && parts[1] == "runs"
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

  /// Open a dashboard page this app does not render, in the in-app browser.
  func openOnWeb(_ dashboardPath: String) {
    drawerOpen = false
    webPage = URL(string: dashboardPath, relativeTo: server.baseURL)?.absoluteURL
  }

  func refreshShell() async {
    do {
      viewer = try await client.get("/api/me")
      shellError = nil
    } catch let error as JuniorAPIError {
      shellError = error
    } catch {}
    config = try? await client.get("/api/config")
    await refreshSpendAndCount()
  }

  func refreshSpendAndCount() async {
    if let spend: Spend = try? await client.get("/api/people/me/spend") { self.spend = spend }
    if let count: ReviewCount = try? await client.get("/api/review-items/count") {
      inboxCount = count.needsViewer
    }
  }

  /// Poll `/api/versions` every 5s (10s after 5 minutes without input) while
  /// the app is active, like the dashboard.
  func startPolling() {
    polling?.cancel()
    polling = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        await self.pollOnce()
        let idle = Date().timeIntervalSince(self.lastInput) > 300
        try? await Task.sleep(for: .seconds(idle ? 10 : 5))
      }
    }
  }

  func stopPolling() {
    polling?.cancel()
    polling = nil
  }

  func noteInput() {
    lastInput = Date()
  }

  private func pollOnce() async {
    var query: [URLQueryItem] = []
    if let openConversationId { query.append(URLQueryItem(name: "conversationId", value: openConversationId)) }
    let polledConversation = openConversationId
    guard let next: DataVersions = try? await client.get("/api/versions", query: query) else { return }
    defer {
      versions = next
      versionsConversationId = polledConversation
    }
    guard let previous = versions else { return }
    if next.conversations != previous.conversations { conversationsVersion += 1 }
    if next.reviewItems != previous.reviewItems {
      reviewItemsVersion += 1
      conversationsVersion += 1
    }
    // The token is per Conversation; compare only tokens for the same one.
    if next.conversation != nil, versionsConversationId == polledConversation,
      next.conversation != previous.conversation
    {
      conversationVersion += 1
    }
    if next.spend != previous.spend || next.reviewItems != previous.reviewItems {
      await refreshSpendAndCount()
    }
  }

  /// Tell screens that data changed after a local write.
  func didWrite() {
    conversationsVersion += 1
    reviewItemsVersion += 1
    Task { await refreshSpendAndCount() }
  }

  /// The URL goes to defaults; the token goes to the Keychain.
  private func saveServer() {
    UserDefaults.standard.set(server.baseURL.absoluteString, forKey: "serverURL")
    tokenSaveFailed = !TokenStore.write(server.token)
  }

  /// The Keychain refused the token; it works this session but will not last.
  var tokenSaveFailed = false
}

/// The personal token, kept in the Keychain for this device only.
enum TokenStore {
  private static var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "io.sentry.junior",
      kSecAttrAccount as String: "personal-token",
    ]
  }

  static func read() -> String? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  /// Store or clear the token. Returns false when the Keychain refused.
  @discardableResult
  static func write(_ token: String?) -> Bool {
    let deleted = SecItemDelete(query as CFDictionary)
    guard deleted == errSecSuccess || deleted == errSecItemNotFound else { return false }
    guard let token, let data = token.data(using: .utf8) else { return true }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
  }
}

/// Launch arguments for development and screenshots:
/// `-JuniorServer <url> -JuniorFixedNow <iso> -JuniorOpen <path> -JuniorTheme <dark|light>`.
struct LaunchOptions {
  var server: URL?
  var fixedNow: Date?
  var open: String?
  var theme: ThemeChoice?

  static var current: LaunchOptions {
    let defaults = UserDefaults.standard
    return LaunchOptions(
      server: defaults.string(forKey: "JuniorServer").flatMap(URL.init(string:)),
      fixedNow: defaults.string(forKey: "JuniorFixedNow").flatMap(Date.junior),
      open: defaults.string(forKey: "JuniorOpen"),
      theme: defaults.string(forKey: "JuniorTheme").flatMap(ThemeChoice.init(rawValue:)))
  }
}
