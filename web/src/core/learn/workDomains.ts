/**
 * Your work domains, read from the mail you have sent.
 *
 * Smart-filter learning never makes a domain-wide sender rule for your own domain:
 * everyone you work with writes from it, and one colleague's mail says nothing about
 * another's (`filterLearning.ts`). "Your own domain" used to mean only the signed-in
 * account's. Sign in with a personal Gmail that also gets work mail, and the company
 * domain was not protected: correct mail from two colleagues and the whole company
 * got a rule.
 *
 * So a domain also counts as yours when you have written to at least
 * `MIN_WORK_RECIPIENTS` different people there: To, Cc or Bcc on mail in Sent. That is
 * the shape of a workplace (or a club, a school, a family business): several people at
 * one domain you write to yourself. Shared providers such as gmail.com never count,
 * since they never get a domain rule in the first place (`canRuleDomain`).
 *
 * The cost of a wrong guess is small and in the safe direction: a domain counted as
 * yours just gets no domain-wide rule. Rules for each exact address still work there.
 *
 * Fully local: read from the messages already on this device, no setting, nothing
 * written to Gmail or stored. It is recomputed from the mailbox whenever it changes,
 * so it follows the account that is open.
 */

import type { Email } from "../model/email";
import { canRuleDomain, registrableDomain } from "./filterClues";

/** People you have written to at a domain before it counts as yours. */
export const MIN_WORK_RECIPIENTS = 3;

const EMPTY: ReadonlySet<string> = new Set();
const cache = new WeakMap<readonly Email[], ReadonlySet<string>>();

/**
 * The domains you have written to at least `MIN_WORK_RECIPIENTS` different addresses at,
 * from the Sent mail in `emails`. Memoised per array.
 */
export function workDomainsFromSent(emails: readonly Email[]): ReadonlySet<string> {
  const hit = cache.get(emails);
  if (hit) return hit;
  const people = new Map<string, Set<string>>();
  for (const email of emails) {
    if (email.mailbox !== "sent") continue;
    for (const list of [email.to, email.cc, email.bcc]) {
      if (!list) continue;
      for (const contact of list) {
        const address = contact.address.trim().toLowerCase();
        if (!address.includes("@")) continue;
        const domain = registrableDomain(address);
        if (!canRuleDomain(domain)) continue;
        let set = people.get(domain);
        if (!set) {
          set = new Set();
          people.set(domain, set);
        }
        set.add(address);
      }
    }
  }
  const found = new Set<string>();
  for (const [domain, addresses] of people) if (addresses.size >= MIN_WORK_RECIPIENTS) found.add(domain);
  const result = found.size === 0 ? EMPTY : found;
  cache.set(emails, result);
  return result;
}
