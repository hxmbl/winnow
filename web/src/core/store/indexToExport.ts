/**
 * Export the EmailNicknames utilities for use across the app.
 *
 * This file exists to provide clean imports like:
 * ```ts
 * import { getNickname, setNickname } from "core/store/emailNicknames";
 * ```
 *
 * Instead of:
 * ```ts
 * import * as EmailNicknames from "./emailNicknames";
 * const { getNickname, setNickname } = EmailNicknames;
 * ```
 */

export {
  foldText,
  getEmailNicknames,
  getNickname,
  loadEmailNicknames,
  normalizeAddress,
  persistEmailNicknames,
  setNickname,
  setNicknameForAddress,
} from "./emailNicknames";

export type { EmailNicknames } from "./emailNicknames";