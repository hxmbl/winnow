import Foundation

/// One labeled example: what the user did to a message and what the engine had
/// predicted at that moment. This is the data a real model trains on later.
struct FeedbackEvent: Codable, Identifiable, Equatable {
    enum Action: String, Codable {
        case starred, unstarred
    }

    let id: UUID
    let emailID: Int
    let sender: String
    let action: Action
    /// Importance score predicted before the user acted.
    let predictedImportance: Int
    /// Signals present on the email when the action happened.
    let activeSignals: [SignalKey]
    let at: Date
}
