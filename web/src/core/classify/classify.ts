/**
 * The classifier: one message in, one set of signals out.
 *
 * Pure and synchronous, so a cached classification stays valid across restarts.
 * Spam likelihood is computed before importance — importance has to pay for it,
 * and that ordering is the whole design.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/Classifier.swift`.
 */

import type { Email } from "../model/email";
import type { EmailSignals } from "../model/signals";
import { trashBiasFor, type UserProfile } from "../model/profile";
import { STANDARD_WEIGHTS, type SignalWeights } from "./weights";
import {
  ADDRESS_REGEX,
  bodyWordCount,
  clickHereRegex,
  codesKeywords,
  eventsKeywords,
  financeKeywords,
  financeRegex,
  isShoutySubject,
  needsActionRegexes,
  newsletterKeywords,
  coercionRegex,
  phishingRegex,
  promoRegex,
  replyRequestRegex,
  securityKeywords,
  shippingKeywords,
  socialKeywords,
  SOCIAL_DOMAINS,
  spamKeywords,
  travelKeywords,
  urgentKeywords,
} from "./heuristics";

/** Body length, in words, at which a message counts as a long read. */
export const LONG_READ_WORDS = 250;

/**
 * Subject + body only, lowercased.
 *
 * The sender is deliberately excluded: a mailbox called `newsletter@…` is not a
 * newsletter, and `billing@…` is not a bill, so classification is about what was
 * said rather than who said it. Search *does* include the sender; see `inboxSearchBag`.
 */
export function contentBag(email: Email): string {
  return `${email.subject} ${email.body}`.toLowerCase();
}

/**
 * Sender + subject + body, lowercased — the search haystack.
 *
 * Wider than `contentBag` on purpose: searching for a name should find the
 * mail from that person even when the name appears nowhere in the text.
 */
export function inboxSearchBag(email: Email): string {
  return `${email.sender} ${email.subject} ${email.body}`.toLowerCase();
}

/**
 * True when the message arrived from a social platform's address.
 *
 * **Host-suffix matching, not substring.** A host matches when it *is* the domain
 * or ends with `.<domain>`, admitting `mail.linkedin.com` and rejecting
 * `notlinkedin.com` and `linkedin.com.evil.example`. A substring test lets anyone
 * claim any platform by writing its name into their own hostname — exactly the
 * confusion the `social` bucket exists to prevent. The `local@host` part is taken
 * explicitly so a display address with no `@` — `LinkedIn <notifications>`, which
 * several of these send — is still judged on its host.
 *
 * Punycode is not decoded: `xn--` hosts arrive already in ASCII from the envelope,
 * and an internationalised hostname cannot match an ASCII table anyway.
 */
export function matchesSocialDomain(email: Email): boolean {
  const lines = [email.sender, email.address ?? ""];
  return lines.some((line) => {
    const at = line.lastIndexOf("@");
    // A display name leaves the host followed by `>`, and a bare domain can carry a
    // trailing dot; both are stripped before comparing, or the legitimate form misses.
    const tail = (at >= 0 ? line.slice(at + 1) : line.split(/\s+/).pop() ?? "")
      .trim()
      // Everything a display name or an RFC 5322 comment can leave behind.
      .replace(/[>)\]]+$/, "")
      .replace(/[.,;]+$/, "");
    const host = tail.toLowerCase();
    if (!host) return false;
    return SOCIAL_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  });
}

/**
 * Engagement bonus, as a fraction of the top-sender boost: tier 0 gets all of it,
 * tier 1 two thirds, tier 2 one third, everyone else nothing. Shared by the
 * importance and smart-score formulas so the two agree about who matters.
 */
export function senderRankBonus(
  profile: UserProfile,
  sender: string,
  topBoost = 18,
): number {
  const rank = profile.topSenders.indexOf(sender);
  if (rank === 0) return topBoost;
  if (rank >= 1 && rank <= 2) return Math.floor((topBoost * 2) / 3);
  if (rank >= 3 && rank < 6) return Math.floor(topBoost / 3);
  return 0;
}

/**
 * Classify one message.
 *
 * `weights` is the tuned set from the learning model; it defaults to the
 * factory values so a caller that does not care about tuning pays nothing.
 */
