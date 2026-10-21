import { describe, expect, it } from "vitest";
import { mergeRecords } from "./mergeRecords";

type R = { id: string; v: number };
const r = (id: string, v = 0): R => ({ id, v });
const merge = (base: R[], mine: R[], theirs: R[]) =>
  mergeRecords(base, mine, theirs, { keyOf: (x) => x.id })
    .map((x) => `${x.id}${x.v}`)
    .sort();

describe("mergeRecords (two windows writing one list, STRM-290)", () => {
  it("keeps what each side added", () => {
    expect(merge([r("a")], [r("a"), r("mine")], [r("a"), r("theirs")])).toEqual(["a0", "mine0", "theirs0"]);
  });

  it("drops what either side removed", () => {
    expect(merge([r("a"), r("b")], [r("b")], [r("a"), r("b")])).toEqual(["b0"]);
    expect(merge([r("a"), r("b")], [r("a"), r("b")], [r("b")])).toEqual(["b0"]);
  });

  it("takes my change, and theirs for what I did not touch", () => {
    expect(merge([r("a"), r("b")], [r("a", 1), r("b")], [r("a"), r("b", 2)])).toEqual(["a1", "b2"]);
  });

  it("lets a removal win over a change on the other side", () => {
    // They sent or cancelled it while I was marking it: it must not come back.
    expect(merge([r("a")], [r("a", 1)], [])).toEqual([]);
    expect(merge([r("a")], [], [r("a", 2)])).toEqual([]);
  });

  it("is a plain write when nobody else wrote", () => {
    expect(merge([r("a")], [r("a", 3), r("b")], [r("a")])).toEqual(["a3", "b0"]);
    expect(merge([], [], [])).toEqual([]);
  });

  it("compares by the fingerprint given", () => {
    const out = mergeRecords([r("a", 1)], [r("a", 9)], [r("a", 2)], { keyOf: (x) => x.id, fingerprint: (x) => x.id });
    // Same fingerprint as the base: not a change of mine, so theirs stands.
    expect(out).toEqual([r("a", 2)]);
  });
});
