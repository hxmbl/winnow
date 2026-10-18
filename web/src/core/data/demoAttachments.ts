/**
 * The demo mailbox's attachment bytes, so its files open, preview and save like real
 * ones with no account: a one-page PDF and a small PNG, generated for the demo. Keyed by
 * filename, which is unique across the seed.
 */

import { base64ToBytes } from "../mail/attachments";

const FILES: Record<string, { mimeType: string; base64: string }> = {
  "annual-return-2025.pdf": {
    mimeType: "application/pdf",
    base64:
      "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5" +
      "cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVu" +
      "dCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAv" +
      "RjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAxNTEgPj4Kc3RyZWFtCkJUIC9GMSAxOCBUZiA3" +
      "MiA3MjAgVGQgKEFubnVhbCByZXR1cm4gMjAyNSAtIE5vcnRod2luZCBBbmFseXRpY3MgTHRkKSBUaiBFVApCVCAvRjEgMTIg" +
      "VGYgNzIgNjkwIFRkIChSZWNlaXZlZCBhbmQgYWNjZXB0ZWQuIERlbW8gY29weSBmb3IgV2lubm93LikgVGogRVQKZW5kc3Ry" +
      "ZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+" +
      "PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAw" +
      "MDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDA0NDMgMDAwMDAgbiAKdHJhaWxl" +
      "cgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo1MTMKJSVFT0YK",
  },
  "filing-receipt.png": {
    mimeType: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAKAAAADcAgMAAACKQUIEAAAACVBMVEX6+PKWlqAmRnhD+5H/AAAAj0lEQVR42u2ZSwqAIAAF" +
      "n1H3a9kZ00VH6D4dQcg2FrYJP9BCZtZvI4yDoFmVxyCGDBkyZPjPEOAHjKRp/loEx+WCYnuOnTRDY3uiR9gDmfa8s0N7oK49" +
      "j0fYA2X2xAcz9kD9u8diD+TakxaH9kBLe/yGPVBhzy0O9kCZPcEl39Dn0pk9oyRvOzkM1xVAknQBK5YaI8Oj8qsAAAAASUVO" +
      "RK5CYII=",
  },
};

/** Bytes of a demo attachment, or `null` for a name the demo has no file for. */
export function demoAttachment(filename: string): { bytes: Uint8Array; mimeType: string } | null {
  const file = FILES[filename];
  return file ? { bytes: base64ToBytes(file.base64), mimeType: file.mimeType } : null;
}
