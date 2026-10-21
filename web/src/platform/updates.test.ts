import { describe, expect, it, vi } from "vitest";
import { installUpdateWith } from "./desktop";
import { webPlatform } from "./web";
import type { UpdateOffer } from "../core/updates/updates";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ exit: vi.fn(), onBackButtonPress: vi.fn() }));

const DL = "https://github.com/hxmbl/winnow/releases/download/v1.5.0/";
const base = { version: "1.5.0", current: "1.4.0", pageUrl: "https://github.com/hxmbl/winnow/releases/tag/v1.5.0" };
const deb: UpdateOffer = {
  ...base,
  action: { kind: "deb", asset: { name: "Winnow_1.5.0_amd64.deb", url: `${DL}Winnow_1.5.0_amd64.deb`, size: 1 } },
};
const apk: UpdateOffer = {
  ...base,
  action: {
    kind: "apk",
    asset: { name: "Winnow_1.5.0_android-universal.apk", url: `${DL}Winnow_1.5.0_android-universal.apk`, size: 1 },
  },
};

function recorder(answer: unknown) {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const call = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push([command, args]);
    if (answer instanceof Error) throw answer;
    return answer as T;
  };
  return { calls, call };
}

describe("installing through the shell", () => {
  it("routes each offer to its command", async () => {
    const self = recorder({ kind: "none" });
    expect(await installUpdateWith({ ...base, action: { kind: "self" } }, self.call)).toEqual({ kind: "none" });
    expect(self.calls).toEqual([["update_install", undefined]]);

    const d = recorder({ kind: "opened", path: "/home/a/Downloads/Winnow_1.5.0_amd64.deb" });
    expect(await installUpdateWith(deb, d.call)).toEqual({
      kind: "opened",
      path: "/home/a/Downloads/Winnow_1.5.0_amd64.deb",
    });
    expect(d.calls).toEqual([["update_download_deb", { url: `${DL}Winnow_1.5.0_amd64.deb`, name: "Winnow_1.5.0_amd64.deb" }]]);

    const a = recorder({ kind: "needs-permission" });
    expect(await installUpdateWith(apk, a.call)).toEqual({ kind: "needs-permission" });
    expect(a.calls[0][0]).toBe("update_install_apk");
  });

  it("installs nothing for the page or a git pull", async () => {
    const none = recorder({ kind: "opened" });
    expect(await installUpdateWith({ ...base, action: { kind: "page" } }, none.call)).toEqual({ kind: "none" });
    expect(await installUpdateWith({ ...base, action: { kind: "git-pull" } }, none.call)).toEqual({ kind: "none" });
    expect(none.calls).toEqual([]);
  });

  it("turns a failure or an odd answer into a readable error", async () => {
    await expect(installUpdateWith(deb, recorder(new Error("the download failed: 404")).call)).rejects.toThrow(
      "the download failed: 404",
    );
    await expect(installUpdateWith(deb, recorder({ kind: "exploded" }).call)).rejects.toThrow(/unexpected answer/);
  });
});

describe("the web build", () => {
  it("reports the web channel and has nothing to install", async () => {
    expect((await webPlatform.updateRuntime?.())?.channel).toBe("web");
    expect("installUpdate" in webPlatform).toBe(false);
  });
});
