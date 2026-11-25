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
  case inboxItem(String)
  case automation(String)
  case settings
}

/// App-wide state, shared by every window: the server and its two sign-ins,
/// the Inbox count, and the refresh tick that tells screens to reload. The app
/// uses the MCP server at `/api/mcp`, and the dashboard API (`/api/*`) for
/// what MCP does not cover.
@MainActor
@Observable
final class AppModel {
  /// The app's OAuth client ID. Junior knows this client (`JUNIOR_IOS_CLIENT`
  /// in `packages/junior/src/api/mcp/oauth/client-metadata.ts`).
  static let oauthClientID = "https://junior.sentry.dev/clients/ios"

  private(set) var server: JuniorServer
  private(set) var client: MCPClient
  private(set) var dashboard: DashboardClient
  private(set) var signedIn: Bool
  var theme: ThemeChoice {
    didSet { UserDefaults.standard.set(theme.rawValue, forKey: "theme") }
  }

  var serverVersion: String?
  var inboxCount = 0
  var shellError: JuniorAPIError?

  /// The app is in front; refreshes stop otherwise.
  var isActive = true
  /// Badges the drawer's Changelog after an install or update, until the person opens it.
  var changelogBadge = false

  /// Bumps when lists should reload: on the refresh tick and after a write.
  private(set) var conversationsVersion = 0
  private(set) var inboxItemsVersion = 0
  /// The latest title that a rename from a list saved. `savedTitleVersion`
  /// bumps with each one, so the open Conversation shows it at once.
  private(set) var savedTitle: SavedTitle?
  private(set) var savedTitleVersion = 0

  /// A pinned "now" for deterministic screenshots (`-JuniorFixedNow`).
  let fixedNow: Date?
  let agentName = "Junior"

  private let store = KeychainStore<OAuthCredentials>(account: "mcp-credentials")
  private let sessionStore = KeychainStore<SessionCredentials>(account: "dashboard-session")
  private var ticking: Task<Void, Never>?
  private var lastInput = Date()

  init(launch: LaunchOptions = .current) {
    let defaults = UserDefaults.standard
    let savedURL = defaults.string(forKey: "serverURL").flatMap(URL.init(string:))
    let server = JuniorServer(baseURL: launch.server ?? savedURL ?? JuniorServer.production.baseURL)
    #if DEBUG
      // Screenshots and UI tests start signed in to the mock server, or
      // signed out to run the sign-in flow.
      if launch.signOut {
        store.save(nil)
        sessionStore.save(nil)
      }
      if let token = launch.accessToken {
        store.save(
          OAuthCredentials(
            server: server, clientID: Self.oauthClientID, tokenEndpoint: server.page("/api/mcp/oauth/token")!,
            accessToken: token, refreshToken: nil, expiresAt: .distantFuture, scope: nil))
        sessionStore.save(SessionCredentials(server: server, token: token, expiresAt: .distantFuture))
      }
    #endif
    self.server = server
    self.client = Self.client(for: server, store: store)
    self.dashboard = Self.dashboard(for: server, store: sessionStore)
    // An app with no live dashboard session, such as one that signed in before
    // the session existed, signs in again.
    let session = sessionStore.load()
    self.signedIn =
      store.load()?.server == server && session?.server == server && session.map { $0.expiresAt > Date() } == true
    self.theme = launch.theme ?? ThemeChoice(rawValue: defaults.string(forKey: "theme") ?? "") ?? .system
    self.fixedNow = launch.fixedNow
    self.changelogBadge = BundledChangelog.hasUnseen()
  }

  var clock: DisplayClock {
    DisplayClock(now: fixedNow ?? Date())
  }

  /// Call one MCP tool. A call that finds the sign-in gone shows Sign in.
  func call<Result: Decodable & Sendable>(
    _ tool: String, _ arguments: [String: JSONValue] = [:], as type: Result.Type = Result.self
  ) async throws -> Result {
    do {
      return try await client.call(tool, arguments, as: type)
    } catch JuniorAPIError.signedOut {
      signedIn = false
      throw JuniorAPIError.signedOut
    }
  }

  /// GET one dashboard API path. A call that finds the session gone shows
  /// Sign in.
  func get<Result: Decodable & Sendable>(
    _ path: String, query: [URLQueryItem] = [], as type: Result.Type = Result.self
  ) async throws -> Result {
    do {
      return try await dashboard.get(path, query: query, as: type)
    } catch JuniorAPIError.signedOut {
      signedIn = false
      throw JuniorAPIError.signedOut
    }
  }

  /// Sign in to `baseURL` in the system browser sheet, then load the shell.
  /// One consent gives the MCP grant and the dashboard session.
  func signIn(to baseURL: URL) async throws {
    let server = JuniorServer(baseURL: baseURL)
    let (credentials, session) = try await BrowserSignIn().run(
      OAuthClient(server: server, clientID: Self.oauthClientID), session: SessionSignInClient(server: server))
    await connect(server, credentials, session)
  }

  /// Sign in to the built-in demo: mock data on this device, for people with
  /// no Junior to sign in to, such as App Review.
  func startDemo() async {
    let server = JuniorServer.demo
    await connect(
      server,
      OAuthCredentials(
        server: server, clientID: Self.oauthClientID, tokenEndpoint: server.page("/api/mcp/oauth/token")!,
        accessToken: "demo", refreshToken: nil, expiresAt: .distantFuture, scope: nil),
      SessionCredentials(server: server, token: "demo", expiresAt: .distantFuture))
  }

