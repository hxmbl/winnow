import Foundation
import Observation

/// User-tunable weights plus an online feedback loop ("training in a way").
///
/// Starring an email nudges every signal present on it up (penalties down);
/// unstarring does the reverse. Updates are small and clamped per signal, so a
/// single mis-click never dominates the ranking. All state persists to
/// UserDefaults; the event log is capped to keep storage bounded.
@MainActor
@Observable
final class LearningModel {
    private(set) var weights = SignalWeights()
    private(set) var adaptive = true
    private(set) var events: [FeedbackEvent] = []

    /// Fired after weights change so the owning store can reclassify the inbox.
    @ObservationIgnored var onWeightsChanged: (() -> Void)?

    /// Points moved per feedback event. Small by design: many signals converge
    /// gradually instead of one star flipping the whole ranking.
    @ObservationIgnored private let learningStep = 1.0
    @ObservationIgnored private let maxEvents = 400
    static let storageKey = "winnow.learning.v1"
    /// Injectable so tests can run against an isolated defaults domain.
    @ObservationIgnored private let defaults: UserDefaults

    /// Slider drags tick `setWeight` many times a second; persisting the full
    /// snapshot (weights + up to 400 events) on every tick is wasted work, so
    /// writes are coalesced shortly after the last change. Call
    /// `flushPendingPersist()` to force an immediate write (tests, termination).
    @ObservationIgnored private var persistTask: Task<Void, Never>?
    @ObservationIgnored private var persistPending = false
    @ObservationIgnored private let persistDelayNanos: UInt64 = 200_000_000

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        load()
    }

    // MARK: Reading & editing weights

    func weight(_ key: SignalKey) -> Double {
        weights[keyPath: key.keyPath]
    }

    /// Points a weight has drifted from its default — drives the "learned" UI.
    func adjustment(_ key: SignalKey) -> Double {
        weight(key) - key.defaultValue
    }

    /// Sets one weight: rounds to an integer, clamps to `allowedRange`,
    /// persists, and fires `onWeightsChanged` so the inbox reclassifies.
    func setWeight(_ key: SignalKey, _ value: Double) {
        let clamped = min(max(value.rounded(), key.allowedRange.lowerBound), key.allowedRange.upperBound)
        guard clamped != weight(key) else { return }
        weights[keyPath: key.keyPath] = clamped
        persist()
        onWeightsChanged?()
    }

    /// Toggles automatic weight updates from star feedback. Manual slider edits
    /// apply either way; does not fire `onWeightsChanged`.
    func setAdaptive(_ on: Bool) {
        adaptive = on
        persist()
    }

    /// Reset every weight back to the factory defaults (keeps the event log).
    func resetAdjustments() {
        guard weights != SignalWeights.standard else { return }
        weights = SignalWeights()
        persist()
        onWeightsChanged?()
    }

    // MARK: Feedback → learning

    /// Record what the user did to an email, then nudge the weights toward it.
    /// Call before mutating `email.starred` so `predictedImportance` reflects
    /// the pre-feedback prediction.
    func record(action: FeedbackEvent.Action, email: WinnowEmail, sig: EmailSignals) {
        let touched = touchedKeys(for: sig)
        events.append(
            FeedbackEvent(
                id: UUID(),
                emailID: email.id,
                sender: email.sender,
                action: action,
                predictedImportance: sig.importanceScore,
                activeSignals: touched,
                at: Date()
            )
        )
        if events.count > maxEvents {
            events.removeFirst(events.count - maxEvents)
        }
        if adaptive {
            applyUpdate(touched: touched, starred: action == .starred, sig: sig)
        }
        persist()
    }

    /// Signals whose influence this feedback should move, with direction:
    /// boosting signals rise when starred; penalty signals shrink when starred
    /// (the mail was worth reading despite the label). Starring mail flagged as
    /// unsafe also softens spam sensitivity — the flag overreacted.
    private func touchedKeys(for sig: EmailSignals) -> [SignalKey] {
        var keys: [SignalKey] = []
        if sig.security { keys.append(.security) }
        if sig.urgentText { keys.append(.urgency) }
        if sig.needsAction { keys.append(.actionNeeded) }
        if sig.finance { keys.append(.finance) }
        if sig.newsletter { keys.append(.newsletterPenalty) }
        if sig.promotional { keys.append(.promoPenalty) }
        return keys
    }

    private func applyUpdate(touched: [SignalKey], starred: Bool, sig: EmailSignals) {
        var updates: [(key: SignalKey, delta: Double)] = []
        for key in touched {
            let boosts = !isPenalty(key)
            updates.append((key, learningStep * ((boosts == starred) ? 1 : -1)))
        }
        if starred && sig.isUnsafe {
            updates.append((.spamSensitivity, -learningStep))
        }

        var changed = false
        for update in updates {
            let current = weight(update.key)
            let next = min(max(current + update.delta, update.key.allowedRange.lowerBound), update.key.allowedRange.upperBound)
            if next != current {
                weights[keyPath: update.key.keyPath] = next
                changed = true
            }
        }
        if changed { onWeightsChanged?() }
    }

    private func isPenalty(_ key: SignalKey) -> Bool {
        switch key {
        case .newsletterPenalty, .promoPenalty, .spamSensitivity, .quietContactPenalty:
            return true
        default:
            return false
        }
    }

    // MARK: Persistence

    /// Shared codecs — allocating them per save added avoidable cost to every
    /// slider tick and star toggle.
    private static let encoder = JSONEncoder()
    private static let decoder = JSONDecoder()

    struct Snapshot: Codable {
        var weights: SignalWeights
        var adaptive: Bool
        var events: [FeedbackEvent]
    }

    private func persist() {
        persistPending = true
        persistTask?.cancel()
        let delay = persistDelayNanos
        persistTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delay)
            guard let self, !Task.isCancelled else { return }
            self.flushPendingPersist()
        }
    }

    /// Writes immediately if a debounced save is still pending.
    func flushPendingPersist() {
        persistTask?.cancel()
        persistTask = nil
        guard persistPending else { return }
        persistPending = false

        let snapshot = Snapshot(weights: weights, adaptive: adaptive, events: events)
        if let data = try? Self.encoder.encode(snapshot) {
            defaults.set(data, forKey: Self.storageKey)
        }
    }

    private func load() {
        guard let data = defaults.data(forKey: Self.storageKey),
              let snapshot = try? Self.decoder.decode(Snapshot.self, from: data) else { return }
        weights = snapshot.weights
        adaptive = snapshot.adaptive
        events = snapshot.events
    }
}
