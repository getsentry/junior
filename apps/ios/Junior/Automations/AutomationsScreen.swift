import JuniorKit
import SwiftUI

/// Route `/automations` (`searchAutomations`): the Automations the viewer can
/// see, grouped by state. Changes happen on the web.
struct AutomationsScreen: View {
  @Environment(AppModel.self) private var app
  @State private var automations: [Automation] = []
  @State private var total = 0
  @State private var page = 1
  @State private var loaded = false
  @State private var loadingMore = false
  @State private var error: JuniorAPIError?
  @State private var query = ""
  @State private var scope = "all"
  @State private var state = "all"
  @State private var openSections: Set<String> = []

  var body: some View {
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 16) {
            PageTitle(title: "Automations")
            HStack(spacing: 8) {
              SearchField(placeholder: "Search automations", text: $query)
              FilterMenu(active: scope != "all" || state != "all") {
                Picker("Show", selection: $scope) {
                  Text("All automations").tag("all")
                  Text("Created by me").tag("mine")
                  Text("Needs attention").tag("attention")
                }
                Picker("State", selection: $state) {
                  Text("Any state").tag("all")
                  Text("Active").tag("active")
                  Text("Paused").tag("paused")
                  Text("Blocked").tag("blocked")
                  Text("Completed").tag("completed")
                }
              }
            }
          }
          content
        }
        .padding(16)
      }
      .refreshable { await load() }
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
    .task(id: [query, scope, state]) {
      if loaded { try? await Task.sleep(for: .milliseconds(250)) }
      await load()
    }
  }

  @ViewBuilder private var content: some View {
    if !loaded {
      VStack(spacing: 0) {
        ForEach(0..<3, id: \.self) { _ in
          HStack {
            VStack(alignment: .leading, spacing: 8) {
              Skeleton(width: 180, height: 16)
              Skeleton(width: 140, height: 12)
            }
            Spacer()
            Skeleton(width: 70, height: 12)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 12)
        }
      }
      .listCard()
    } else if let error, automations.isEmpty {
      EmptyBox(text: error.localizedDescription) { Task { await load() } }
    } else if automations.isEmpty {
      EmptyBox(
        text: query.isEmpty && scope == "all" && state == "all"
          ? "No automations yet. Ask \(app.agentName) to schedule one." : "No automations match.")
    } else {
      ForEach(sections, id: \.id) { section in
        let foldable = section.id == "paused" || section.id == "completed"
        let open = !foldable || openSections.contains(section.id)
        VStack(alignment: .leading, spacing: 10) {
          if foldable {
            Button {
              if open { openSections.remove(section.id) } else { openSections.insert(section.id) }
            } label: {
              HStack(spacing: 6) {
                Icon("chevron-right", size: 14).rotationEffect(.degrees(open ? 90 : 0))
                Text("\(section.title) \(section.items.count)")
              }
              .type(.xs, .medium)
              .foregroundStyle(Tokens.textMuted)
            }
            .buttonStyle(.plain)
          } else {
            HStack(spacing: 8) {
              Text(section.title).type(.sm, .semibold).foregroundStyle(Tokens.text)
              Text("\(section.items.count)").type(.sm).foregroundStyle(Tokens.textFaint)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
          }
          if open {
            VStack(spacing: 0) {
              ForEach(Array(section.items.enumerated()), id: \.element.id) { index, automation in
                AutomationRow(automation: automation)
                  .hairline(.top, index == 0 ? .clear : Tokens.borderSubtle)
              }
            }
            .listCard()
          }
        }
      }
      if automations.count < total {
        Button(loadingMore ? "Loading…" : "Load more") { Task { await loadMore() } }
          .buttonStyle(.dashboard(.ghost))
          .disabled(loadingMore)
          .frame(maxWidth: .infinity)
      }
    }
  }

  /// Needs attention, Active, Paused, Completed, as the dashboard groups them.
  private var sections: [(id: String, title: String, items: [Automation])] {
    let order: [(String, String, (Automation) -> Bool)] = [
      ("attention", "Needs attention", { $0.status == "blocked" || $0.lastRunStatus == "failed" }),
      ("active", "Active", { $0.status == "active" }),
      ("paused", "Paused", { $0.status == "paused" }),
      ("completed", "Completed", { $0.status == "completed" }),
    ]
    var remaining = automations
    return order.compactMap { id, title, matches in
      let items = remaining.filter(matches)
      remaining.removeAll(where: matches)
      return items.isEmpty ? nil : (id, title, items)
    }
  }

  private var arguments: [String: JSONValue] {
    var arguments: [String: JSONValue] = ["scope": .string(scope), "state": .string(state)]
    let trimmed = query.trimmingCharacters(in: .whitespaces)
    if !trimmed.isEmpty { arguments["q"] = .string(trimmed) }
    return arguments
  }

  private func load() async {
    do {
      let list = try await app.call("searchAutomations", arguments, as: AutomationList.self)
      automations = list.automations
      total = list.total
      page = 1
      error = nil
    } catch let error as JuniorAPIError {
      self.error = error
    } catch {}
    loaded = true
  }

  private func loadMore() async {
    loadingMore = true
    defer { loadingMore = false }
    var next = arguments
    next["page"] = .number(Double(page + 1))
    guard let list = try? await app.call("searchAutomations", next, as: AutomationList.self) else { return }
    let known = Set(automations.map(\.id))
    automations += list.automations.filter { !known.contains($0.id) }
    total = list.total
    page += 1
  }
}

