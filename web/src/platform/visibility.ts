/**
 * Wait for the page to be visible again.
 *
 * On Android, Winnow's WebView sits paused behind the browser while the user is at
 * Google, and a request made from it then fails before reaching the network. The
 * sign-in waits here, after the code arrives and before it is exchanged, until the
 * user is back in the app — or `timeoutMs` passes, so a WebView that never reports
 * "visible" (or a platform with no `document`) still gets its attempt.
 *
 * Resolves `true` when the page is visible, `false` on timeout.
 */

type VisibilityDocument = {
  visibilityState?: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

export type VisibilityEnv = {
  document?: VisibilityDocument;
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

/** Long enough to switch back from the browser by hand; short enough not to hang. */
export const FOREGROUND_WAIT_MS = 15_000;

function defaultEnv(): VisibilityEnv {
  return {
    document: globalThis.document as VisibilityDocument | undefined,
    setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function waitUntilVisible(
  timeoutMs = FOREGROUND_WAIT_MS,
  env: VisibilityEnv = defaultEnv(),
): Promise<boolean> {
  const doc = env.document;
  // No document, or one that does not report visibility: nothing to wait for.
  if (!doc || typeof doc.visibilityState !== "string") return Promise.resolve(true);
  if (doc.visibilityState === "visible") return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const finish = (visible: boolean) => {
      doc.removeEventListener("visibilitychange", onChange);
      env.clearTimeout(timer);
      resolve(visible);
    };
    const onChange = () => {
      if (doc.visibilityState === "visible") finish(true);
    };
    doc.addEventListener("visibilitychange", onChange);
    const timer = env.setTimeout(() => finish(false), timeoutMs);
  });
}
