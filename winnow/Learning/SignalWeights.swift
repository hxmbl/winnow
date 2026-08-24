import Foundation

/// Every importance signal the classifier uses, exposed as a tunable weight so
/// the user can reshape classification by hand or through star feedback.
/// A future model will train on the logged `FeedbackEvent`s; until then the
/// online update rule in `LearningModel` is the "training".
enum SignalKey: String, CaseIterable, Identifiable, Codable {
    case starBoost
    case security
    case urgency
    case actionNeeded
    case finance
    case newsletterPenalty
    case promoPenalty
    case spamSensitivity
    case quietContactPenalty
    case topSenderBoost

    var id: String { rawValue }

    var label: String {
        switch self {
        case .starBoost: return "Stars"
        case .security: return "Security alerts"
        case .urgency: return "Urgency"
        case .actionNeeded: return "Action needed"
        case .finance: return "Receipts & billing"
        case .newsletterPenalty: return "Newsletter penalty"
        case .promoPenalty: return "Promo penalty"
        case .spamSensitivity: return "Spam sensitivity"
        case .quietContactPenalty: return "Quiet contact penalty"
        case .topSenderBoost: return "Favorite senders"
        }
    }

    var explanation: String {
        switch self {
        case .starBoost: return "Points added when you starred the thread."
        case .security: return "Points for security & account notices."
        case .urgency: return "Points for time-sensitive language."
        case .actionNeeded: return "Points when a reply or task is asked of you."
        case .finance: return "Points for invoices, receipts and billing."
        case .newsletterPenalty: return "Points removed for newsletters."
        case .promoPenalty: return "Points removed for promotional mail."
        case .spamSensitivity: return "How hard spam likelihood drags importance down."
        case .quietContactPenalty: return "Points removed for rarely-heard senders."
        case .topSenderBoost: return "Top-sender bonus; lower ranks scale from it."
        }
    }

    /// Default points contributed to (or removed from) the importance score.
    var defaultValue: Double {
        switch self {
        case .starBoost: return 22
        case .security: return 16
        case .urgency: return 18
        case .actionNeeded: return 12
        case .finance: return 7
        case .newsletterPenalty: return 9
        case .promoPenalty: return 11
        case .spamSensitivity: return 44
        case .quietContactPenalty: return 6
        case .topSenderBoost: return 18
        }
    }

    /// Hard clamp so a stray slider (or runaway feedback loop) can't invert or
    /// explode a signal's influence.
    var allowedRange: ClosedRange<Double> {
        switch self {
        case .spamSensitivity: return 0...80
        case .finance, .quietContactPenalty: return 0...20
        default: return 0...40
        }
    }

    var keyPath: WritableKeyPath<SignalWeights, Double> {
        switch self {
        case .starBoost: return \.starBoost
        case .security: return \.security
        case .urgency: return \.urgency
        case .actionNeeded: return \.actionNeeded
        case .finance: return \.finance
        case .newsletterPenalty: return \.newsletterPenalty
        case .promoPenalty: return \.promoPenalty
        case .spamSensitivity: return \.spamSensitivity
        case .quietContactPenalty: return \.quietContactPenalty
        case .topSenderBoost: return \.topSenderBoost
        }
    }
}

/// Immutable weight snapshot consumed by the classifier. Defaults reproduce the
/// original hand-tuned constants exactly.
struct SignalWeights: Codable, Equatable {
    var starBoost = SignalKey.starBoost.defaultValue
    var security = SignalKey.security.defaultValue
    var urgency = SignalKey.urgency.defaultValue
    var actionNeeded = SignalKey.actionNeeded.defaultValue
    var finance = SignalKey.finance.defaultValue
    var newsletterPenalty = SignalKey.newsletterPenalty.defaultValue
    var promoPenalty = SignalKey.promoPenalty.defaultValue
    var spamSensitivity = SignalKey.spamSensitivity.defaultValue
    var quietContactPenalty = SignalKey.quietContactPenalty.defaultValue
    var topSenderBoost = SignalKey.topSenderBoost.defaultValue

    nonisolated static let standard = SignalWeights()
}