/// Page title: Outfit 30 light with a hairline under it.
struct PageTitle: View {
  let title: String
  var description: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title)
        .type(.xxxl, .light, family: .display, lineHeight: 1)
        .tracking(-0.9)
        .foregroundStyle(Tokens.text)
        .accessibilityAddTraits(.isHeader)
      if let description {
        Text(description).type(.xs, lineHeight: 1.625).foregroundStyle(Tokens.textMuted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.bottom, 16)
    .hairline(.bottom, Tokens.borderSubtle)
  }
}

private struct AutomationRow: View {
  @Environment(AppModel.self) private var app
  let automation: Automation

  var body: some View {
    Button {
      app.path = [.automation(automation.id)]
    } label: {
      HStack(alignment: .center, spacing: 24) {
        VStack(alignment: .leading, spacing: 4) {
          Text(automation.title)
            .type(.base, .medium, family: .display)
            .foregroundStyle(Tokens.text)
            .lineLimit(1)
          TriggerLine(automation: automation)
          if let reason = automation.statusReason {
            Text(reason)
              .type(.xs)
              .foregroundStyle(automation.status == "blocked" ? Color.palette(.amber, 300) : Tokens.textMuted)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.top, 2)
          } else if automation.lastRunStatus == "failed" {
            Text("The last run failed.").type(.xs).foregroundStyle(Color.palette(.rose, 300)).padding(.top, 2)
          }
        }
        .opacity(automation.status == "paused" || automation.status == "completed" ? 0.6 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .trailing, spacing: 4) {
          Text(statusLine).foregroundStyle(Tokens.text)
          Text(automation.lastRunAt?.date.map { "Ran \(app.clock.relative($0))" } ?? "Never run")
            .foregroundStyle(Tokens.textMuted)
        }
        .type(.xs)
        .multilineTextAlignment(.trailing)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .background(selected ? Tokens.fillHover : .clear)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle(radius: 0, pressedFill: Tokens.fillSoft))
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  /// Open beside the list.
  private var selected: Bool { app.path.first == .automation(automation.id) }

  private var statusLine: String {
    switch automation.status {
    case "paused": return "Paused"
    case "blocked": return "Blocked"
    case "completed": return "No future runs"
    default:
      if automation.kind == "event" { return "Listening" }
      return automation.nextRunAt?.date.map { "Next \(app.clock.relative($0))" } ?? "No next run"
    }
  }
}

/// Trigger icon, trigger text, and destination.
struct TriggerLine: View {
  let automation: Automation

  var body: some View {
    HStack(spacing: 6) {
      Icon(automation.kind == "scheduled" ? "calendar-clock" : "zap", size: 13)
      Text(automation.trigger).lineLimit(1)
      Text("·").opacity(0.45)
      Text(automation.destination).lineLimit(1)
    }
    .type(.xs)
    .foregroundStyle(Tokens.textMuted)
  }
}

/// The outline filter button beside a search field, with its choices.
struct FilterMenu<Choices: View>: View {
  let active: Bool
  @ViewBuilder var choices: Choices

  var body: some View {
    Menu {
      choices
    } label: {
      Icon("sliders-horizontal", size: 15)
        .foregroundStyle(active ? Tokens.accentText : Tokens.text)
        .frame(width: 36, height: 36)
        .background(active ? Tokens.accent.opacity(0.1) : Tokens.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
        .overlay(
          RoundedRectangle(cornerRadius: 6).strokeBorder(active ? Tokens.accent.opacity(0.6) : Tokens.borderEmphasis))
    }
    .accessibilityLabel(active ? "Filters, on" : "Filters")
  }
}
