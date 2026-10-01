/**
 * The demo mailbox.
 *
 * Winnow ships with a seeded inbox so the app is useful the moment it opens,
 * with no account and no network. That is a real requirement — a mail client
 * that shows a sign-in wall cannot be evaluated, and the classification is the
 * product, so it has to be visible immediately.
 *
 * But a fixture that is only a fixture lies about the app. The rules this
 * seed follows are the reason it is a useful test of the classifier:
 *
 *   - **Every timestamp is before `NOW`.** An earlier version had ten rows in
 *     the future, which rendered as "Today, 11:42 PM" hours before it happened.
 *   - **`NOW` is fixed and exported**, and the list is handed that same value,
 *     so the day sections are the same on every machine, in every timezone.
 *   - **Senders are real addresses.** Sender identity is the join key for the
 *     engagement profile; a seed mixing brands with addresses produced three
 *     identical grey pills and dead trash-bias entries.
 *   - **The bodies are real.** One-sentence bodies cannot reach the 250-word
 *     "Long reads" threshold, so a whole feature was untestable in the demo.
 *   - **Every signal has a fixture.** Security, codes, shipping, travel, events,
 *     social, spam, newsletters — each bucket has at least one message that
 *     exists to be classified into it, and the tests assert as much.
 */

import { hashId } from "../model/ids";
import type { Email, EmailCategory, Mailbox } from "../model/email";
import type { TrashRecord } from "../model/profile";

/**
 * The reference instant. Exported so the list can be handed the same value and
 * the day buckets stay stable regardless of the real clock.
 */
export const DEMO_NOW = Date.UTC(2026, 4, 9, 18, 0, 0);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Every seeded timestamp is an offset from `DEMO_NOW`, so none can be future. */
const ago = (ms: number): number => DEMO_NOW - ms;

type Seed = {
  id: string;
  sender: string;
  name: string;
  /** How long before `DEMO_NOW` this arrived. */
  at: number;
  subject: string;
  body: string;
  category?: EmailCategory;
  starred?: boolean;
  urgent?: boolean;
  unread?: boolean;
  threadId?: string;
  attachments?: { filename: string; mimeType: string; size: number }[];
  /** The bucket this message exists to demonstrate. Asserted by the tests. */
  demonstrates?: string;
};

/** A long body, so the "Long reads" threshold is reachable in the demo. */
const LONG_BODY = `Thanks for the detailed note — I read it twice, because the
second half changes what we would be signing up for and I did not want to get
that part wrong.

Here is where I have landed after thinking about it properly rather than
replying at the keyboard.

The short version is that the timeline works if we move the migration to the
start of the quarter rather than the end. That buys us six weeks, which is
enough to do the data migration on a copy of production and compare row counts,
checksums and query plans without anyone holding their breath. The longer
version is below, and I have tried to keep it to the parts that actually change
a decision.

On the data migration. We do not know yet whether the legacy table can be read
while the new one is being written, because the write path was never exercised
concurrently in staging. If it can, we do this in one pass and the rollback is
a table rename, which takes seconds. If it cannot, we need a brief write
freeze, and the honest cost of that is a customer-visible gap rather than an
engineering one — which means the conversation about the freeze should happen
with support before we promise a date, not after.

On the query plans. I ran the four expensive queries against a copy of
production data and the numbers are worse than the dashboards claim. Two of them
are doing sequential scans that an index would fix outright. The other two I do
not yet understand, and I would rather say that plainly than guess: I do not
know why the third one is slow and I want to find out before we build on it.

On the timeline, specifically. Six weeks is not a scheduling accident. It is
what the rollback testing needs, plus a week of slack for the thing we have not
thought of yet. Every schedule I have seen for this project has been built from
the happy path only, and then has slipped by exactly the amount of unhappy path
we did not plan for.

I have not yet checked whether the six weeks collides with the compliance
audit window. If it does, I would rather move the migration than the audit, and
I would rather find that out this week than in week five.

Happy to talk any of this through. If it is easier, the two paragraphs about
the query plans can be their own thread, because I suspect they are a different
conversation with a different set of people in it.`;

