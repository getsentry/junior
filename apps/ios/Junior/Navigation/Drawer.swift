import JuniorKit
import SwiftUI

/// Full-screen navigation drawer (`DashboardHeader.tsx` mobile menu): spend,
/// primary places, account pages, theme, and the signed-in person.
struct Drawer: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    @Bindable var app = app
    VStack(spacing: 0) {
      HStack {
        Text(app.agentName)
          .font(.dashboard(.sm, .semibold))
          .foregroundStyle(Tokens.textSolid)
        Spacer()
        Button {
          withAnimation(.snappy(duration: 0.25)) { app.drawerOpen = false }
        } label: {
          Icon("x", size: 20)
            .foregroundStyle(Tokens.text)
            .frame(width: 40, height: 40)
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("Close navigation")
      }
      .padding(.leading, 12)
      .padding(.trailing, 4)
      .padding(.vertical, 8)
      .background(Tokens.surfaceRaised)
      .hairline(.bottom, Tokens.borderSubtle)

      ScrollView {
        VStack(alignment: .leading, spacing: 4) {
          SpendCard(spend: app.spend)
            .padding(.bottom, 8)
          NavRow(label: "Go to conversation", icon: "search", active: false) {
            app.go(.conversations)
            app.focusSearch = true
          }
          NavRow(label: "Conversations", active: app.place == .conversations && app.path.isEmpty) {
            app.go(.conversations)
          }
          NavRow(label: "Inbox", count: app.inboxCount, active: app.place == .inbox) {
            app.go(.inbox)
          }
          NavRow(label: "Automations", active: app.place == .automations) {
            app.go(.automations)
          }
          Rectangle().fill(Tokens.borderSubtle).frame(height: 1)
            .padding(.top, 12)
            .padding(.bottom, 8)
          if let email = app.viewer?.user.email {
            NavRow(label: "My profile", active: false) {
              app.openOnWeb("/system/people/\(email.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? email)")
            }
          }
          NavRow(label: "Settings", active: app.path.last == .settings) {
            app.drawerOpen = false
            app.path = [.settings]
          }
          NavRow(label: "Code", active: false) { app.openOnWeb("/code") }
          NavRow(label: "System", active: false) { app.openOnWeb("/system") }
          if app.viewer?.user.isAdmin == true {
            NavRow(label: "Admin", active: false) { app.openOnWeb("/admin") }
          }
          ThemeRow(theme: $app.theme)
            .padding(.top, 4)
        }
        .padding(12)
      }

      ProfileFooter(viewer: app.viewer, version: app.config?.version)
    }
    .background(Tokens.bgElevated)
  }
}

private struct SpendCard: View {
  let spend: Spend?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Spend").font(.dashboard(.xs, .medium))
      line("7d", spend?.sevenDaysUsd)
      line("30d", spend?.thirtyDaysUsd)
    }
    .foregroundStyle(Tokens.textMuted)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(Tokens.fillSoft, in: RoundedRectangle(cornerRadius: 8))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.border))
    .accessibilityElement(children: .combine)
  }

  private func line(_ label: String, _ value: Double?) -> some View {
    (Text(label + " ") + Text(value.map(usd) ?? "—").font(.dashboard(.xs, .semibold)).foregroundStyle(Tokens.text))
      .font(.dashboard(.xs))
      .monospacedDigit()
  }

  private func usd(_ value: Double) -> String {
    value > 0 && value < 0.01 ? String(format: "$%.4f", value) : String(format: "$%.2f", value)
  }
}

private struct NavRow: View {
  let label: String
  var icon: String?
  var count: Int = 0
  let active: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 8) {
        if let icon { Icon(icon, size: 16) }
        Text(label)
        if count > 0 {
          Text(count.formatted())
            .font(.dashboard(.xs))
            .monospacedDigit()
            .foregroundStyle(Color.palette(.violet, 200))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.palette(.violet, 300).opacity(0.2), in: Capsule())
            .padding(.leading, -2)
        }
        Spacer(minLength: 0)
      }
      .font(.dashboard(.sm, .medium))
      .foregroundStyle(active ? Tokens.accentText : Tokens.textMuted)
      .padding(12)
      .frame(minHeight: 44)
      .background(active ? Tokens.accent.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 8))
      .contentShape(RoundedRectangle(cornerRadius: 8))
    }
    .buttonStyle(PressableStyle(pressedFill: Tokens.fillSoft))
    .accessibilityAddTraits(active ? .isSelected : [])
    .accessibilityLabel(count > 0 ? "\(label), \(count)" : label)
  }
}

/// "Theme" with the System / Light / Dark segmented control.
struct ThemeRow: View {
  @Binding var theme: ThemeChoice

  var body: some View {
    HStack {
      Text("Theme")
        .font(.dashboard(.sm, .semibold))
        .foregroundStyle(Tokens.text)
      Spacer()
      HStack(spacing: 2) {
        segment(.system, "monitor", "System")
        segment(.light, "sun", "Light")
        segment(.dark, "moon", "Dark")
      }
      .padding(2)
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.border))
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
  }

  private func segment(_ choice: ThemeChoice, _ icon: String, _ label: String) -> some View {
    let selected = theme == choice
    return Button {
      theme = choice
    } label: {
      Icon(icon, size: 14)
        .foregroundStyle(selected ? Tokens.text : Tokens.textMuted)
        .frame(width: 40, height: 28)
        .background(selected ? Tokens.surfaceActive : .clear, in: RoundedRectangle(cornerRadius: 6))
        .overlay {
          if selected { RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.borderInteractive) }
        }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(label) theme")
    .accessibilityAddTraits(selected ? .isSelected : [])
  }
}

private struct ProfileFooter: View {
  let viewer: Viewer?
  let version: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let user = viewer?.user {
        let identity = ActorIdentity(email: user.email, fullName: user.name)
        HStack(spacing: 10) {
          Circle().fill(Tokens.accent).frame(width: 28, height: 28)
            .overlay(
              Text(identity.initials).font(.dashboard(.xs, .bold)).foregroundStyle(Tokens.textInverse))
          VStack(alignment: .leading, spacing: 2) {
            Text(identity.displayName).font(.dashboard(.xs, .semibold)).foregroundStyle(Tokens.text)
            if user.email != identity.displayName {
              Text(user.email).font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
            }
          }
        }
        .accessibilityElement(children: .combine)
      }
      if let version {
        Text("junior version \(version)").font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 12)
    .hairline(.top, Tokens.borderSubtle)
  }
}
