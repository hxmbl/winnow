/**
 * The phone menu panel's Settings gear sits in the dock's Expand column (1.4.0): the
 * account row is the pill's own grid (three equal cells inside `px-1.5`), the account
 * spanning two cells and the gear centred in the third, and the panel shares the
 * pill's left edge, width and 1px border. The smokes measure it to the pixel
 * (`smoke.mjs`, `smoke-thumb.mjs` for both hands); this holds the recipe in step.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nav = readFileSync(new URL("./components/MailNav.tsx", import.meta.url), "utf8");
const dock = readFileSync(new URL("./components/PhoneChrome.tsx", import.meta.url), "utf8");

describe("the phone panel's Settings gear, over the Expand chevron", () => {
  it("the dock pill is a three-cell grid inside px-1.5, Expand the last cell", () => {
    expect(dock).toMatch(/data-phone-pill=""[\s\S]*?grid h-\(--wn-dock-h\) min-w-0 flex-1 grid-cols-3 items-stretch rounded-ctl px-1\.5/);
  });

  it("the touch account row is the same grid, the account two cells, the gear centred in the third", () => {
    expect(nav).toContain('"relative grid shrink-0 grid-cols-3 items-center px-1.5 pb-3 pt-3"');
    expect(nav).toMatch(/col-span-2 ml-1\.5 min-h-12/);
    expect(nav).toMatch(/h-12 w-12 justify-self-center rounded-ctl/);
  });

  it("the gear keeps its name and a 48px round target", () => {
    expect(nav).toMatch(/aria-label="Settings"[\s\S]{0,500}h-12 w-12/);
  });
});
