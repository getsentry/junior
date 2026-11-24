import SwiftUI
import UIKit

/// The composer's text view. With `onSubmit`, Return sends, from the software
/// keyboard and from a hardware keyboard, and a newline comes from Shift-Return
/// on a hardware keyboard, from "New Line" in the edit menu, or from pasted
/// text. Without it, Return inserts a newline.
///
/// A SwiftUI `TextField` with a vertical axis cannot do this: Return always
/// inserts a newline, `onSubmit` never runs, and the field cannot tell
/// Shift-Return from Return.
struct MessageTextView: UIViewRepresentable {
  @Binding var text: String
  @Binding var focused: Bool
  let placeholder: String
  let onSubmit: (() -> Void)?

  /// 16pt Inter with the dashboard's `leading-relaxed` (1.625) line height.
  /// Computed so it follows Dynamic Type.
  private static var font: UIFont { Typography.uiFont(.sans, .base, weight: .regular) }
  private static var lineHeight: CGFloat { (font.pointSize * 1.625).rounded() }
  /// Lines before the view scrolls.
  private static let maxLines: CGFloat = 4

  private static var attributes: [NSAttributedString.Key: Any] {
    let font = font
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    return [
      .font: font,
      .foregroundColor: UIColor(Tokens.text),
      .paragraphStyle: paragraph,
      // Center the glyphs in the line, as CSS does; UIKit puts the extra
      // height above them.
      .baselineOffset: (lineHeight - font.lineHeight) / 4,
    ]
  }

  func makeUIView(context: Context) -> ComposerTextView {
    let view = ComposerTextView()
    view.delegate = context.coordinator
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.font = Self.font
    view.adjustsFontForContentSizeCategory = true
    if onSubmit != nil { view.returnKeyType = .send }
    view.onSubmit = onSubmit
    view.tintColor = UIColor(Tokens.accent)
    view.typingAttributes = Self.attributes
    // The text carries its own font, so `adjustsFontForContentSizeCategory`
    // does not resize it, and `updateUIView` restyles it only when the text
    // changes.
    view.registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) {
      (view: ComposerTextView, _: UITraitCollection) in
      let attributes = MessageTextView.attributes
      // Attributes only: the text, the selection, and IME marked text stay.
      view.textStorage.setAttributes(attributes, range: NSRange(location: 0, length: view.textStorage.length))
      view.typingAttributes = attributes
    }
    view.accessibilityLabel = placeholder
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    return view
  }

  func updateUIView(_ view: ComposerTextView, context: Context) {
    context.coordinator.parent = self
    view.onSubmit = onSubmit
    view.accessibilityLabel = placeholder
    if view.text != text {
      view.attributedText = NSAttributedString(string: text, attributes: Self.attributes)
      view.typingAttributes = Self.attributes
    }
    // After the update: changing the first responder during one warns.
    if focused != view.isFirstResponder {
      let focus = focused
      Task { @MainActor in
        if focus { view.becomeFirstResponder() } else { view.resignFirstResponder() }
      }
    }
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView view: ComposerTextView, context: Context) -> CGSize? {
    guard let width = proposal.width, width.isFinite else { return nil }
    let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    let lineHeight = Self.lineHeight
    let height = min(max(fitting, lineHeight), lineHeight * Self.maxLines)
    view.isScrollEnabled = fitting > height
    return CGSize(width: width, height: height)
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  @MainActor
  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: MessageTextView

    init(_ parent: MessageTextView) { self.parent = parent }

    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText: String) -> Bool {
      (textView as? ComposerTextView)?.note(
        "sc:\(replacementText.debugDescription):kn=\((textView as? ComposerTextView)?.keepsNewlines ?? false)")  // DIAG
      guard replacementText == "\n", let view = textView as? ComposerTextView,
        let onSubmit = view.onSubmit, !view.keepsNewlines,
        // Return commits a marked (IME) text first.
        textView.markedTextRange == nil
      else { return true }
      // The composer decides whether the text can send; Return never adds a newline.
      onSubmit()
      view.note("delegateSubmit:cs=\(ComposerTextView.diagCanSend)")  // DIAG
      return false
    }

    func textViewDidChange(_ textView: UITextView) {
      if parent.text != textView.text { parent.text = textView.text }
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      (textView as? ComposerTextView)?.note("begin")  // DIAG
      if !parent.focused { parent.focused = true }
    }

    func textViewDidEndEditing(_ textView: UITextView) {
      (textView as? ComposerTextView)?.note("end")  // DIAG
      if parent.focused { parent.focused = false }
    }

    func textView(
      _ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
      guard let view = textView as? ComposerTextView, view.onSubmit != nil else { return nil }
      let newLine = UIAction(title: "New Line", image: UIImage(systemName: "return")) { [weak view] _ in
        view?.insertLineBreak()
      }
      return UIMenu(children: suggestedActions + [newLine])
    }
  }
}