const seeds: readonly Seed[] = [
  // ── Security ──────────────────────────────────────────────────────────────
  {
    id: "demo-security-1",
    sender: "security@stripe.com",
    name: "Stripe Security",
    at: 22 * MINUTE,
    subject: "Security alert: unusual sign-in attempt",
    body: `
We noticed a sign-in to your account from a device we do not recognise.

Location: Lisbon, Portugal Device: Firefox on Linux Time: 08:14 UTC

If this was you, no action is needed. If it was not, you should reset your password and review your active sessions immediately. We have not restricted your account, because a lockout would leave you unable to check whether the sign-in was yours.

If you did not make this request, reply to this message and we will escalate it to the fraud team.`,
    category: "updates",
    unread: true,
    demonstrates: "security",
  },
  {
    // Realistic phishing, and realistic in the ways that matter: a lookalike
    // domain with digits in it, a `no-reply` local part, credential language
    // next to the call to action, and a deadline. The Swift implementation's
    // mock marked this as spam with the words alone; the classifier is more
    // careful than that, and the fixture has to earn the badge it wears.
    id: "demo-security-2",
    sender: "no-reply@github-security227.com",
    name: "GitHub",
    at: 3 * HOUR,
    subject: "Your account has been compromised",
    body: `
A critical security alert. Your account has been compromised and you need to verify your password immediately.

Click here to secure your account: https://github-security227.com/verify

This link expires in 30 minutes. Failure to verify your identity will result in your account being suspended.`,
    demonstrates: "unsafe",
  },
  {
    id: "demo-security-3",
    sender: "noreply@dropbox.com",
    name: "Dropbox",
    at: 2 * DAY,
    subject: "We noticed a new device signed in to your account",
    body: `
A new device signed in to your account. If this was you, you can dismiss this notice. If not, please review your sign-in history.

Device: MacBook Pro Location: London, United Kingdom`,
    category: "updates",
    demonstrates: "security",
  },

  // ── Codes ─────────────────────────────────────────────────────────────────
  {
    id: "demo-codes-1",
    sender: "noreply@okta.com",
    name: "Okta",
    at: 8 * MINUTE,
    subject: "Your verification code",
    body: `
Your verification code is 418 902.

It expires in 10 minutes. We will never ask you for it by email, phone or chat, and no one at Okta will ask you for it. If you did not request this code, you can ignore this message and nothing will have changed.`,
    category: "updates",
    demonstrates: "codes",
  },
  {
    id: "demo-codes-2",
    sender: "no-reply@twilio.com",
    name: "Twilio",
    at: 26 * HOUR,
    subject: "Sign-in code 7741",
    body: `
Use sign-in code 7741 to continue.

This code is valid for 15 minutes and can be used once. If you did not try to sign in, someone may have your password.`,
    category: "updates",
    demonstrates: "codes",
  },

  // ── Shipping ──────────────────────────────────────────────────────────────
  {
    id: "demo-shipping-1",
    sender: "orders@apple.com",
    name: "Apple",
    at: 41 * MINUTE,
    subject: "Your package has shipped",
    body: `
Good news — your order is on its way.

Tracking number: 1Z999AA10123456784 Estimated delivery: Tuesday, 12 May

You can track your package at any time. There is no need to sign for the delivery, and the courier will leave it in a safe place if you are not home.`,
    category: "updates",
    demonstrates: "shipping",
  },
  {
    id: "demo-shipping-2",
    sender: "delivery@bookshop.example",
    name: "Bookshop",
    at: 30 * HOUR,
    subject: "Out for delivery",
    body: `
Your parcel is out for delivery today between 9am and 1pm.

The courier attempted a delivery yesterday and could not leave the package safely. They will try again today. If you are not going to be home, the delivery will be held at the depot for collection.`,
    category: "updates",
    demonstrates: "shipping",
  },

  // ── Travel ────────────────────────────────────────────────────────────────
  {
    id: "demo-travel-1",
    sender: "bookings@airline.example",
    name: "Northern Airways",
    at: 5 * HOUR,
    subject: "Check-in is open — boarding pass attached",
    body: `
Check-in is now open for your flight.

Flight: NA 447 From: London Heathrow (LHR) To: Lisbon (LIS) Departure gate: B22 Boarding: 07:35

Your boarding pass is attached to this message. You do not need to print it — the gate agent can scan the barcode on your phone. Bags must be checked by 07:00.`,
    category: "reservations",
    demonstrates: "travel",
  },
  {
    id: "demo-travel-2",
    sender: "reservations@hotel.example",
    name: "Casa do Sol",
    at: 4 * DAY,
    subject: "Your reservation is confirmed",
    body: `
Your booking confirmation for Casa do Sol, Lisbon.

Check-in: 11 May from 15:00 Check-out: 15 May by 11:00 Rooms: 1 double

Breakfast is included. The hotel can arrange airport transfer if you need it; let us know at least 24 hours ahead.`,
    category: "reservations",
    demonstrates: "travel",
  },

  // ── Events ────────────────────────────────────────────────────────────────
  {
    id: "demo-events-1",
    sender: "calendar@work.example",
    name: "Work Calendar",
    at: 14 * MINUTE,
    subject: "Invitation: architecture review, Thursday",
    body: `
You are invited to an architecture review.

When: Thursday 14 May, 10:00–11:30 Where: Room 2.04 and video call

The agenda is in the shared doc. Please read it beforehand — the last one ran over because we spent twenty minutes on context that should have been in the document. If you cannot make it, an rsvp would help.`,
    category: "updates",
    demonstrates: "events",
  },
  {
    id: "demo-events-2",
    sender: "events@meetup.example",
    name: "Rust Meetup",
    at: 2 * DAY,
    subject: "Save the date: async Rust workshop",
    body: `
A hands-on workshop on async Rust, three hours, no prior async experience assumed.

Reserve your spot now — the room holds 40 and it filled the last two times.

Snacks and coffee provided. Please bring a laptop.`,
    category: "updates",
    demonstrates: "events",
  },

  // ── Receipts ──────────────────────────────────────────────────────────────
  {
    id: "demo-receipts-1",
    sender: "billing@utility.example",
    name: "City Energy",
    at: 6 * HOUR,
    subject: "Your bill is ready",
    body: `
Your bill for April is ready. Total due: £84.20, due 24 May.

This is your regular direct debit, so no action is needed unless the amount has changed. The detailed breakdown is below, and the standing charge is unchanged from last quarter.

If you would like to switch tariff, the deadline is the 20th.`,
    category: "receipts",
    demonstrates: "receipts",
  },
  {
    id: "demo-receipts-2",
    sender: "receipts@coffee.example",
    name: "Rye & Co",
    at: 9 * HOUR,
    subject: "Receipt: order #A-2291",
    body: `
Thanks for stopping by.

2 × filter coffee      £7.00 1 × almond croissant   £4.50 -------------------------- Total                 £11.50

Paid by card ending 4417. No change given.`,
    category: "receipts",
    demonstrates: "receipts",
  },
  {
    id: "demo-receipts-3",
    sender: "billing@hosting.example",
    name: "Northwind Hosting",
    at: 3 * DAY,
    subject: "Invoice 2026-0412 is due",
    body: `
Invoice 2026-0412 for the period 1–30 April.

Plan: Team, monthly       £48.00 Bandwidth overage        £12.40 -------------------------------- Amount due               £60.40

Payment is due within 14 days. Your subscription renewed automatically on 1 May.`,
    category: "receipts",
    demonstrates: "receipts",
  },

  // ── Urgent and action needed ──────────────────────────────────────────────
  {
    id: "demo-urgent-1",
    sender: "ops@partner.example",
    name: "Dana at Northwind",
    at: 4 * MINUTE,
    subject: "URGENT: the migration window moved",
    body: `
The window moved. It is now Thursday 07:00, not Friday.

I know that is short notice and I would rather tell you badly early than well late. If Thursday does not work for you, say so today and I will find another slot this week.

Nothing else changed. The plan is the same one we agreed.

Can you confirm by 16:00 today?`,
    category: "primary",
    urgent: true,
    unread: true,
    demonstrates: "urgent",
  },
  {
    id: "demo-action-1",
    sender: "dana@northwind.example",
    name: "Dana Whitfield",
    at: 2 * HOUR,
    subject: "Re: the migration plan",
    body: `
Thanks for the notes — the query-plan section is the part I was worried about.

Could you send the two slow queries again? I would like to run them here before we commit to the index change, because if the third one is slow for a different reason the index will not fix it and we will have spent a week finding out.

No rush on this — before the end of the week is fine.`,
    category: "primary",
    threadId: "demo-thread-migration",
    demonstrates: "needs_action",
  },
  {
    id: "demo-action-2",
    sender: "sam@northwind.example",
    name: "Sam Okafor",
    at: 5 * DAY,
    subject: "Re: the migration plan",
    body: `
Agreed on the ordering. I would start the data copy on the read replica rather than production — it is an hour behind, which does not matter for a migration rehearsal, and it takes the load off the primary while we find out whether the concurrent write path works at all.

Let me know your thoughts.`,
    category: "primary",
    threadId: "demo-thread-migration",
    demonstrates: "needs_action",
  },
  {
    id: "demo-action-3",
    sender: "dana@northwind.example",
    name: "Dana Whitfield",
    at: 1 * MINUTE,
    subject: "Re: the migration plan",
    body: `
Both queries attached. The third one is the group-by, and I think I know what is happening with it now — it is not the scan, it is that the sort spills. The intermediate result does not fit in the work memory and it is going to disk twice.

A covering index should fix it, but I want to confirm on the replica first rather than take your word and a guess.

Let me know what you think of the plan.`,
    category: "primary",
    threadId: "demo-thread-migration",
    unread: true,
  },
  {
    id: "demo-action-4",
    sender: "registry@example",
    name: "Company Registry",
    at: 3 * DAY,
    subject: "Confirmation of your annual return",
    body: `
Your annual return has been received and accepted.

Company: Northwind Analytics Ltd Period ended: 31 December 2025 Filed: 14 April 2026

No further action is required. A copy is attached for your records.`,
    category: "updates",
    attachments: [{ filename: "annual-return-2025.pdf", mimeType: "application/pdf", size: 184_320 }],
    demonstrates: "attachments",
  },

  // ── Long reads ────────────────────────────────────────────────────────────
  {
    id: "demo-long-1",
    sender: "dana@northwind.example",
    name: "Dana Whitfield",
    at: 6 * DAY,
    subject: "Re: the migration plan",
    body: LONG_BODY,
    category: "primary",
    threadId: "demo-thread-migration",
    demonstrates: "long_reads",
  },

  // ── Newsletters ───────────────────────────────────────────────────────────
  {
    id: "demo-newsletter-1",
    sender: "digest@engineering.example",
    name: "Engineering Digest",
    at: 18 * HOUR,
    subject: "This week in engineering",
    body: `
View in browser · Manage preferences · Unsubscribe

This week: a post on incremental view maintenance, a debugging write-up about a memory leak that took three weeks to find, and a short piece on why most internal tools are rewritten twice.

Also in this issue: the twelve links we read, and one genuinely good talk about estimating distributed systems.`,
    category: "newsletter",
    demonstrates: "newsletters",
  },
  {
    id: "demo-newsletter-2",
    sender: "news@weekly.example",
    name: "The Weekly",
    at: 5 * DAY,
    subject: "The Weekly — issue 412",
    body: `
You are receiving this because you subscribed. Unsubscribe at any time from the link below, or manage preferences to choose what you get.

In this issue: a city guide with no hotel recommendations, an interview about the economics of repair, and a long argument about whether the browser is a runtime or an operating system.

View in browser.`,
    category: "newsletter",
    demonstrates: "newsletters",
  },

  // ── Promotional ───────────────────────────────────────────────────────────
  {
    id: "demo-promo-1",
    sender: "deals@shop.example",
    name: "Northline",
    at: 12 * HOUR,
    subject: "48% off everything — today only",
    body: `
48% off everything, today only. Flash sale, ends at midnight.

Use code SPRING48 at checkout. Free shipping on orders over £50. Offer ends tonight — this is a limited time deal and the prices go back up at midnight whether or not you buy anything.

Unsubscribe from these emails.`,
    category: "promotions",
    demonstrates: "promotional",
  },
  {
    id: "demo-promo-2",
    sender: "newsletter@producthunt.example",
    name: "Product Hunt",
    at: 2 * DAY,
    subject: "The best products of the week",
    body: `
Today's top products.

1. A very small database      — 20% off the first year 2. A deploy tool              — free for open source 3. A design system            — new pricing

Unsubscribe · Manage preferences · View in browser`,
    category: "promotions",
    demonstrates: "promotional",
  },

  // ── Social ────────────────────────────────────────────────────────────────
  {
    id: "demo-social-1",
    sender: "notifications@linkedin.com",
    name: "LinkedIn",
    at: 55 * MINUTE,
    subject: "Sam Okafor mentioned you",
    body: `
Sam Okafor mentioned you in a post.

"Spend a morning reading the query plans on the thing you are about to optimise. It is the highest-leverage hour available to you and almost nobody takes it."

You have 3 new notifications.`,
    category: "social",
    demonstrates: "social",
  },
  {
    id: "demo-social-2",
    sender: "noreply@reddit.com",
    name: "Reddit",
    at: 20 * HOUR,
    subject: "u/rust commented on your post",
    body: `
Someone commented on your post in r/rust.

"You can do it without an async runtime, but you will be reimplementing one poorly. The question is not whether you need the runtime but whether you want to own it."

Reply to the comment.`,
    category: "social",
    demonstrates: "social",
  },

  // ── Personal, from a frequent sender ──────────────────────────────────────
  {
    id: "demo-personal-1",
    sender: "priya@northwind.example",
    name: "Priya Raman",
    at: 3 * HOUR + 20 * MINUTE,
    subject: "coffee thursday?",
    body: `
Are you around thursday afternoon? I am in the office that day and would like to talk through the staging plan before it goes anywhere near production.

The usual place, 15:00? If that is too tight I can do friday morning instead.`,
    category: "primary",
    threadId: "demo-thread-coffee",
    demonstrates: "top_contacts",
  },
  {
    id: "demo-personal-2",
    sender: "priya@northwind.example",
    name: "Priya Raman",
    at: 2 * HOUR,
    subject: "Re: coffee thursday?",
    body: `
Thursday 15:00 works. I will bring the staging numbers, you bring the opinions.

If it runs long there is a place nearby that does a proper lunch rather than sandwiches, if that helps motivate either of us.`,
    category: "primary",
    threadId: "demo-thread-coffee",
    demonstrates: "top_contacts",
  },
  {
    id: "demo-personal-3",
    sender: "marcus@northwind.example",
    name: "Marcus Bell",
    at: 7 * HOUR,
    subject: "quick one",
    body: `
Do we still have the spare key for the annexe? The lock was replaced last month and I cannot find the new one.

No rush.`,
    category: "primary",
    demonstrates: "top_contacts",
  },
  {
    id: "demo-personal-4",
    sender: "marcus@northwind.example",
    name: "Marcus Bell",
    at: 3 * DAY,
    subject: "the kettle is broken again",
    body: `
The kettle in the annexe has stopped heating. I have put a temporary sign on it so nobody wastes ten minutes waiting for it.

I have ordered a replacement. It should arrive tuesday.`,
    category: "primary",
    demonstrates: "top_contacts",
  },
  {
    id: "demo-personal-5",
    sender: "marcus@northwind.example",
    name: "Marcus Bell",
    at: 6 * DAY,
    subject: "fire drill on tuesday",
    body: `
Building-wide fire drill on tuesday at 10:30. The whole floor evacuates via the back stairs, so the front entrance will be blocked for about twenty minutes.`,
    category: "updates",
    demonstrates: "top_contacts",
  },

  // ── Quoted threads ────────────────────────────────────────────────────────
  {
    id: "demo-thread-1",
    sender: "ana@northwind.example",
    name: "Ana Ferreira",
    at: 1 * DAY,
    subject: "Re: staging plan",
    body: `
I have read the plan. Two comments, both small.

The rehearsal on the replica is the right call. I would add one more thing to it: run the rollback, not just the forward path. We have never actually executed the rollback on real data, and a rollback that has not been run is a rumour.`,
    category: "primary",
    threadId: "demo-thread-staging",
  },
  {
    id: "demo-thread-2",
    sender: "ana@northwind.example",
    name: "Ana Ferreira",
    at: 20 * HOUR,
    subject: "Re: staging plan",
    body: `
Second comment: the timeline assumes nobody is on leave. Two people are, in the last week of the month.

I do not think that should move the date. I think the date should assume one person can always be reached, which is a different kind of planning.`,
    category: "primary",
    threadId: "demo-thread-staging",
  },

  // ── First-time senders ────────────────────────────────────────────────────
  {
    id: "demo-new-1",
    sender: "hello@newsupplier.example",
    name: "Kestrel Analytics",
    at: 11 * HOUR,
    subject: "Introductory call — are you the right person?",
    body: `
I am reaching out because we help teams with the specific problem you described on your site.

Would you be the right person to talk to about this, or is there someone else on the team who handles data infrastructure? A short call would be ideal but I am happy to send details in writing if that is easier.

Best regards, Samir`,
    category: "primary",
    demonstrates: "new_senders",
  },
  {
    id: "demo-new-2",
    sender: "recruiting@bigco.example",
    name: "BigCo Talent",
    at: 4 * DAY,
    subject: "Your background came up",
    body: `
We are hiring for a role that your experience maps onto almost exactly, and I wanted to reach out directly rather than through a portal.

Is this something you would be open to a short conversation about?`,
    category: "primary",
    demonstrates: "new_senders",
  },

  // ── Unread, quiet senders ─────────────────────────────────────────────────
  {
    id: "demo-quiet-1",
    sender: "community@language.example",
    name: "Language Exchange",
    at: 8 * DAY,
    subject: "Your conversation on thursday",
    body: `
Just confirming the time. It is 18:30 rather than 19:00, because of the room booking changing. Same place as last time.

If that no longer works, let me know and we can find another slot.`,
    category: "primary",
    unread: true,
    demonstrates: "quiet_contacts",
  },
  {
    id: "demo-quiet-2",
    sender: "admin@building.example",
    name: "Building Management",
    at: 11 * DAY,
    subject: "Lift maintenance on the 22nd",
    body: `
Lift 2 will be out of service on the 22nd while it is serviced. Lift 1 will be running as normal, and the goods lift is unaffected.

The 22nd is a Wednesday.`,
    category: "updates",
    demonstrates: "quiet_contacts",
  },

  // ── Trash-adjacent: a sender the user binned repeatedly ───────────────────
  {
    id: "demo-binned-1",
    sender: "deals@shop.example",
    name: "Northline",
    at: 3 * DAY + 4 * HOUR,
    subject: "Last chance: 60% off",
    body: `
60% off, last chance, today only. Flash sale. Limited time. Offer ends tonight.

Unsubscribe.`,
    category: "promotions",
  },
  {
    id: "demo-binned-2",
    sender: "marketing@producthunt.example",
    name: "Product Hunt",
    at: 4 * DAY + 6 * HOUR,
    subject: "Today only: 70% off",
    body: `
70% off today only. Flash sale, limited time, ends tonight. Unsubscribe · Manage preferences.

Buy now before the price goes up.`,
    category: "promotions",
  },

  // ── Empty subject: a spam tell ────────────────────────────────────────────
  {
    id: "demo-spam-1",
    sender: "winner@prize.example",
    name: "",
    at: 35 * MINUTE,
    subject: "",
    body: "Click here to claim your prize",
    category: "promotions",
    demonstrates: "unsafe",
  },
  {
    id: "demo-spam-2",
    sender: "no-reply@claims.example",
    name: "",
    at: 6 * DAY + 2 * HOUR,
    subject: "CONGRATULATIONS!!! YOU HAVE WON!!!",
    body: `
CONGRATULATIONS!!! YOU HAVE WON THE UNLIMITED CASH PRIZE!!!

Click here to claim your free money now. Act now — this offer expires soon and we will not be able to contact you again. Earn money from home with no cost to you!

Call now to claim your cash bonus!`,
    category: "promotions",
    demonstrates: "unsafe",
  },
  {
    id: "demo-spam-3",
    sender: "service@account-verify.example",
    name: "Account Services",
    at: 7 * DAY,
    subject: "Your account will be suspended",
    body: `
Your account will be suspended unless you verify your password immediately.

Click here to verify your account: https://account-verify.example/login

Failure to comply within 24 hours will result in permanent closure of your account and all associated data will be removed.`,
    category: "promotions",
    demonstrates: "unsafe",
  },

  // ── Archived and binned fixtures, so those views are not empty ────────────
  {
    id: "demo-archived-1",
    sender: "bookings@airline.example",
    name: "Northern Airways",
    at: 21 * DAY,
    subject: "Your booking reference is QK7T2P",
    body: `
Your booking is confirmed.

Booking reference: QK7T2P Outbound: 3 April, 07:10, London Heathrow Return: 10 April, 18:40, Lisbon

Check-in opens 24 hours before departure. Your seat allocation is in the app.`,
    category: "reservations",
  },
  {
    id: "demo-trash-1",
    sender: "deals@shop.example",
    name: "Northline",
    at: 9 * DAY,
    subject: "MEGA SALE!!!",
    body: "MEGA SALE!!! Buy now, act now, free gift with every order!!!",
    category: "promotions",
  },
  {
    id: "demo-trash-2",
    sender: "deals@shop.example",
    name: "Northline",
    at: 12 * DAY,
    subject: "flash sale",
    body: "Flash sale. Limited time. Free shipping. Today only.",
    category: "promotions",
  },
  {
    id: "demo-trash-3",
    sender: "newsletter@producthunt.example",
    name: "Product Hunt",
    at: 14 * DAY,
    subject: "top products",
    body: "Today's top products. Unsubscribe. Manage preferences.",
    category: "promotions",
  },
  {
    id: "demo-spam-4",
    sender: "no-reply@claims.example",
    name: "",
    at: 13 * DAY,
    subject: "URGENT CLAIM",
    body: "You have won! Claim your prize now. Free money. Act now.",
    category: "promotions",
  },
];

