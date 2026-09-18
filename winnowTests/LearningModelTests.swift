import Foundation
import Testing
@testable import winnow

@MainActor
final class LearningModelTests {

    private let suiteName: String
    private let defaults: UserDefaults

    init() {
        // Fresh per-instance domain so suites never share state; force-unwrap
        // makes an invalid name fail loudly instead of silently polluting
        // the shared standard defaults.
        suiteName = "winnow.tests.learning.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
    }

    deinit {
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
    }

    private func makeModel() -> LearningModel {
        LearningModel(defaults: defaults)
    }

    // MARK: Defaults & ranges

    @Test func freshModelsStartAtFactoryDefaults() {
        let model = makeModel()

        for key in SignalKey.allCases {
            #expect(model.weight(key) == key.defaultValue)
        }
        #expect(model.adaptive)
        #expect(model.events.isEmpty)
    }

    @Test func weightsClampToTheirAllowedRanges() {
        let model = makeModel()

        model.setWeight(.security, 999)
        #expect(model.weight(.security) == 40)

        model.setWeight(.finance, -10)
        #expect(model.weight(.finance) == 0)

        model.setWeight(.spamSensitivity, 80)
        #expect(model.weight(.spamSensitivity) == 80)

        model.setWeight(.finance, 99)
        #expect(model.weight(.finance) == 20)
    }

    @Test func weightsRoundToWholePoints() {
        let model = makeModel()
        model.setWeight(.urgency, 10.4)
        #expect(model.weight(.urgency) == 10)

        model.setWeight(.actionNeeded, 7.6)
        #expect(model.weight(.actionNeeded) == 8)
    }

    @Test func adjustmentsReportDriftFromDefaults() {
        let model = makeModel()
        #expect(model.adjustment(.security) == 0)

        model.setWeight(.security, 20)
        #expect(model.adjustment(.security) == 4)
    }

    // MARK: Change notifications

    @Test func onlyEffectiveChangesFireTheRebuildHook() {
        let model = makeModel()
        var rebuilds = 0
        model.onWeightsChanged = { rebuilds += 1 }

        model.setWeight(.security, 999)   // clamped change → fires
        model.setWeight(.security, 40)    // identical value → silent
        #expect(rebuilds == 1)

        model.resetAdjustments()          // real reset → fires
        #expect(rebuilds == 2)

        model.resetAdjustments()          // already default → silent
        #expect(rebuilds == 2)
    }

    // MARK: Feedback loop

    @Test func starringBoostsActiveSignalsAndShrinksActivePenalties() {
        let model = makeModel()
        let sig = Fixtures.signals(security: true, newsletter: true)

        model.record(action: .starred, email: Fixtures.email(id: 9), sig: sig)

        #expect(model.weight(.security) == SignalKey.security.defaultValue + 1)
        #expect(model.weight(.newsletterPenalty) == SignalKey.newsletterPenalty.defaultValue - 1)

        var untouched = SignalKey.allCases
        untouched.removeAll { $0 == .security || $0 == .newsletterPenalty }
        for key in untouched {
            #expect(model.weight(key) == key.defaultValue)
        }
    }

    @Test func unstarringReversesTheNudge() {
        let model = makeModel()
        let email = Fixtures.email(id: 3)
        let sig = Fixtures.signals(security: true, newsletter: true)

        model.record(action: .starred, email: email, sig: sig)
        model.record(action: .unstarred, email: email, sig: sig)

        #expect(model.weight(.security) == SignalKey.security.defaultValue)
        #expect(model.weight(.newsletterPenalty) == SignalKey.newsletterPenalty.defaultValue)
    }

    @Test func starringSpamSoftensSpamSensitivityWithoutAReverseNudge() {
        let model = makeModel()
        let spammy = Fixtures.signals(spamLikelihood: 0.6)

        model.record(action: .starred, email: Fixtures.email(), sig: spammy)
        #expect(model.weight(.spamSensitivity) == SignalKey.spamSensitivity.defaultValue - 1)

        model.record(action: .unstarred, email: Fixtures.email(), sig: spammy)
        #expect(model.weight(.spamSensitivity) == SignalKey.spamSensitivity.defaultValue - 1)
    }

    @Test func safeMailNeverMovesSpamSensitivity() {
        let model = makeModel()
        model.record(action: .starred, email: Fixtures.email(), sig: Fixtures.signals(security: true))
        #expect(model.weight(.spamSensitivity) == SignalKey.spamSensitivity.defaultValue)
    }

