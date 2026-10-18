import { describe, expect, it } from "vitest";
import {
  CONSOLE_LINKS,
  PASTE_STEP,
  SETUP_STEPS,
  clampStep,
  clientTypeFor,
  initialSetupStep,
  LOOPBACK_REDIRECT,
  originOf,
  SETUP_SCOPES,
  stepIndexOf,
  pasteStepOf,
  setupSteps,
} from "./googleSetupSteps";

describe("the Google setup walkthrough", () => {
  it("has the five steps in the console's order", () => {
    expect(SETUP_STEPS.map((step) => step.id)).toEqual(["project", "apis", "consent", "client", "paste"]);
    expect(PASTE_STEP).toBe(4);
  });

  it("links each step to its Cloud Console page", () => {
    expect(CONSOLE_LINKS).toEqual({
      newProject: "https://console.cloud.google.com/projectcreate",
      gmailApi: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
      peopleApi: "https://console.cloud.google.com/apis/library/people.googleapis.com",
      consent: "https://console.cloud.google.com/apis/credentials/consent",
      scopes: "https://console.cloud.google.com/auth/scopes",
      testUsers: "https://console.cloud.google.com/auth/audience",
      newClient: "https://console.cloud.google.com/apis/credentials/oauthclient",
      clients: "https://console.cloud.google.com/auth/clients",
    });
  });

  it("asks the desktop and Android builds for a Desktop app client, the web for a Web one", () => {
    expect(clientTypeFor("desktop")).toBe("Desktop app");
    expect(clientTypeFor("web")).toBe("Web application");
  });

  it("starts at the beginning, or at the paste step when a client is stored", () => {
    expect(initialSetupStep(false)).toBe(0);
    expect(initialSetupStep(true)).toBe(PASTE_STEP);
  });

  it("keeps a step inside the walkthrough", () => {
    expect(clampStep(-1)).toBe(0);
    expect(clampStep(2.7)).toBe(2);
    expect(clampStep(9)).toBe(PASTE_STEP);
    expect(clampStep(Number.NaN)).toBe(0);
  });

  it("gives the origin to register, without the trailing slash", () => {
    expect(originOf("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(originOf("https://mail.example.com/winnow/")).toBe("https://mail.example.com");
    expect(originOf("")).toBe("");
    expect(originOf("not a url")).toBe("");
  });

  it("lists the exact scopes Winnow asks for, Gmail's required and the contacts' optional", () => {
    expect(SETUP_SCOPES.map((item) => [item.scope, item.required])).toEqual([
      ["https://www.googleapis.com/auth/gmail.modify", true],
      ["https://www.googleapis.com/auth/contacts.readonly", false],
      ["https://www.googleapis.com/auth/contacts.other.readonly", false],
    ]);
  });

  it("finds a step's index by id, and shows the loopback the desktop signs in through", () => {
    expect(stepIndexOf("project")).toBe(0);
    expect(stepIndexOf("consent")).toBe(2);
    expect(stepIndexOf("paste")).toBe(PASTE_STEP);
    expect(LOOPBACK_REDIRECT).toBe("http://127.0.0.1");
  });
});

describe("the Android walkthrough", () => {
  const android = setupSteps(true);

  it("adds the optional native sign-in step just before the paste step", () => {
    expect(android.map((step) => step.id)).toEqual(["project", "apis", "consent", "client", "android", "paste"]);
    expect(pasteStepOf(android)).toBe(5);
    expect(setupSteps(false)).toBe(SETUP_STEPS);
  });

  it("opens on, and clamps to, its own paste step", () => {
    expect(initialSetupStep(true, android)).toBe(5);
    expect(initialSetupStep(false, android)).toBe(0);
    expect(clampStep(9, android)).toBe(5);
    expect(clampStep(4, android)).toBe(4);
  });

  it("points a Google error's fix at the step's place in the walkthrough on screen", () => {
    expect(stepIndexOf("paste", android)).toBe(5);
    expect(stepIndexOf("android", android)).toBe(4);
    expect(stepIndexOf("client", android)).toBe(3);
    expect(stepIndexOf("paste")).toBe(4);
  });
});
