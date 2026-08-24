import Foundation

/// Formats an arrival time (Unix milliseconds) as a short, locale-aware
/// date + time for list rows and the viewer header.
func formatListTime(_ receivedAtMs: Int) -> String {
    listDateFormatter.string(from: Date(timeIntervalSince1970: TimeInterval(receivedAtMs) / 1000))
}

/// Cached because `DateFormatter` is relatively expensive to create and this
/// runs once per visible row.
private let listDateFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateStyle = .medium
    formatter.timeStyle = .short
    return formatter
}()
