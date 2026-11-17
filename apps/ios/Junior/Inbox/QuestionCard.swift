import JuniorKit
import SwiftUI

/// The Review item card: the question and its answers, or the notice, or the
/// closed summary (`ReviewItemView.tsx`).
struct QuestionCard: View {
  @Environment(AppModel.self) private var app
  let item: ReviewItem
  let onUpdate: (ReviewItem) -> Void
  @State private var picked: String?
  @State private var formOpen = false
  @State private var selections: [String: Set<String>] = [:]
  @State private var other = ""
  @State private var sending = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      if !item.isOpen {
        closed
      } else if item.kind == .notice || item.request?.question == nil {
        if let body = item.body { MarkdownView(body, step: .sm) }
        actions(showOther: false)
      } else {
        if let question = item.request?.question {
          MarkdownView(question, step: .sm).font(.dashboard(.sm, .medium))
        }
        if item.canAct == false {
          Text("Only an assignee can act on this item.").font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
        } else if let field = item.quickChoiceField, !formOpen,
          field.options?.contains(where: { $0.description != nil }) == true
        {
          quickOptions(field)
          actions(showOther: true)
        } else if let field = item.quickChoiceField, !formOpen {
          FlowLayout(spacing: 8) {
            ForEach(field.options ?? [], id: \.label) { option in
              Button {
                submit(field: field, option: option.label)
              } label: {
                HStack(spacing: 8) {
                  Text(option.label)
                  if option.recommended == true {
                    Text("Suggested").font(.dashboard(.xs)).foregroundStyle(Tokens.accentText.opacity(0.8))
                  }
                }
              }
              .buttonStyle(.dashboard(.outline))
              .disabled(sending)
              .accessibilityIdentifier("review-option")
            }
          }
          actions(showOther: true)
        } else {
          form
        }
      }
      if let error { InlineError(text: error) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(16)
    .background(Tokens.surfacePanel, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tokens.borderEmphasis))
  }

  private func quickOptions(_ field: ReviewItem.Field) -> some View {
    VStack(spacing: 8) {
      ForEach(field.options ?? [], id: \.label) { option in
        let isPicked = picked == option.label
        Button {
          submit(field: field, option: option.label)
        } label: {
          HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
              HStack(spacing: 8) {
                Text(option.label).font(.dashboard(.sm, .medium)).foregroundStyle(Tokens.text)
                if option.recommended == true {
                  Text("Suggested").font(.dashboard(.xs)).foregroundStyle(Tokens.accentText.opacity(0.8))
                }
              }
              if let description = option.description {
                Text(description).font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
              }
            }
            Spacer(minLength: 0)
            if isPicked { Icon("arrow-right", size: 16).foregroundStyle(Tokens.textFaint) }
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(isPicked ? Tokens.accent.opacity(0.1) : Tokens.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
          .overlay(
            RoundedRectangle(cornerRadius: 6).strokeBorder(isPicked ? Tokens.accent.opacity(0.6) : Tokens.border))
          .opacity(sending && !isPicked ? 0.6 : 1)
          .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .disabled(sending)
        .accessibilityHint(option.recommended == true ? "Suggested" : "")
        .accessibilityIdentifier("review-option")
      }
    }
    .padding(.top, -4)
  }

  private func actions(showOther: Bool) -> some View {
    HStack(spacing: 8) {
      if showOther {
        Button("Other…") { formOpen = true }.buttonStyle(.dashboard(.outline))
      }
      if item.canTake == true {
        Button("Take") { perform(.take) }.buttonStyle(.dashboard(.ghost)).disabled(sending)
      }
      Button("Dismiss") { perform(.dismiss) }.buttonStyle(.dashboard(.ghost)).disabled(sending)
      Spacer(minLength: 0)
    }
  }

  @ViewBuilder private var form: some View {
    let fields = item.request?.fields ?? []
    ForEach(fields) { field in
      VStack(alignment: .leading, spacing: 8) {
        if fields.count > 1 || field.kind != .choice, let label = field.label {
          Text(field.kind == .multiChoice ? "\(label) · Pick any" : label)
            .font(.dashboard(.xs, .medium))
            .foregroundStyle(Tokens.textMuted)
        }
        if field.kind == .text {
          TextField("", text: textBinding(field.id), axis: .vertical)
            .font(.dashboard(.sm))
            .padding(10)
            .background(Tokens.control, in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.borderEmphasis))
        } else {
          ForEach(field.options ?? [], id: \.label) { option in
            let selected = selections[field.id, default: []].contains(option.label)
            Button {
              toggle(field, option.label)
            } label: {
              HStack(alignment: .top, spacing: 10) {
                Icon(
                  field.kind == .multiChoice
                    ? (selected ? "checkmark.square.fill" : "square") : (selected ? "largecircle.fill.circle" : "circle"),
                  size: 16
                )
                .foregroundStyle(selected ? Tokens.accent : Tokens.textMuted)
                VStack(alignment: .leading, spacing: 2) {
                  HStack(spacing: 8) {
                    Text(option.label).font(.dashboard(.sm, .medium)).foregroundStyle(Tokens.text)
                    if option.recommended == true {
                      Text("Suggested").font(.dashboard(.xs)).foregroundStyle(Tokens.accentText.opacity(0.8))
                    }
                  }
                  if let description = option.description {
                    Text(description).font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
                  }
                }
                Spacer(minLength: 0)
              }
              .padding(10)
              .background(selected ? Tokens.accent.opacity(0.1) : Tokens.surfaceRaised, in: RoundedRectangle(cornerRadius: 6))
              .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(selected ? Tokens.accent.opacity(0.6) : Tokens.border))
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
          }
        }
      }
    }
    VStack(alignment: .leading, spacing: 6) {
      Text("Anything else?").font(.dashboard(.xs, .medium)).foregroundStyle(Tokens.textMuted)
      TextField("", text: $other, axis: .vertical)
        .font(.dashboard(.sm))
        .lineLimit(2...6)
        .padding(10)
        .background(Tokens.control, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.borderEmphasis))
      Text("Optional. This note is sent together with your answers above.")
        .font(.dashboard(.xs))
        .foregroundStyle(Tokens.textFaint)
    }
    HStack(spacing: 8) {
      Button("Send") { submitForm() }
        .buttonStyle(.dashboard(.primary))
        .disabled(sending || (selections.values.allSatisfy(\.isEmpty) && other.trimmingCharacters(in: .whitespaces).isEmpty))
      if fields.count > 1 {
        let answered = fields.filter { !(selections[$0.id] ?? []).isEmpty }.count
        Text("\(answered) of \(fields.count) answered").font(.dashboard(.xs)).foregroundStyle(Tokens.textMuted)
      }
      Spacer(minLength: 0)
      if item.quickChoiceField != nil {
        Button("Cancel") { formOpen = false }.buttonStyle(.dashboard(.ghost))
      }
    }
  }

  @ViewBuilder private var closed: some View {
    let verb = item.status == .dismissed ? "dismissed" : "closed"
    let when = (item.closedAt ?? item.updatedAt).map { " \(app.clock.relative($0))" } ?? ""
    Text("\(item.closedBy?.displayName ?? item.closedBy?.email ?? "An agent") \(verb) this\(when).")
      .font(.dashboard(.sm))
      .foregroundStyle(Tokens.textMuted)
    if let reason = item.closeReason { Text(reason).font(.dashboard(.sm)).foregroundStyle(Tokens.text) }
    if let values = item.answer?.values, !values.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        ForEach(values.keys.sorted(), id: \.self) { key in
          let label = item.request?.fields?.first { $0.id == key }?.label ?? key
          VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.dashboard(.xs, .medium)).foregroundStyle(Tokens.textMuted)
            Text(values[key]!.texts.joined(separator: ", ")).font(.dashboard(.sm)).foregroundStyle(Tokens.text)
          }
        }
        if let other = item.answer?.other {
          Text(other).font(.dashboard(.sm)).foregroundStyle(Tokens.text)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(Tokens.fillSoft, in: RoundedRectangle(cornerRadius: 6))
    }
  }

  private func textBinding(_ id: String) -> Binding<String> {
    Binding(
      get: { selections[id]?.first ?? "" },
      set: { selections[id] = $0.isEmpty ? [] : [$0] })
  }

  private func toggle(_ field: ReviewItem.Field, _ label: String) {
    var set = selections[field.id, default: []]
    if field.kind == .multiChoice {
      if set.contains(label) { set.remove(label) } else { set.insert(label) }
    } else {
      set = set.contains(label) ? [] : [label]
    }
    selections[field.id] = set
  }

  private func submit(field: ReviewItem.Field, option: String) {
    picked = option
    perform(.submit(values: [field.id: [option]]))
  }

  private func submitForm() {
    let values = selections.compactMapValues { $0.isEmpty ? nil : $0.map { $0.trimmingCharacters(in: .whitespaces) } }
    perform(.submit(values: values, other: other))
  }

  private func perform(_ action: ReviewAction) {
    sending = true
    error = nil
    Task {
      defer { sending = false }
      do {
        let updated: ReviewItem = try await app.client.send(
          "POST", "/api/review-items/\(item.id.pathEscaped)/actions", body: action)
        onUpdate(updated)
      } catch let failure as JuniorAPIError {
        picked = nil
        switch failure {
        case .readOnlyToken, .server(_, .some): error = failure.localizedDescription
        default: error = formOpen ? "Could not send your answer. Try again." : "Could not save this action. Try again."
        }
      } catch {
        picked = nil
      }
    }
  }
}
