import { useEffect, useRef, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import type { WinnowStore } from "../../core/store/store";
import { desktopPlatformExtras } from "../../platform";
import { POPOVER_SELECTOR, backTarget, isSheetElement } from "../../ui/backLayers";
import type { ComposerState, OpenMenu } from "../types";

type Options = {
  android: boolean;
  hasWork: boolean;
  storeRef: MutableRefObject<WinnowStore>;
  composerRef: MutableRefObject<ComposerState | null>;
  phoneRef: MutableRefObject<boolean>;
  menuOpen: boolean;
  sidebarOpen: boolean;
  retireComposer: (current: ComposerState, how: "park" | "discard") => void;
  setMenu: Dispatch<SetStateAction<OpenMenu | null>>;
  setComposer: Dispatch<SetStateAction<ComposerState | null>>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
};

/** Close the topmost app layer on Android Back, registering only while a layer is open. */
export function useAndroidBack({
  android,
  hasWork,
  storeRef,
  composerRef,
  phoneRef,
  menuOpen,
  sidebarOpen,
  retireComposer,
  setMenu,
  setComposer,
  setSidebarOpen,
}: Options): void {
  const backRef = useRef<() => void>(() => {});
  backRef.current = () => {
    const store = storeRef.current;
    const snapshot = store.getSnapshot();
    const popover = document.querySelector(POPOVER_SELECTOR);
    const sheets = [...document.querySelectorAll('[aria-modal="true"]')].filter(isSheetElement);
    const sheet = sheets[sheets.length - 1] ?? null;
    const state = {
      popover: menuOpen || popover !== null,
      sheet: sheet !== null,
      composer: composerRef.current !== null,
      sidebar: sidebarOpen,
      settings: snapshot.overlay === "settings",
      message: snapshot.selectedId !== null,
    };

    // Let each popover or sheet run the Escape handler it already owns.
    const escapeIn = (element: Element) => {
      const active = document.activeElement;
      const target = active && element.contains(active) ? active : element;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    };

    switch (backTarget(state)) {
      case "popover":
        if (menuOpen) setMenu(null);
        else if (popover) escapeIn(popover);
        return;
      case "sheet":
        if (sheet) escapeIn(sheet);
        return;
      case "composer": {
        const current = composerRef.current;
        if (!current || current.sending) return;
        // Back keeps the draft; it never discards or asks about it.
        retireComposer(current, "park");
        composerRef.current = null;
        setComposer(null);
        return;
      }
      case "sidebar":
        setSidebarOpen(false);
        return;
      case "settings": {
        // On a phone, step back from a category before closing Settings entirely.
        const back = document.querySelector<HTMLButtonElement>(
          '[data-settings-page="category"] button[aria-label="Back to Settings"]',
        );
        if (back) back.click();
        else store.setOverlay("none");
        return;
      }
      case "message":
        store.closeReader({ dropCursor: phoneRef.current });
        return;
      case "exit":
        void desktopPlatformExtras.exitApp();
    }
  };

  useEffect(() => {
    if (!android || !hasWork) return;
    return desktopPlatformExtras.onBackButton(() => backRef.current());
  }, [android, hasWork]);
}
