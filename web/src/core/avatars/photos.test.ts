import { describe, expect, it } from "vitest";
import { contactPhotoMap, sizedPhotoUrl } from "./photos";
import { applyListing, flattenSnapshot, emptySnapshot, toStoredPerson } from "../contacts/google";

describe("sizedPhotoUrl", () => {
  it("replaces the size option on the newer googleusercontent form", () => {
    expect(sizedPhotoUrl("https://lh3.googleusercontent.com/a/ACg8ocK=s100")).toBe(
      "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c",
    );
    expect(sizedPhotoUrl("https://lh3.googleusercontent.com/a-/AOh14G=s100-p-k-no", 64)).toBe(
      "https://lh3.googleusercontent.com/a-/AOh14G=s64-c",
    );
  });

  it("adds an option to an /a/ URL that has none", () => {
    expect(sizedPhotoUrl("https://lh3.googleusercontent.com/a/ACg8ocK")).toBe(
      "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c",
    );
  });

  it("uses the documented sz parameter on the path form", () => {
    expect(
      sizedPhotoUrl("https://lh3.googleusercontent.com/-T_wVWLlmg7w/AAAAAAAAAAI/AAAAAAAABa8/00gzXvDBYqw/s100/photo.jpg"),
    ).toBe("https://lh3.googleusercontent.com/-T_wVWLlmg7w/AAAAAAAAAAI/AAAAAAAABa8/00gzXvDBYqw/s100/photo.jpg?sz=96");
    expect(sizedPhotoUrl("https://lh3.googleusercontent.com/x/photo.jpg?sz=50")).toBe(
      "https://lh3.googleusercontent.com/x/photo.jpg?sz=96",
    );
  });

  it("leaves other hosts and relative demo paths alone", () => {
    expect(sizedPhotoUrl("https://example.com/a=s100")).toBe("https://example.com/a=s100");
    expect(sizedPhotoUrl("./demo-avatars/dana.svg")).toBe("./demo-avatars/dana.svg");
  });

  it("clamps silly sizes", () => {
    expect(sizedPhotoUrl("https://lh3.googleusercontent.com/a/X=s100", 4000)).toBe(
      "https://lh3.googleusercontent.com/a/X=s512-c",
    );
  });
});

describe("contact photos by address", () => {
  it("skips default placeholders and maps every address of a person, lower-cased", () => {
    const listing = applyListing(
      { people: {} },
      [
        [
          {
            resourceName: "people/c1",
            names: [{ displayName: "Ada" }],
            emailAddresses: [{ value: "Ada@Work.example", metadata: { primary: true } }, { value: "ada@home.example" }],
            photos: [
              { url: "https://lh3.googleusercontent.com/a/placeholder=s100", default: true },
              { url: "https://lh3.googleusercontent.com/a/real=s100", metadata: { primary: true } },
            ],
          },
          {
            resourceName: "people/c2",
            names: [{ displayName: "Bo" }],
            emailAddresses: [{ value: "bo@example.com" }],
            photos: [{ url: "https://lh3.googleusercontent.com/a/bo=s100", default: true }],
          },
        ],
      ],
      "full",
      "token",
    );
    const contacts = flattenSnapshot({ ...emptySnapshot(), saved: listing });
    const map = contactPhotoMap(contacts);
    expect(map.get("ada@work.example")).toBe("https://lh3.googleusercontent.com/a/real=s96-c");
    expect(map.get("ada@home.example")).toBe("https://lh3.googleusercontent.com/a/real=s96-c");
    expect(map.has("bo@example.com")).toBe(false);
  });

  it("prefers the primary non-default photo and falls back to the first real one", () => {
    expect(
      toStoredPerson({
        resourceName: "people/c3",
        emailAddresses: [{ value: "c@example.com" }],
        photos: [
          { url: "https://lh3.googleusercontent.com/a/first" },
          { url: "https://lh3.googleusercontent.com/a/second" },
        ],
      })?.photo,
    ).toBe("https://lh3.googleusercontent.com/a/first");
  });

  it("keeps the first contact's photo for a shared address and ignores contacts without one", () => {
    const map = contactPhotoMap([
      { address: "x@example.com", source: "saved" },
      { address: "X@example.com", source: "other", photo: "https://lh3.googleusercontent.com/a/one" },
      { address: "x@example.com", source: "other", photo: "https://lh3.googleusercontent.com/a/two" },
    ]);
    expect(map.get("x@example.com")).toBe("https://lh3.googleusercontent.com/a/one=s96-c");
  });
});
