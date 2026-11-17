import JuniorKit
import SafariServices
import SwiftUI

@main
struct JuniorApp: App {
  @State private var app = AppModel()
  @State private var inbox = InboxModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(app)
        .environment(inbox)
        .preferredColorScheme(app.theme.colorScheme)
        .task { await app.refreshShell() }
        .onChange(of: scenePhase, initial: true) { _, phase in
          app.isActive = phase == .active
          if phase == .active { app.startPolling() } else { app.stopPolling() }
        }
    }
  }
}

/// The current place under one navigation stack, with the drawer over it.
struct RootView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    @Bindable var app = app
    ZStack {
      NavigationStack(path: $app.path) {
        placeRoot
          .background(SwipeBackEnabler().frame(width: 0, height: 0))
          .navigationDestination(for: Route.self) { route in
            switch route {
            case .conversation(let id): ConversationScreen(conversationId: id)
            case .reviewItem(let id): ReviewItemScreen(itemId: id)
            case .automation(let id): AutomationScreen(automationId: id)
            case .settings: SettingsScreen()
            }
          }
      }
      .tint(Tokens.accent)

      if app.drawerOpen {
        Drawer()
          .transition(.move(edge: .leading))
          .zIndex(1)
      }
    }
    .background(Tokens.bg.ignoresSafeArea())
    .simultaneousGesture(TapGesture().onEnded { app.noteInput() })
    .sheet(item: $app.webPage) { url in
      SafariView(url: url).ignoresSafeArea()
    }
  }

  @ViewBuilder private var placeRoot: some View {
    switch app.place {
    case .conversations: HomeScreen()
    case .inbox: InboxScreen()
    case .automations: AutomationsScreen()
    }
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
