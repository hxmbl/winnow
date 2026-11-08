/** HTML bodies and background body downloads, coordinated through WinnowStore. */
import { TaskCancelled, type Priority } from "../../gmail/pool";
import { demoRawSource } from "../../mail/rawSource";
import { isBodyLoaded, withLoadedBody, type Email, type LoadedBody } from "../../model/email";
import { PREFETCH_NEIGHBOURS, PREFETCH_UNREAD_TOP_N } from "../state";
import type { WinnowStore } from "../store";

const BODY_APPLY_DELAY_MS = 400;

  export function loadBody(store: WinnowStore, id: number, priority: Priority = "high"): Promise<void> {
    const existing = store.bodyInFlight.get(id);
    if (existing) return existing;
    if (store.bodyChecked.has(id)) {
      if (priority === "high") prefetchAround(store, id);
      return Promise.resolve();
    }

    const backend = store.backend;
    const email = store.state.all.find((candidate) => candidate.id === id);
    if (!backend || !email) return Promise.resolve();

    // A metadata-only row needs its whole body, not just its HTML: the plain text is a
    // snippet stand-in and the attachment list is empty until it lands.
    const whole = !isBodyLoaded(email) && backend.loadMessage !== undefined;

    store.bodyFailed.delete(id);
    const request = (async () => {
      try {
        if (whole) {
          const loaded = await store.bodyQueue.push(() => backend.loadMessage!(email.gmailId), priority);
          // Signed out (or switched account) while it was on the wire: not ours to keep.
          if (store.backend !== backend) return;
          store.bodyChecked.add(id);
          if (loaded.bodyHtml !== undefined) store.bodies.set(id, loaded.bodyHtml);
          applyLoadedBody(store, id, loaded, priority === "high");
        } else {
          const bodyHtml = await store.bodyQueue.push(() => backend.fetchBody(email.gmailId), priority);
          if (store.backend !== backend) return;
          store.bodyChecked.add(id);
          if (bodyHtml !== undefined) store.bodies.set(id, bodyHtml);
        }
      } catch (error) {
        // A dropped prefetch (sign-out, demo) is not a failure of anything.
        if (error instanceof TaskCancelled) return;
        // A body that will not load is not a sync failure or an error banner: the message
        // still opens, showing the plain text it has. Left out of `bodyChecked` so opening
        // it again can retry. Remembered as failed so the reader stops promising a
        // formatted version that is not coming.
        store.bodyFailed.add(id);
        store.notify();
        return;
      } finally {
        store.bodyInFlight.delete(id);
      }
      store.notify();
    })();

    store.bodyInFlight.set(id, request);
    if (priority === "high") prefetchAround(store, id);
    return request;
  }

  /**
   * Put a loaded body into `state.all`.
   *
   * Unlike the HTML side-map this does change `all` — the plain text is what the
   * classifier and search read, so a body that stayed out of `all` would leave the
   * message classified on its snippet forever. The opened message is applied at once
   * (the reader is waiting on it); background bodies are gathered for
   * `BODY_APPLY_DELAY_MS` and applied together, so a prefetch burst costs one
   * reclassification rather than one per message.
   */
  function applyLoadedBody(store: WinnowStore, id: number, loaded: LoadedBody, now: boolean): void {
    store.pendingBodies.set(id, loaded);
    if (now) {
      flushLoadedBodies(store);
      return;
    }
    if (store.bodyApplyTimer !== null) return;
    store.bodyApplyTimer = setTimeout(() => {
      store.bodyApplyTimer = null;
      flushLoadedBodies(store);
    }, BODY_APPLY_DELAY_MS);
  }

  function flushLoadedBodies(store: WinnowStore): void {
    if (store.bodyApplyTimer !== null) {
      clearTimeout(store.bodyApplyTimer);
      store.bodyApplyTimer = null;
    }
    if (store.pendingBodies.size === 0) return;
    const pending = store.pendingBodies;
    store.pendingBodies = new Map();
    let changed = false;
    const all = store.state.all.map((email) => {
      const loaded = pending.get(email.id);
      if (!loaded) return email;
      changed = true;
      // `bodyHtml` stays in the side-map; see `partitionBodies`.
      return { ...withLoadedBody(email, loaded), bodyHtml: undefined };
    });
    if (changed) store.set({ all });
  }

  /**
   * Queue background body loads, lowest priority, for messages that need one.
   *
   * Anything already loaded, settled, in flight or failed this session is skipped, so
   * calling this freely (after every sync, on every open) costs nothing extra.
   */
  export function prefetchBodies(store: WinnowStore, ids: readonly number[]): void {
    if (!store.backend?.loadMessage) return;
    const byId = new Map(store.state.all.map((email) => [email.id, email]));
    for (const id of ids) {
      const email = byId.get(id);
      if (!email || isBodyLoaded(email)) continue;
      if (store.bodyChecked.has(id) || store.bodyInFlight.has(id) || store.bodyFailed.has(id)) continue;
      void loadBody(store, id, "low");
    }
  }

  /** Forget queued body work: the account it was for is gone. */
  export function dropBodyWork(store: WinnowStore): void {
    store.stopOffline();
    store.bodyQueue.clear();
    store.pendingBodies.clear();
    if (store.bodyApplyTimer !== null) clearTimeout(store.bodyApplyTimer);
    store.bodyApplyTimer = null;
  }

  /** After a sync: unread mail among the newest `PREFETCH_UNREAD_TOP_N` in the inbox. */
  /** @internal Starts low-priority body downloads after sync. */
  export function prefetchInbox(store: WinnowStore): void {
    const top = store.state.all
      .filter((email) => email.mailbox === "inbox")
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, PREFETCH_UNREAD_TOP_N)
      .filter((email) => email.unread);
    store.prefetchBodies(top.map((email) => email.id));
  }

  /**
   * After an open: the rows either side in the list, and the rest of the conversation —
   * the next things `j`/`k` or a click in the reader will want.
   */
  function prefetchAround(store: WinnowStore, id: number): void {
    if (!store.backend?.loadMessage) return;
    const view = store.view;
    const rows = view.threads.map((row) => row.representative.id);
    const at = rows.indexOf(id);
    const ids: number[] = [];
    if (at >= 0) {
      for (let step = 1; step <= PREFETCH_NEIGHBOURS; step += 1) {
        if (rows[at + step] !== undefined) ids.push(rows[at + step]);
        if (rows[at - step] !== undefined) ids.push(rows[at - step]);
      }
    }
    const opened = store.state.all.find((email) => email.id === id);
    if (opened?.threadId) {
      for (const email of store.state.all) {
        if (email.threadId === opened.threadId && email.id !== id) ids.push(email.id);
      }
    }
    store.prefetchBodies(ids);
  }

  /**
   * True once a body has been fetched, or found not to exist. Drives the reader's wait.
   *
   * "Loaded" also covers every case where no fetch is coming: no backend (the demo
   * mailbox, whose messages carry their HTML already, or a signed-out store), a message
   * that already holds its HTML, and a fetch that failed. Each of those used to leave
   * "Loading the formatted version…" on screen forever.
   */
  /**
   * Dev Options → View Original: a message's raw source, from the backend's
   * `format=raw`, or built from the message where there is no server (the demo).
   * Rejects when the request fails; the caller says so.
   */
  export async function loadRawSource(store: WinnowStore, id: number): Promise<{ raw: string; demo: boolean }> {
    const email = store.state.all.find((candidate) => candidate.id === id);
    if (!email) throw new Error("No such message");
    const backend = store.backend;
    if (backend?.fetchRaw) return { raw: await backend.fetchRaw(email.gmailId), demo: false };
    return { raw: demoRawSource({ ...email, bodyHtml: store.bodies.get(id) ?? email.bodyHtml }), demo: true };
  }

  export function hasLoadedBody(store: WinnowStore, id: number): boolean {
    if (store.bodyChecked.has(id)) return true;
    if (!store.backend) return true;
    if (store.bodyInFlight.has(id)) return false;
    if (store.bodyFailed.has(id)) return true;
    const email = store.state.all.find((candidate) => candidate.id === id);
    return email?.bodyHtml !== undefined;
  }

  /** The body-bearing copy of a message, for the parts of the view that render one. */
  /** @internal */
  export function withBody(store: WinnowStore, email: Email): Email {
    const bodyHtml = store.bodies.get(email.id);
    return bodyHtml === undefined ? email : { ...email, bodyHtml };
  }
