import { useMemo } from "react";
import type { Mailbox } from "../../core/model/email";
import type { Snapshot, WinnowStore } from "../../core/store/store";
import { MAILBOX_LABEL } from "../../core/model/email";
import { MAILBOX_ORDER } from "../../ui/mailboxNav";
import { buildPills } from "../../ui/rail";

type Options = {
  snapshot: Snapshot;
  store: WinnowStore;
};

/** Values derived from the open snapshot for navigation, the filter rail, and the list. */
export function useDerivedView({ snapshot, store }: Options) {
  const { view } = snapshot;

  // Keep the rail's faceted counts and ordering aligned with the open mailbox.
  const pills = useMemo(
    () =>
      buildPills(
        view.rail,
        view.railCounts,
        view.profile.topSenders,
        view.railSenderCounts,
        snapshot.activeFilters,
        view.railFacets,
      ),
    [view.rail, view.railCounts, view.profile.topSenders, view.railSenderCounts, snapshot.activeFilters, view.railFacets],
  );

  const emptyContext = useMemo(
    () => ({ mailbox: snapshot.mailbox, filters: snapshot.activeFilters }),
    [snapshot.mailbox, snapshot.activeFilters],
  );

  const unreadIds = useMemo(
    () => new Set(view.emails.filter((email) => email.unread).map((email) => email.id)),
    [view.emails],
  );

  const mailboxes = useMemo(
    () =>
      MAILBOX_ORDER.map((id) => ({
        id,
        label: MAILBOX_LABEL[id],
        // Snoozed and Scheduled count their contents, not unread messages.
        unread:
          id === "snoozed"
            ? snapshot.snoozes.snoozed.filter((record) => record.account === store.accountKey()).length
            : id === "scheduled"
              ? snapshot.scheduled.filter((send) => send.account === store.accountKey()).length
              : snapshot.all.filter((email) => email.mailbox === id && email.unread).length,
      })),
    [snapshot.all, snapshot.snoozes, snapshot.scheduled, store],
  );

  const paletteUnread = useMemo(
    () => Object.fromEntries(mailboxes.map((mailbox) => [mailbox.id, mailbox.unread])) as Partial<Record<Mailbox, number>>,
    [mailboxes],
  );

  return { pills, emptyContext, unreadIds, mailboxes, paletteUnread };
}
