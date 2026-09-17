import Foundation

/// Bucket predicate for one built-in filter. Kept side-effect free so it can be
/// reused by both the list pipeline and `rankFilters`.
nonisolated func matchesBuiltin(
    _ filter: BuiltinSmartFilter,
    email: WinnowEmail,
    sig: EmailSignals,
    profile: UserProfile
) -> Bool {
    // Buckets that mean "worth your attention" stop at the Unsafe threshold so
    // they never overlap the spam bucket.
    let safe = !sig.isUnsafe

    switch filter {
    case .starred: return email.starred
    case .important:
        // Important either scores well or clearly needs action — but never spam
        // and never bulk mail, which gets its own buckets.
        return safe && ((sig.importanceScore >= 56 && !sig.newsletter && !sig.promotional)
            || (sig.needsAction && !sig.promotional))
    case .urgent:
        // Marketing "last chance!" pressure is promo noise, not urgency.
        return sig.urgentText && safe && !(sig.promotional && !email.urgent)
    case .security: return sig.security
    case .needsAction:
        // A reply or task is being asked of the reader; exclude newsletters,
        // where every issue "needs" a click.
        return sig.needsAction && safe && !sig.newsletter
    case .receipts:
        return sig.finance && safe
    case .codes:
        return sig.codes && safe
    case .shipping:
        return sig.shipping && safe
    case .travel:
        return sig.travel && safe
    case .events:
        return sig.events && safe
    case .social:
        return sig.social && safe
    case .newSenders:
        return safe && profile.firstTimeSenders.contains(email.sender)
    case .unread:
        return email.unread && safe
    case .attachments:
        return !email.attachments.isEmpty && safe
    case .longReads:
        // Substantive weekend reading — long, low-urgency, and nothing risky
        // or time-sensitive. Overlaps "Read later" by design.
        return sig.longRead && safe && !sig.newsletter && !sig.promotional
            && !sig.urgentText && !sig.security && !sig.needsAction
    case .newsletters: return sig.newsletter
    case .promotional: return sig.promotional
    case .lowPriority:
        // Genuinely skippable: low score, no star, nothing time-sensitive or
        // risky — not merely "is a newsletter".
        return !email.starred && !sig.urgentText && !sig.security && !sig.needsAction
            && sig.importanceScore < 50 && safe
    case .unsafe: return sig.isUnsafe
    case .topContacts: return profile.topSenders.prefix(3).contains(email.sender)
    case .quietContacts: return profile.quietSenders.contains(email.sender)
    }
}

/// True when `email` satisfies the filter — a built-in bucket or a sender match.
nonisolated func matchesSmartFilter(filter: FilterId, email: WinnowEmail, sig: EmailSignals, profile: UserProfile) -> Bool {
    switch filter {
    case .builtin(let builtin): return matchesBuiltin(builtin, email: email, sig: sig, profile: profile)
    case .sender(let sender): return email.sender == sender
    }
}
