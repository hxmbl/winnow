/**
 * The demo's second account (1.4.0), so the account switcher has something to switch
 * to without a Google sign-in: a small personal mailbox beside the work one in
 * `demo.ts`. Nothing here is a classifier fixture; `demo.test.ts` does not read it.
 */

import { withCode, type Email } from "../model/email";
import { hashId } from "../model/ids";
import { DEMO_NOW } from "./demo";

export const DEMO_SECOND_ACCOUNT = { email: "alex.moreau@home.example", name: "Alex Moreau" } as const;

/** The two demo accounts, as the switcher lists them. Ids are reserved: never a real account's. */
export const DEMO_ACCOUNT_IDS = { work: "demowork", home: "demohome" } as const;

const HOUR = 3_600_000;

function seed(fields: { id: string; name: string; sender: string; subject: string; body: string; ago: number; unread?: boolean; starred?: boolean }): Email {
  const gmailId = `demo-home-${fields.id}`;
  return withCode({
    id: hashId(gmailId),
    gmailId,
    threadId: `${gmailId}-thread`,
    sender: fields.sender,
    address: fields.sender,
    name: fields.name,
    to: [{ address: DEMO_SECOND_ACCOUNT.email, name: DEMO_SECOND_ACCOUNT.name }],
    cc: [],
    bcc: [],
    mailbox: "inbox",
    receivedAt: DEMO_NOW - fields.ago,
    subject: fields.subject,
    body: fields.body,
    category: "primary",
    starred: fields.starred ?? false,
    unread: fields.unread ?? false,
    urgent: false,
    attachments: [],
  });
}

const SECOND_EMAILS: readonly Email[] = [
  seed({
    id: "climb",
    name: "Priya Shah",
    sender: "priya.shah@climbing.example",
    subject: "Saturday at the wall?",
    body: "Booked the 10am slot for two. Bring the new shoes, they need breaking in.\n\nPriya",
    ago: 1 * HOUR,
    unread: true,
  }),
  seed({
    id: "landlord",
    name: "Harbour Lettings",
    sender: "maintenance@harbour-lettings.example",
    subject: "Boiler service on Thursday between 8 and 12",
    body: "Our engineer will visit on Thursday morning for the annual boiler service. Please make sure someone is home, or reply with a better day.",
    ago: 5 * HOUR,
    unread: true,
  }),
  seed({
    id: "mum",
    name: "Mum",
    sender: "claire.moreau@family.example",
    subject: "Photos from the weekend",
    body: "Here are the ones from the garden. The dog is in all of them, of course.",
    ago: 26 * HOUR,
    starred: true,
  }),
  seed({
    id: "library",
    name: "Central Library",
    sender: "no-reply@library.example",
    subject: "Your reservation is ready to collect",
    body: "The book you reserved, The Overstory, is ready to collect at the front desk for 7 days.",
    ago: 30 * HOUR,
  }),
  seed({
    id: "bank",
    name: "Northbank",
    sender: "statements@northbank.example",
    subject: "Your October statement is ready",
    body: "Your statement for October is ready to view in online banking.",
    ago: 52 * HOUR,
  }),
];

/** The second demo mailbox, shifted onto the real clock like `demoMailbox`. */
export function demoSecondMailbox(now: number = Date.now()): { emails: Email[]; now: number } {
  const shift = Math.max(0, now - DEMO_NOW);
  return {
    emails: SECOND_EMAILS.map((email) => ({ ...email, receivedAt: email.receivedAt + shift })),
    now: DEMO_NOW + shift,
  };
}
