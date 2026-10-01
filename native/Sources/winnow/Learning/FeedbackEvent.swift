import Foundation

/// One labeled example: what the user did to a message — or to a smart filter —
/// and what the engine had predicted at that moment. This is the data a real
/// model trains on later.
struct FeedbackEvent: Codable, Identifiable, Equatable {
    enum Action: String, Codable {
        case starred, unstarred, filterRejected
    }

    let id: UUID
    /// Optional: filter rejection is a global act on a bucket, not on one
    /// message, so those events carry no email identity.
    let emailID: Int?
    let sender: String?
    let action: Action
    /// Importance score predicted before the user acted; nil when no message
    /// was in scope (filter rejection).
    let predictedImportance: Int?
    /// Signals present on the email when the action happened.
    let activeSignals: [SignalKey]
    /// Set when `action == .filterRejected`: which smart bucket was dismissed.
    let rejectedFilter: BuiltinSmartFilter?
    let at: Date
}