    @Test func everyFeedbackEventLogsThePreFlipPrediction() {
        let model = makeModel()
        let sig = Fixtures.signals(promotional: true, importanceScore: 77)
        let email = Fixtures.email(id: 12, sender: "shop@x.co")

        model.record(action: .starred, email: email, sig: sig)

        let event = model.events.first
        #expect(event?.emailID == 12)
        #expect(event?.sender == "shop@x.co")
        #expect(event?.action == .starred)
        #expect(event?.predictedImportance == 77)
        #expect(event?.activeSignals.contains(.promoPenalty) == true)
    }

    @Test func manualModeRecordsEventsWithoutLearning() {
        let model = makeModel()
        model.setAdaptive(false)

        model.record(action: .starred, email: Fixtures.email(), sig: Fixtures.signals(promotional: true))

        #expect(model.events.count == 1)
        for key in SignalKey.allCases {
            #expect(model.weight(key) == key.defaultValue)
        }
    }

    @Test func theEventLogCapsAtFourHundredEntriesDroppingOldestFirst() {
        let model = makeModel()
        model.setAdaptive(false)

        for id in 0..<405 {
            model.record(action: .starred, email: Fixtures.email(id: id), sig: Fixtures.signals())
        }

        #expect(model.events.count == 400)
        #expect(model.events.first?.emailID == 5)
        #expect(model.events.last?.emailID == 404)
    }

    @Test func resettingWeightsKeepsTheEventLog() {
        let model = makeModel()
        model.setAdaptive(false)
        model.setWeight(.urgency, 30)
        model.record(action: .starred, email: Fixtures.email(id: 2), sig: Fixtures.signals())

        model.resetAdjustments()

        #expect(model.weights == SignalWeights.standard)
        #expect(model.events.count == 1)
    }

    // MARK: Persistence

    @Test func persistenceIsDebouncedUntilFlushedOrTheDelayElapses() async throws {
        let model = makeModel()
        model.setWeight(.urgency, 25)

        #expect(defaults.data(forKey: LearningModel.storageKey) == nil)

        model.flushPendingPersist()
        let flushed = try #require(defaults.data(forKey: LearningModel.storageKey))
        let decoded = try JSONDecoder().decode(LearningModel.Snapshot.self, from: flushed)
        #expect(decoded.weights.urgency == 25)
    }

    @Test func debouncedPersistenceLandsOnItsOwnAfterADelay() async throws {
        let model = makeModel()
        model.record(action: .starred, email: Fixtures.email(id: 3), sig: Fixtures.signals(security: true))

        #expect(defaults.data(forKey: LearningModel.storageKey) == nil)

        let start = Date()
        while defaults.data(forKey: LearningModel.storageKey) == nil {
            // The debounce is 200ms; under full-suite parallel load the
            // main-actor task can be starved well past the former 2s window.
            if Date().timeIntervalSince(start) > 10.0 {
                Issue.record("Debounced persist never landed")
                return
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }

        let data = try #require(defaults.data(forKey: LearningModel.storageKey))
        let decoded = try JSONDecoder().decode(LearningModel.Snapshot.self, from: data)
        #expect(decoded.events.count == 1)
    }

    @Test func flushWithoutPendingChangesIsANoop() {
        let model = makeModel()
        model.flushPendingPersist()
        #expect(defaults.data(forKey: LearningModel.storageKey) == nil)
    }

    @Test func stateSurvivesAcrossInstancesThroughDefaults() {
        let first = makeModel()
        first.setWeight(.urgency, 25)
        first.setAdaptive(false)
        first.record(action: .starred, email: Fixtures.email(id: 42), sig: Fixtures.signals(security: true))
        first.flushPendingPersist()

        let second = makeModel()

        #expect(second.weight(.urgency) == 25)
        #expect(!second.adaptive)
        #expect(second.events.count == 1)
        #expect(second.events.first?.emailID == 42)
    }

    @Test func aFreshDomainStartsEmptyEvenWhenOtherDomainsHaveState() {
        let populated = makeModel()
        populated.setWeight(.urgency, 30)

        let other = UserDefaults(suiteName: suiteName + ".other")!
        defer { other.removePersistentDomain(forName: suiteName + ".other") }

        let isolated = LearningModel(defaults: other)
        #expect(isolated.weights == SignalWeights.standard)
        #expect(isolated.events.isEmpty)
    }
}