/// Takes Return and Shift-Return from a hardware keyboard with key commands,
/// before the text system inserts a newline. The software keyboard's Return
/// has no key event; it reaches the delegate as an inserted newline.
final class ComposerTextView: UITextView {
  var onSubmit: (() -> Void)?
  /// True while a newline is text, not Return: "New Line" and paste.
  private(set) var keepsNewlines = false

  /// Insert a newline at the cursor; the delegate lets this one through.
  @objc func insertLineBreak() {
    note("ilb")  // DIAG
    keepsNewlines = true
    defer { keepsNewlines = false }
    insertText("\n")
  }

  /// Pasted text keeps its newlines, even a lone one.
  override func paste(_ sender: Any?) {
    keepsNewlines = true
    defer { keepsNewlines = false }
    super.paste(sender)
  }

  override var keyCommands: [UIKeyCommand]? {
    keyCommandReads += 1  // DIAG
    // While an IME has marked text, Return commits it.
    guard onSubmit != nil, markedTextRange == nil else { return super.keyCommands }
    let commands = [
      UIKeyCommand(title: "Send", action: #selector(submit), input: "\r"),
      UIKeyCommand(title: "New Line", action: #selector(insertLineBreak), input: "\r", modifierFlags: .shift),
    ]
    for command in commands { command.wantsPriorityOverSystemBehavior = true }
    return commands + (super.keyCommands ?? [])
  }

  @objc private func submit() {
    onSubmit?()
    note("submit:cs=\(Self.diagCanSend)")  // DIAG
  }

  // DIAG start
  nonisolated(unsafe) static var diagCanSend: Bool?
  private var diag: [String] = []
  private var otherPresses = 0
  private var keyCommandReads = 0
  func note(_ entry: String) {
    diag.append(entry)
    accessibilityIdentifier = "kc=\(keyCommandReads) op=\(otherPresses) " + diag.joined(separator: "|")
  }
  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    for press in presses {
      guard let key = press.key else { continue }
      if key.keyCode == .keyboardReturnOrEnter || !key.modifierFlags.intersection([.shift, .alternate, .command]).isEmpty {
        note("pb:\(key.keyCode.rawValue):m=\(key.modifierFlags.rawValue):c=\(key.characters.debugDescription):fr=\(isFirstResponder):os=\(onSubmit != nil):mt=\(markedTextRange != nil)")
      } else {
        otherPresses += 1
      }
    }
    super.pressesBegan(presses, with: event)
  }
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    let result = super.canPerformAction(action, withSender: sender)
    if action == #selector(submit) || action == #selector(insertLineBreak) { note("cpa:\(action):\(result)") }
    return result
  }
  override func target(forAction action: Selector, withSender sender: Any?) -> Any? {
    let result = super.target(forAction: action, withSender: sender)
    if action == #selector(submit) || action == #selector(insertLineBreak) {
      note("tfa:\(action):\(result.map { String(describing: type(of: $0)) } ?? "nil")")
    }
    return result
  }
  // DIAG end
}
