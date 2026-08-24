import Foundation

/// A ready-to-render inbox row: the email paired with its cached classification,
/// so list rendering never re-runs the rule engine.
struct EmailRowModel: Identifiable {
    let email: WinnowEmail
    let sig: EmailSignals

    var id: Int { email.id }
}