/** Which mailbox a seed lands in, from its id prefix. */
function mailboxForSeed(id: string): Mailbox {
  if (id.startsWith("demo-archived")) return "archive";
  if (id.startsWith("demo-trash")) return "trash";
  if (id.startsWith("demo-spam")) return "spam";
  return "inbox";
}

/** Build one `Email` from a seed. */
function toEmail(seed: Seed): Email {
  return {
    id: hashId(seed.id),
    gmailId: seed.id,
    threadId: seed.threadId,
    sender: seed.sender,
    address: seed.sender,
    name: seed.name || undefined,
    mailbox: mailboxForSeed(seed.id),
    receivedAt: ago(seed.at),
    subject: seed.subject,
    body: seed.body,
    // The demo has no HTML, so the reader renders the text body. That is also
    // the honest default: a real message arrives with both, and the mapper
    // keeps the HTML only when it differs from the text.
    bodyHtml: undefined,
    category: seed.category ?? "primary",
    starred: seed.starred ?? false,
    unread: seed.unread ?? false,
    urgent: seed.urgent ?? false,
    attachments: (seed.attachments ?? []).map((attachment, index) => ({
      id: `${seed.id}-att-${index}`,
      partId: String(index + 1),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      inline: false,
    })),
  };
}

/** Every demo message, newest first. */
export const DEMO_EMAILS: readonly Email[] = seeds
  .map(toEmail)
  .sort((a, b) => b.receivedAt - a.receivedAt);

