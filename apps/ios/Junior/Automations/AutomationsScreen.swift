import JuniorKit
import SwiftUI

/// Route `/automations` and `/automations/runs`, as two tabs.
struct AutomationsScreen: View {
  enum Tab { case automations, runs }

  @Environment(AppModel.self) private var app

  var body: some View {
    let tab = Binding<Tab>(get: { app.showRuns ? .runs : .automations }, set: { app.showRuns = $0 == .runs })
    VStack(spacing: 0) {
      AppHeader(title: app.agentName)
      SegmentedTabs(tabs: [(.automations, "Automations"), (.runs, "Runs")], selection: tab)
      switch tab.wrappedValue {
      case .automations: AutomationListView()
      case .runs: RunListView()
      }
    }
    .background(Tokens.bg)
    .toolbar(.hidden, for: .navigationBar)
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

private struct AutomationListView: View {
  @Environment(AppModel.self) private var app
  @State private var automations: [Automation] = []
  @State private var loaded = false
  @State private var error: JuniorAPIError?
  @State private var query = ""
  @State private var type = ""
  @State private var state = ""
  @State private var openSections: Set<String> = []

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 16) {
          PageTitle(title: "Automations")
          HStack(spacing: 8) {
            SearchField(placeholder: "Search automations", text: $query)
            FilterMenu(active: !type.isEmpty || !state.isEmpty) {
              Picker("Type", selection: $type) {
                Text("Any type").tag("")
                Text("Scheduled").tag("scheduled")
                Text("Event").tag("event")
              }
              Picker("State", selection: $state) {
                Text("Any state").tag("")
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
    .task(id: [query, type, state]) {
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
        text: query.isEmpty && type.isEmpty && state.isEmpty
          ? "No automations yet. Ask \(app.agentName) to schedule one." : "No automations match.")
    } else {
      ForEach(automationSections(automations, clock: app.clock), id: \.id) { section in
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
    }
  }

  private func load() async {
    var params = [URLQueryItem(name: "pageSize", value: "100")]
    if !query.isEmpty { params.append(URLQueryItem(name: "q", value: query)) }
    if !type.isEmpty { params.append(URLQueryItem(name: "type", value: type)) }
    if !state.isEmpty { params.append(URLQueryItem(name: "state", value: state)) }
    do {
      let list: AutomationList = try await app.client.get("/api/automations", query: params)
      automations = list.automations
      error = nil
    } catch let error as JuniorAPIError {
      self.error = error
    } catch {}
    loaded = true
  }
}

private struct AutomationRow: View {
  @Environment(AppModel.self) private var app
  let automation: Automation

  var body: some View {
    Button {
      app.path.append(.automation(automation.id))
    } label: {
      HStack(alignment: .center, spacing: 24) {
        VStack(alignment: .leading, spacing: 4) {
          Text(automation.title)
            .type(.base, .medium, family: .display)
            .foregroundStyle(Tokens.text)
            .lineLimit(1)
          TriggerLine(automation: automation)
          if let problem = automation.problem(clock: app.clock) {
            // The message and its link are separate items that wrap, as on the web.
            FlowLayout(spacing: 8, lineSpacing: 4) {
              Text(problem.message)
                .type(.xs)
                .foregroundStyle(problem.failed ? Color.palette(.rose, 300) : Color.palette(.amber, 300))
                .fixedSize(horizontal: false, vertical: true)
              Text(problem.action).type(.xs, .medium).foregroundStyle(Tokens.text)
            }
            .padding(.top, 2)
          }
        }
        .opacity(automation.status == .paused || automation.status == .completed ? 0.6 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        VStack(alignment: .trailing, spacing: 4) {
          Text(statusLine).foregroundStyle(Tokens.text)
          Text(automation.lastRunAt.map { "Ran \(app.clock.relative($0))" } ?? "Never run")
            .foregroundStyle(Tokens.textMuted)
        }
        .type(.xs)
        .multilineTextAlignment(.trailing)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle(radius: 0, pressedFill: Tokens.fillSoft))
    .accessibilityElement(children: .combine)
  }

  private var statusLine: String {
    switch automation.status {
    case .paused: return "Paused"
    case .blocked: return "Blocked"
    case .completed: return "No future runs"
    default:
      if automation.kind == .event { return automation.hasTriggerProblems ? "Not listening" : "Listening" }
      return automation.nextRunAt.map { "Next \(app.clock.relative($0))" } ?? "No next run"
    }
  }
}

/// Trigger icon, trigger summary, and destination.
struct TriggerLine: View {
  let automation: Automation

  var body: some View {
    HStack(spacing: 6) {
      Icon(automation.kind == .scheduled ? "calendar-clock" : "zap", size: 13)
      Text(automation.triggerSummary).lineLimit(1)
      if let destination = automation.destination?.label {
        Text("·").opacity(0.45)
        if automation.destination?.visibility == .private { Icon("lock-keyhole", size: 12) }
        Text(destination).lineLimit(1)
      }
    }
    .type(.xs)
    .foregroundStyle(Tokens.textMuted)
  }
}

private struct RunListView: View {
  @Environment(AppModel.self) private var app
  @State private var runs: [AutomationRun] = []
  @State private var loaded = false
  @State private var error: JuniorAPIError?
  @State private var query = ""
  @State private var status = ""
  @State private var kind = ""

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 16) {
          PageTitle(
            title: "Runs",
            description: "Newest runs across your automations and automations in public destinations.")
          HStack(spacing: 8) {
            SearchField(placeholder: "Automation, conversation, or status", text: $query)
            FilterMenu(active: !status.isEmpty || !kind.isEmpty) {
              Picker("Status", selection: $status) {
                Text("Any status").tag("")
                Text("Completed").tag("completed")
                Text("Failed").tag("failed")
                Text("Blocked").tag("blocked")
              }
              Picker("Trigger", selection: $kind) {
                Text("Any trigger").tag("")
                Text("Scheduled").tag("scheduled")
                Text("Event").tag("event")
              }
            }
          }
        }
        if !loaded {
          Skeleton(height: 220, radius: 8)
        } else if let error, runs.isEmpty {
          EmptyBox(text: error.localizedDescription) { Task { await load() } }
        } else {
          let visible = filtered
          (Text("\(visible.count) runs") + Text(" · newest first").foregroundStyle(Tokens.textMuted.opacity(0.7)))
            .type(.sm)
            .foregroundStyle(Tokens.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 12)
            .hairline(.bottom, Tokens.borderSubtle)
          VStack(spacing: 0) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, run in
              RunRow(run: run).hairline(.top, index == 0 ? .clear : Tokens.borderSubtle)
            }
          }
          .listCard()
        }
      }
      .padding(16)
    }
    .refreshable { await load() }
    .task { await load() }
  }

