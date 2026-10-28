/**
 * The update button beside the version shortcut, in the phone's top bar and the
 * desktop's floating bar (`updateButton.ts` has the rules). Nothing on the web build.
 */

import { useEffect, useRef, useState } from "react";
import type { UpdatesController } from "../useUpdates";
import {
  NOTICE_MS,
  UPDATE_BUTTON_LABEL,
  noticeAfterCheck,
  updateButtonPress,
  updateButtonShown,
  updateButtonView,
  type UpdateNotice,
} from "../updateButton";

export function UpdateButton({ updates, phone }: { updates: UpdatesController | null | undefined; phone: boolean }) {
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  /** A check this button started, until it settles. */
  const awaiting = useRef(false);
  const status = updates?.status ?? "idle";
  const hasOffer = Boolean(updates?.offer);

  useEffect(() => {
    if (!awaiting.current || status === "checking") return;
    awaiting.current = false;
    setNotice(noticeAfterCheck(status, hasOffer));
  }, [status, hasOffer]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!updates || !updateButtonShown(updates.runtime)) return null;
  const view = updateButtonView(status, hasOffer, notice);
  const press = updateButtonPress(view);

  return (
    <button
      type="button"
      data-update-shortcut={view}
      aria-live="polite"
      disabled={press === null}
      onClick={() => {
        if (press === "check") {
          setNotice(null);
          awaiting.current = true;
          updates.checkNow();
        } else if (press === "install") {
          updates.install();
        }
      }}
      className={`shrink-0 whitespace-nowrap rounded-ctl font-semibold transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-70 ${
        phone ? "mr-1 h-9 px-3.5 text-meta" : "h-7 px-3 text-meta"
      } ${view === "update" ? "bg-accent text-on-accent" : "bg-sheen text-ink-body hover:text-ink"}`}
    >
      {UPDATE_BUTTON_LABEL[view]}
    </button>
  );
}
