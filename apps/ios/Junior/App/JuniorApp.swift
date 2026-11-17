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

/// Keep the edge swipe back working while screens draw their own header.
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
  override open func viewDidLoad() {
    super.viewDidLoad()
    navigationBar.isHidden = true
    interactivePopGestureRecognizer?.delegate = self
  }

  public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    viewControllers.count > 1
  }
}