  private var filtered: [AutomationRun] {
    let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
    return runs.filter { run in
      (status.isEmpty || run.status.rawValue == status) && (kind.isEmpty || run.kind?.rawValue == kind)
        && (needle.isEmpty
          || [run.automationTitle, run.title, run.status.rawValue].compactMap { $0?.lowercased() }
            .contains { $0.contains(needle) })
    }
  }

  private func load() async {
    do {
      let list: AutomationRunList = try await app.client.get("/api/automations/runs")
      runs = list.runs
      error = nil
    } catch let error as JuniorAPIError {
      self.error = error
    } catch {}
    loaded = true
  }
}

/// One run: title and time, Automation and status, then metrics.
struct RunRow: View {
  @Environment(AppModel.self) private var app
  let run: AutomationRun

  var body: some View {
    Button {
      if let id = run.conversationId { app.path.append(.conversation(id)) }
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        VStack(alignment: .leading, spacing: 4) {
          Text(run.title ?? run.automationTitle ?? "No conversation")
            .type(.sm, .medium)
            .foregroundStyle(Tokens.text)
            .lineLimit(1)
          if let date = run.executedAt {
            Text(app.clock.dateTimeWithZone(date)).type(.xs).foregroundStyle(Tokens.textMuted)
          }
        }
        VStack(alignment: .leading, spacing: 4) {
          if let title = run.automationTitle {
            Text(title).type(.sm).foregroundStyle(Tokens.text)
          }
          HStack(spacing: 6) {
            Icon(run.kind == .event ? "zap" : "calendar-clock", size: 14)
              .foregroundStyle(Tokens.accent.opacity(0.8))
            Dot(color: runColor(run.status))
            Text(run.status.rawValue).type(.xs).foregroundStyle(Tokens.textMuted)
          }
        }
        metric("Duration", run.durationMs.map { formatEventDuration($0) })
        metric("Tokens", run.totalTokens.map { formatCompactCount($0) })
        metric("Cost", run.costUsd.map { formatCost($0) })
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle(radius: 0, pressedFill: Tokens.fillSoft))
    .accessibilityElement(children: .combine)
  }

  private func metric(_ label: String, _ value: String?) -> some View {
    HStack(spacing: 8) {
      Text(label).type(.xxs, .medium).foregroundStyle(Tokens.textMuted)
      Text(value ?? "—").type(.xs, family: .mono).foregroundStyle(Tokens.textMuted)
    }
  }
}

func runColor(_ status: RunStatus) -> Color {
  switch status {
  case .completed: .palette(.emerald, 300)
  case .failed: .palette(.rose, 300)
  default: .palette(.amber, 300)
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