  private func connect(
    _ server: JuniorServer, _ credentials: OAuthCredentials, _ session: SessionCredentials
  ) async {
    UserDefaults.standard.set(server.baseURL.absoluteString, forKey: "serverURL")
    self.server = server
    client = Self.client(for: server, store: store)
    dashboard = Self.dashboard(for: server, store: sessionStore)
    await client.signIn(credentials)
    await dashboard.signIn(session)
    signedIn = true
    didWrite()
    await refreshShell()
  }

  /// The demo answers in process and starts from fresh mock data.
  private static func client(for server: JuniorServer, store: CredentialStore) -> MCPClient {
    server.isDemo
      ? MCPClient(server: server, store: store, transport: DemoServer().transport)
      : MCPClient(server: server, store: store)
  }

  /// The demo has no dashboard API, so its calls get a 404.
  private static func dashboard(for server: JuniorServer, store: SessionStore) -> DashboardClient {
    server.isDemo
      ? DashboardClient(
        server: server, store: store,
        transport: { request in
          (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
        })
      : DashboardClient(server: server, store: store)
  }

  func signOut() {
    let client = client
    let dashboard = dashboard
    let server = server
    Task {
      await client.signOut()
      if let session = await dashboard.signOut(), !server.isDemo {
        await SessionSignInClient(server: server).signOut(session)
      }
    }
    signedIn = false
    inboxCount = 0
    serverVersion = nil
  }

  func refreshShell() async {
    guard signedIn else { return }
    do {
      serverVersion = try await client.serverInfo().version
      shellError = nil
    } catch JuniorAPIError.signedOut {
      signedIn = false
    } catch let error as JuniorAPIError {
      shellError = error
    } catch {}
    await refreshInboxCount()
  }

  /// Open Inbox items that wait on the viewer: the dashboard badge's own
  /// count, with no 50-item limit. The demo has no dashboard API, so it
  /// counts its own list.
  func refreshInboxCount() async {
    if server.isDemo {
      if let list = try? await call("searchInboxItems", ["limit": 50], as: InboxItemList.self) {
        inboxCount = list.items.filter(\.needsViewer).count
      }
    } else if let count = try? await get("/api/inbox-items/count", as: InboxItemCount.self) {
      inboxCount = count.needsViewer
    }
  }

  /// Reload lists every 15s (60s after 5 minutes without input) while the
  /// app is in front. The public API has no change feed to poll.
  func startTicking() {
    ticking?.cancel()
    ticking = Task { [weak self] in
      while !Task.isCancelled {
        let idle = Date().timeIntervalSince(self?.lastInput ?? Date()) > 300
        try? await Task.sleep(for: .seconds(idle ? 60 : 15))
        guard let self, !Task.isCancelled, self.signedIn else { continue }
        self.conversationsVersion += 1
        self.inboxItemsVersion += 1
        await self.refreshInboxCount()
      }
    }
  }

  func stopTicking() {
    ticking?.cancel()
    ticking = nil
  }

  func noteInput() {
    lastInput = Date()
  }

  /// Tell the open Conversation about a title that a list saved.
  func didRename(_ saved: SavedTitle) {
    savedTitle = saved
    savedTitleVersion += 1
  }

  /// Tell screens that data changed after a local write.
  func didWrite() {
    conversationsVersion += 1
    inboxItemsVersion += 1
  }
}

/// One sign-in, kept in the Keychain for this device only.
struct KeychainStore<Value: Codable & Sendable>: Sendable {
  let account: String

  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "io.sentry.junior",
      kSecAttrAccount as String: account,
    ]
  }

  func load() -> Value? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
      return nil
    }
    return try? JSONDecoder().decode(Value.self, from: data)
  }

  func save(_ credentials: Value?) {
    SecItemDelete(query as CFDictionary)
    guard let credentials, let data = try? JSONEncoder().encode(credentials) else { return }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(item as CFDictionary, nil)
  }
}

extension KeychainStore: CredentialStore where Value == OAuthCredentials {}
extension KeychainStore: SessionStore where Value == SessionCredentials {}

/// Launch arguments for development and screenshots:
/// `-JuniorServer <url> -JuniorFixedNow <iso> -JuniorOpen <path> -JuniorTheme <dark|light>`,
/// and in debug builds `-JuniorAccessToken <token>` to start signed in or
/// `-JuniorSignOut YES` to start signed out.
struct LaunchOptions {
  var server: URL?
  var fixedNow: Date?
  var open: String?
  var theme: ThemeChoice?
  var accessToken: String?
  var signOut = false

  static var current: LaunchOptions {
    let defaults = UserDefaults.standard
    return LaunchOptions(
      server: defaults.string(forKey: "JuniorServer").flatMap(URL.init(string:)),
      fixedNow: defaults.string(forKey: "JuniorFixedNow").flatMap(Date.junior),
      open: defaults.string(forKey: "JuniorOpen"),
      theme: defaults.string(forKey: "JuniorTheme").flatMap(ThemeChoice.init(rawValue:)),
      accessToken: defaults.string(forKey: "JuniorAccessToken"),
      signOut: defaults.bool(forKey: "JuniorSignOut"))
  }
}
