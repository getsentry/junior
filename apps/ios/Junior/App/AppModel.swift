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

/// App-wide state, shared by every window: the server and its sign-in, the
/// Inbox count, and the refresh tick that tells screens to reload. The app uses only
/// Junior's public API, the MCP server at `/api/mcp`.
@MainActor
@Observable
final class AppModel {
  /// The app's OAuth client ID. Junior knows this client (`JUNIOR_IOS_CLIENT`
  /// in `packages/junior/src/api/mcp/oauth/client-metadata.ts`).
  static let oauthClientID = "https://junior.sentry.dev/clients/ios"

  private(set) var server: JuniorServer
  private(set) var client: MCPClient
  private(set) var signedIn: Bool
  var theme: ThemeChoice {
    didSet { UserDefaults.standard.set(theme.rawValue, forKey: "theme") }
  }

  var serverVersion: String?
  var inboxCount = 0
  var shellError: JuniorAPIError?

  /// The app is in front; refreshes stop otherwise.
  var isActive = true

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

  private let store = KeychainCredentialStore()
  private var ticking: Task<Void, Never>?
  private var lastInput = Date()

  init(launch: LaunchOptions = .current) {
    let defaults = UserDefaults.standard
    let savedURL = defaults.string(forKey: "serverURL").flatMap(URL.init(string:))
    let server = JuniorServer(baseURL: launch.server ?? savedURL ?? JuniorServer.production.baseURL)
    #if DEBUG
      // Screenshots and UI tests start signed in to the mock server, or
      // signed out to run the sign-in flow.
      if launch.signOut { store.save(nil) }
      if let token = launch.accessToken {
        store.save(
          OAuthCredentials(
            server: server, clientID: Self.oauthClientID, tokenEndpoint: server.page("/api/mcp/oauth/token")!,
            accessToken: token, refreshToken: nil, expiresAt: .distantFuture, scope: nil))
      }
    #endif
    self.server = server
    self.client = Self.client(for: server, store: store)
    self.signedIn = store.load()?.server == server
    self.theme = launch.theme ?? ThemeChoice(rawValue: defaults.string(forKey: "theme") ?? "") ?? .system
    self.fixedNow = launch.fixedNow
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

  /// Sign in to `baseURL` in the system browser sheet, then load the shell.
  func signIn(to baseURL: URL) async throws {
    let server = JuniorServer(baseURL: baseURL)
    let oauth = OAuthClient(server: server, clientID: Self.oauthClientID)
    let credentials = try await BrowserSignIn().run(oauth)
    await connect(server, credentials)
  }

  /// Sign in to the built-in demo: mock data on this device, for people with
  /// no Junior to sign in to, such as App Review.
  func startDemo() async {
    let server = JuniorServer.demo
    await connect(
      server,
      OAuthCredentials(
        server: server, clientID: Self.oauthClientID, tokenEndpoint: server.page("/api/mcp/oauth/token")!,
        accessToken: "demo", refreshToken: nil, expiresAt: .distantFuture, scope: nil))
  }

  private func connect(_ server: JuniorServer, _ credentials: OAuthCredentials) async {
    UserDefaults.standard.set(server.baseURL.absoluteString, forKey: "serverURL")
    self.server = server
    client = Self.client(for: server, store: store)
    await client.signIn(credentials)
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

  func signOut() {
    let client = client
    Task { await client.signOut() }
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

  /// Open Inbox items that wait on the viewer.
  func refreshInboxCount() async {
    if let list = try? await call("searchInboxItems", ["limit": 50], as: InboxItemList.self) {
      inboxCount = list.items.filter(\.canAct).count
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

/// The sign-in, kept in the Keychain for this device only.
struct KeychainCredentialStore: CredentialStore {
  private var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "io.sentry.junior",
      kSecAttrAccount as String: "mcp-credentials",
    ]
  }

  func load() -> OAuthCredentials? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
      return nil
    }
    return try? JSONDecoder().decode(OAuthCredentials.self, from: data)
  }

  func save(_ credentials: OAuthCredentials?) {
    SecItemDelete(query as CFDictionary)
    guard let credentials, let data = try? JSONEncoder().encode(credentials) else { return }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(item as CFDictionary, nil)
  }
}

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
