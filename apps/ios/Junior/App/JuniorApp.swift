import JuniorKit
import SafariServices
import SwiftUI

@main
struct JuniorApp: App {
  @State private var app = AppModel()
  /// Across all windows: active while any window is in front.
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView(app: app)
        .environment(app)
        .preferredColorScheme(app.theme.colorScheme)
        .task { await app.refreshShell() }
        .onChange(of: scenePhase, initial: true) { _, phase in
          app.isActive = phase == .active
          if phase == .active { app.startTicking() } else { app.stopTicking() }
        }
    }
  }
}

/// One window: the current place under one navigation stack, with the
/// drawer over it. With regular width and room for both columns (an iPad),
/// the place's list and the open item show side by side.
struct RootView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.horizontalSizeClass) private var sizeClass
  @State private var window: WindowModel
  @State private var inbox = InboxModel()

  init(app: AppModel) {
    _window = State(initialValue: WindowModel(app: app))
  }

  var body: some View {
    @Bindable var window = window
    Group {
      if !app.signedIn {
        ConnectScreen()
      } else {
        // Half-screen Split View and Stage Manager windows can be regular
        // but too narrow for the list beside the open item.
        GeometryReader { shell(split: sizeClass == .regular && $0.size.width >= splitMinWidth) }
      }
    }
    .background(Tokens.bg.ignoresSafeArea())
    .simultaneousGesture(TapGesture().onEnded { app.noteInput() })
    .sheet(item: $window.webPage) { url in
      SafariView(url: url).ignoresSafeArea()
    }
    .sheet(item: $window.changelog) { ChangelogSheet(page: $0) }
    .alert("The demo has no web dashboard", isPresented: $window.demoWebNotice) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("In your workspace, this opens in the \(app.agentName) dashboard.")
    }
    .onChange(of: app.signedIn) { _, signedIn in
      if !signedIn { window.reset() }
    }
    .environment(window)
    .environment(inbox)
  }

  private func shell(split: Bool) -> some View {
    @Bindable var window = window
    return ZStack {
      Group {
        if split {
          SplitShell { placeRoot }
        } else {
          NavigationStack(path: $window.path) {
            placeRoot
              .background(SwipeBackEnabler().frame(width: 0, height: 0))
              .navigationDestination(for: Route.self) { RouteScreen(route: $0) }
          }
        }
      }
      .tint(Tokens.accent)

      if window.drawerOpen {
        if split {
          Tokens.overlay.ignoresSafeArea()
            .onTapGesture { withAnimation(.snappy(duration: 0.25)) { window.drawerOpen = false } }
            .transition(.opacity)
            .zIndex(1)
        }
        // A side panel over a wide screen; the whole screen on a phone.
        Drawer(split: split)
          .frame(maxWidth: split ? 360 : .infinity)
          .frame(maxWidth: .infinity, alignment: .leading)
          .transition(.move(edge: .leading))
          .zIndex(2)
      }
    }
  }

  @ViewBuilder private var placeRoot: some View {
    switch window.place {
    case .conversations: HomeScreen()
    case .inbox: InboxScreen()
    case .automations: AutomationsScreen()
    }
  }
}

/// The screen for a route, pushed or open beside the list.
struct RouteScreen: View {
  let route: Route
  var column: SplitColumn?

  var body: some View {
    Group {
      switch route {
      case .conversation(let id): ConversationScreen(conversationId: id)
      case .inboxItem(let id): InboxItemScreen(itemId: id)
      case .automation(let id): AutomationScreen(automationId: id)
      case .settings: SettingsScreen()
      }
    }
    .environment(\.splitColumn, column)
    // A deep link opens with a pushed screen and never shows the root.
    .background(SwipeBackEnabler().frame(width: 0, height: 0))
  }
}

extension URL: @retroactive Identifiable {
  public var id: String { absoluteString }
}

/// Dashboard pages this app does not render natively.
struct SafariView: UIViewControllerRepresentable {
  let url: URL

  func makeUIViewController(context: Context) -> SFSafariViewController {
    let controller = SFSafariViewController(url: url)
    controller.preferredControlTintColor = UIColor(Tokens.accent)
    return controller
  }

  func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// Keeps the edge swipe back working while screens hide the navigation bar
/// and draw their own header. Scoped to this app's stack.
struct SwipeBackEnabler: UIViewControllerRepresentable {
  func makeUIViewController(context: Context) -> Controller { Controller() }
  func updateUIViewController(_ controller: Controller, context: Context) {}

  final class Controller: UIViewController, UIGestureRecognizerDelegate {
    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      navigationController?.interactivePopGestureRecognizer?.delegate = self
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
      (navigationController?.viewControllers.count ?? 0) > 1
    }
  }
}
