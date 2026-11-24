/// The server's `initialize` version, such as `0.314.0+<commit>`, as
/// "0.314.0 · 4f2c9a1": the release and the short commit that it deployed.
public func serverVersionLabel(_ version: String) -> String {
  let parts = version.split(separator: "+", maxSplits: 1)
  guard parts.count == 2 else { return version }
  return "\(parts[0]) · \(parts[1].prefix(7))"
}