/**
 * Senders the user has binned, for the trash-bias half of the profile.
 *
 * The demo needs this: without it every sender's bias is zero, the profile
 * cannot tell a habit from a coincidence, and the "Quiet contacts" and
 * engagement ranking have nothing to work with. The counts are chosen so the
 * promos sender is clearly demoted and the personal senders clearly promoted.
 */
export const DEMO_TRASH: readonly TrashRecord[] = [
  { sender: "deals@shop.example" },
  { sender: "deals@shop.example" },
  { sender: "deals@shop.example" },
  { sender: "deals@shop.example" },
  { sender: "deals@shop.example" },
  { sender: "newsletter@producthunt.example" },
  { sender: "newsletter@producthunt.example" },
  { sender: "newsletter@producthunt.example" },
  { sender: "no-reply@claims.example" },
  { sender: "no-reply@claims.example" },
  { sender: "marketing@producthunt.example" },
  { sender: "marketing@producthunt.example" },
];

/**
 * Every bucket the seed is designed to demonstrate, and one message for each.
 *
 * This is the seed's contract with the tests: `demo.test.ts` classifies the
 * whole mailbox and asserts that each of these buckets is non-empty. A seed
 * edit that accidentally stops producing a security alert fails a test rather
 * than quietly shipping a demo with a broken feature.
 */
export const DEMO_EXPECTATIONS: Readonly<Record<string, string>> = Object.fromEntries(
  seeds.filter((seed) => seed.demonstrates).map((seed) => [seed.demonstrates!, seed.id]),
);
