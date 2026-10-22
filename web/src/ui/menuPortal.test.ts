import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * STRM-317: the account menu opened from the phone's menu panel landed a panel's offset
 * down and was clipped at the panel's bottom-left, under the dock, with "Syncing…" over
 * "Switch account…". The panel is a containing block for fixed boxes (its glass
 * `backdrop-filter`, its slide `transform`) and clips with `overflow: hidden`, so a
 * `position: fixed` menu inside it is neither placed in viewport coordinates nor fully
 * painted. The root menu therefore renders into the body. The geometry is checked in the
 * browser by smoke-thumb's "phone panel: the account switcher is reachable while syncing".
 */
const menu = readFileSync(new URL("./components/Menu.tsx", import.meta.url), "utf8");
const nav = readFileSync(new URL("./components/MailNav.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

describe("Menu renders outside the panel that opened it", () => {
  it("portals the root menu into document.body", () => {
    expect(menu).toMatch(/import \{ createPortal \} from "react-dom"/);
    expect(menu).toMatch(/isRoot[^\n]*\? createPortal\(menu, document\.body\) : menu/);
  });

  it("lends the portalled menu back to a modal dialog it was opened from", () => {
    expect(menu).toMatch(/closest\?\.\('\[aria-modal="true"\]'\)/);
    expect(menu).toMatch(/setAttribute\("aria-owns"/);
  });

  it("the sidebar's idle close still sees its account menu once it lives in the body", () => {
    expect(nav).not.toMatch(/panel\.querySelector\('\[role="menu"\]'\)/);
    expect(nav).toMatch(/menuOpen: document\.querySelector\("\[data-menu-root\]"\) !== null/);
  });

  it("the phone panel is still a fixed-box containing block that clips (why the portal is needed)", () => {
    // If the panel ever stops being one, the portal is still right, but this records why.
    expect(css).toMatch(/\.wn-sidebar-panel\[data-morph\] \{[^}]*clip-path:/);
    expect(nav).toMatch(/wn-sidebar-panel fixed z-50 flex flex-col overflow-hidden/);
  });
});
