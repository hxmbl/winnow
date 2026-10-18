/**
 * An attachment's bytes, from wherever this session has them: Gmail for a connected
 * account, the seeded files for the demo (`core/data/demoAttachments`), and otherwise a
 * sentence saying why not — a button that appears to do nothing is the failure to avoid.
 */

import { demoAttachment } from "../core/data/demoAttachments";
import type { Email } from "../core/model/email";

export type AttachmentFetcher = {
  fetchAttachment(gmailId: string, attachmentId: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
};

export async function attachmentBytes(
  email: Pick<Email, "gmailId" | "attachments">,
  index: number,
  /** The session, when an account is connected; `null` in the demo. */
  fetcher: AttachmentFetcher | null,
): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }> {
  const attachment = email.attachments[index];
  if (!attachment) throw new Error("That attachment is no longer on the message.");
  if (fetcher) {
    const fetched = await fetcher.fetchAttachment(email.gmailId, attachment.id);
    return { ...fetched, filename: attachment.filename || fetched.filename };
  }
  const demo = demoAttachment(attachment.filename);
  if (demo) return { bytes: demo.bytes, filename: attachment.filename, mimeType: demo.mimeType };
  throw new Error("Signing in to Gmail is required to download attachments.");
}
