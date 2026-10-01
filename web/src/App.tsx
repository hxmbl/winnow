import { useEffect, useMemo, useState } from "react";
import TopBar, { type PillItem } from "./components/TopBar";
import EmailList from "./components/EmailList";
import ReaderPane from "./components/ReaderPane";
import {
  buildUserProfile,
  classifyEmail,
  filterAndSortInbox,
  matchesSmartFilter,
  rankFilters,
  senderFilter,
  type EmailSignals,
  type FilterId,
} from "./inbox/smart";
import { FILTER_PILLS, senderPillColors } from "./inbox/palette";
import { primeAvatarColors } from "./inbox/avatarColor";
import { MOCK_INBOX, MOCK_NOW_MS, MOCK_TRASH } from "./mock/mail";
import type { RelayEmail, TrashRow } from "./inbox/types";

export default function App() {
  const [inbox] = useState<RelayEmail[]>(MOCK_INBOX);
  const [trash] = useState<TrashRow[]>(MOCK_TRASH);
  const [activeFilters, setActiveFilters] = useState<FilterId[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // No-ops while `PROFILE_PICTURES` is empty; warms sender pill colours if it
  // ever gets populated. Deliberately not in a dep array — it must run once.
  useEffect(() => {
    primeAvatarColors();
  }, []);

  const profile = useMemo(() => buildUserProfile(inbox, trash), [inbox, trash]);

  const emailSignals = useMemo(() => {
    const map = new Map<number, EmailSignals>();
    for (const email of inbox) {
      map.set(email.id, classifyEmail(email, profile));
    }
    return map;
  }, [inbox, profile]);

  const filteredEmails = useMemo(
    () =>
      filterAndSortInbox(
        inbox,
        trash,
        activeFilters,
        searchQuery,
        "date",
        profile,
        emailSignals,
      ),
    [activeFilters, searchQuery, inbox, trash, profile, emailSignals],
  );

  const rankedFilters = useMemo(
    () => rankFilters(inbox, trash, profile, emailSignals),
    [inbox, trash, profile, emailSignals],
  );

  const senderShortcuts = useMemo(
    () => profile.topSenders.slice(0, 3),
    [profile],
  );

  const compatibleFilters = useMemo(() => {
    if (activeFilters.length === 0) return rankedFilters;
    return rankedFilters.filter(({ id }) =>
      filteredEmails.some((email) => {
        const sig = emailSignals.get(email.id);
        return sig ? matchesSmartFilter(id, email, sig, profile) : false;
      }),
    );
  }, [rankedFilters, filteredEmails, activeFilters, profile, emailSignals]);

  const compatibleSenders = useMemo(() => {
    if (activeFilters.length === 0) return senderShortcuts;
    return senderShortcuts.filter((s) =>
      filteredEmails.some((e) => e.sender === s),
    );
  }, [senderShortcuts, filteredEmails, activeFilters]);

  const pills: PillItem[] = useMemo(() => {
    const builtin: PillItem[] = compatibleFilters.map(({ id, label }) => ({
      id,
      label,
      colors: FILTER_PILLS[id],
    }));
    const senders: PillItem[] = compatibleSenders.map((sender) => ({
      id: senderFilter(sender),
      label: `From ${sender}`,
      colors: senderPillColors(sender),
    }));
    return [...builtin, ...senders];
  }, [compatibleFilters, compatibleSenders]);

  const selectedIndex =
    selectedId == null
      ? -1
      : filteredEmails.findIndex((e) => e.id === selectedId);
  const selected = selectedIndex >= 0 ? filteredEmails[selectedIndex] : null;

  function toggleFilter(id: FilterId) {
    setActiveFilters((prev) => {
      if (prev.includes(id)) return prev.filter((f) => f !== id);
      if (id === "unsafe") return [id];
      return [...prev, id];
    });
  }

  function clearFilters() {
    setActiveFilters([]);
  }

  function goPrev() {
    const total = filteredEmails.length;
    if (total === 0) return;
    if (selectedIndex < 0) setSelectedId(filteredEmails[total - 1].id);
    else if (selectedIndex > 0)
      setSelectedId(filteredEmails[selectedIndex - 1].id);
  }

  function goNext() {
    const total = filteredEmails.length;
    if (total === 0) return;
    if (selectedIndex < 0) setSelectedId(filteredEmails[0].id);
    else if (selectedIndex < total - 1)
      setSelectedId(filteredEmails[selectedIndex + 1].id);
  }

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      <TopBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        pills={pills}
        activeFilters={activeFilters}
        onToggle={toggleFilter}
        onClear={clearFilters}
        position={selectedIndex >= 0 ? selectedIndex + 1 : 0}
        total={filteredEmails.length}
        onPrev={goPrev}
        onNext={goNext}
      />

      {/*
        The gutter is the point of this layout. Panes sit apart on a tinted
        canvas rather than sharing one seamless sheet, so each reads as its own
        object — and so that anything later lifted off a neighbour has a visible
        edge and something behind it to blur.

        Small screens keep the original full-bleed behaviour: the reader covers
        the list outright there, so there is nothing underneath to be above.
      */}
      <main className="flex min-h-0 flex-1 lg:gap-3 lg:p-3">
        <EmailList
          emails={filteredEmails}
          selectedId={selectedId}
          onSelect={setSelectedId}
          now={MOCK_NOW_MS}
          className="lg:rounded-pane lg:shadow-pane lg:min-w-0"
        />

        {/*
          Keyed on the message so the pane remounts per selection. That buys two
          things from one key: the reader restarts at the top of the new message,
          and `animate-appear` re-fires on every change instead of only on load —
          motion that means "this content is new" rather than "here is a page".
        */}
        <ReaderPane
          key={selected?.id ?? "empty"}
          email={selected}
          onBack={() => setSelectedId(null)}
          profile={profile}
          className={`${selected ? "flex" : "hidden"} fixed inset-0 z-40 lg:static lg:z-auto lg:flex lg:w-[37.9%] lg:shrink-0 lg:rounded-pane lg:shadow-pane ${selected ? "animate-appear" : ""}`}
        />
      </main>
    </div>
  );
}