export function classifyEmail(
  email: Email,
  profile: UserProfile,
  weights: SignalWeights = STANDARD_WEIGHTS,
): EmailSignals {
  const text = contentBag(email);
  const actionText = `${email.subject} ${email.body}`;
  const bias = trashBiasFor(profile, email.sender);

  // ── Security, and the gates everything else reads ──
  // Gmail has no security category — it files account notices under "updates"
  // alongside shipping and calendar mail — so this is keyword-driven only.
  const security = securityKeywords.any(text);
  const newsletterHits = newsletterKeywords.count(text);
  // Gmail's own label is trusted outright; wording needs corroboration.
  const newsletter = email.category === "newsletter" || newsletterHits >= 2;

  // ── Bulk and marketing ──
  const promotional =
    (email.category === "promotions" || promoRegex.test(text)) && !security;

  // A sender-set flag beats the keyword test: a person decided this was urgent.
  const urgentText = email.urgent || urgentKeywords.any(text);

  // ── Asks of the reader ──
  // The reply-request half is gated on bulk mail: every newsletter ends with
  // "let me know what you think", and counting that would put the entire
  // newsletter backlog into "Action needed".
  const needsAction =
    needsActionRegexes.some((pattern) => pattern.test(actionText)) ||
    (replyRequestRegex.test(actionText) && !newsletter && !promotional);

  // ── Semantic buckets ──
  // Each is gated so a bucket never swallows mail another bucket exists for:
  // a security notice is not a receipt, a promo is not a delivery.
  const finance =
    (financeKeywords.any(text) || financeRegex.test(text)) && !security && !promotional;
  const codes = codesKeywords.any(text) && !security;
  const shipping = shippingKeywords.any(text) && !security && !promotional;
  const travel = travelKeywords.any(text) && !security && !promotional && !newsletter;
  const events = eventsKeywords.any(text) && !security && !promotional && !newsletter;
  const social =
    (socialKeywords.any(text) || matchesSocialDomain(email)) &&
    !security &&
    !newsletter &&
    !promotional;

  const longRead = bodyWordCount(email.body) >= LONG_READ_WORDS;

  // ── Spam likelihood ──
  let spamLikelihood = 0;
  const subjectEmpty = email.subject.trim().length === 0;
  const bodyEmpty = email.body.trim().length === 0;
  // Both empty is almost never a real message; a bare subject usually is.
  if (subjectEmpty && bodyEmpty) spamLikelihood += 0.55;
  else if (subjectEmpty) spamLikelihood += 0.2;

  const sender = email.sender.trim();
  if (sender && ADDRESS_REGEX.test(sender)) {
    const lower = sender.toLowerCase();
    // A no-reply address that is *also* bulk mail is one more small tell.
    if (lower.startsWith("noreply") && (newsletter || promotional)) spamLikelihood += 0.05;
    if (lower.startsWith("marketing") || lower.startsWith("digest")) spamLikelihood += 0.05;

    const domain = sender.split("@").pop() ?? "";
    // `example.com` is the documentation reserved domain; real mail from it is
    // a fixture, and the mock seed uses it deliberately.
    if (domain.toLowerCase().endsWith("example.com")) spamLikelihood += 0.18;
    // Digits in a domain are rare for established senders and common for throwaway.
    if (/\d/.test(domain)) spamLikelihood += 0.1;
  }

  // Phishing phrasing dominates; a bare "click here" is only a nudge.
  if (phishingRegex.test(actionText)) spamLikelihood += 0.3;
  else if (clickHereRegex.test(actionText)) spamLikelihood += 0.08;

  // Coercion is scored on top of the binary phishing test, which gave a message
  // that already matched "verify your password" nothing for also threatening to
  // delete the account — exactly the message that should score highest. It is the
  // ingredient that separates a clumsy real notice from a campaign.
  //
  // Capped at 0.45: two coercive phrasings should not be worth more than the
  // threshold on their own, or a long, earnest, urgent-but-real letter about an
  // expiring document would tip over into unsafe on volume of worry alone.
  if (coercionRegex.test(actionText)) spamLikelihood += 0.45;

  const spamHits = spamKeywords.count(text);
  if (spamHits > 0) spamLikelihood += Math.min(0.35, 0.15 + (spamHits - 1) * 0.08);

  if (isShoutySubject(email.subject)) spamLikelihood += 0.12;

  spamLikelihood += bias * 0.22;
  // Mail that is both a newsletter and a promo is machine-generated bulk.
  if (newsletter && promotional) spamLikelihood += 0.08;
  spamLikelihood = Math.min(1, spamLikelihood);

  // ── Importance ──
  let importance = 50;
  if (email.starred) importance += weights.starBoost;
  importance += senderRankBonus(profile, email.sender, weights.topSenderBoost);

  if (security) importance += weights.security;
  if (urgentText) importance += weights.urgency;
  if (needsAction) importance += weights.actionNeeded;
  if (finance) importance += weights.finance;
  if (newsletter) importance -= weights.newsletterPenalty;
  if (promotional) importance -= weights.promoPenalty;

  // Truncated, not rounded, to match the integer pipeline the thresholds were
  // tuned against.
  importance -= Math.trunc(spamLikelihood * weights.spamSensitivity);
  importance -= Math.trunc(bias * 14);
  if (profile.quietSenders.includes(email.sender)) importance -= weights.quietContactPenalty;

  return {
    security,
    newsletter,
    promotional,
    urgentText,
    needsAction,
    finance,
    codes,
    shipping,
    travel,
    events,
    social,
    longRead,
    spamLikelihood,
    importanceScore: importance,
  };
}

/**
 * Classify a batch, keyed by the UI id — what the list, rail ranking and badges all
 * read, so classification happens once per inbox rather than once per render.
 */
export type SignalMap = ReadonlyMap<number, EmailSignals>;

export function classifyAll(
  emails: readonly Email[],
  profile: UserProfile,
  weights: SignalWeights = STANDARD_WEIGHTS,
): SignalMap {
  const map = new Map<number, EmailSignals>();
  for (const email of emails) map.set(email.id, classifyEmail(email, profile, weights));
  return map;
}
