/**
 * "Label as…": the user's own Gmail labels, with a checkbox each, for one message or a
 * selection.
 *
 * Gmail's picker, kept to its essentials. A label on every target is checked, on some
 * is mixed (and stays as it is on each message unless clicked), on none is clear. The
 * field at the top filters the list and, when what is typed is not a label yet, offers
 * to make it — checked, since making a label from here means wanting it on these
 * messages. Nothing is sent until Apply, so a slip costs nothing; the change then goes
 * as one call for the whole selection (`messages.batchModify`).
 *
 * The rules (tri-state, what Apply sends, which names Gmail refuses) live in
 * `core/mail/labels`, where they are tested.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Minus, Plus, Tag } from "lucide-react";
import { Sheet, SheetHeader } from "./Overlay";
import {
  filterLabels,
  labelChanges,
  labelCheck,
  labelNameProblem,
  type LabelCheck,
  type UserLabel,
} from "../../core/mail/labels";

export function LabelPicker({
  labels,
  loading,
  targets,
  onCreate,
  onApply,
  onClose,
}: {
  /** The user's labels, sorted. */
  labels: readonly UserLabel[];
  /** The list is still being fetched. */
  loading: boolean;
  /** The messages being labelled, with the labels they carry now. */
  targets: ReadonlyArray<{ labels?: readonly string[] }>;
  /** Make a label; resolves with it, or throws with the reason. */
  onCreate: (name: string) => Promise<UserLabel>;
  onApply: (add: string[], remove: string[]) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  /** Each label's state as the picker opened (a label made since starts clear). */
  const initial = useMemo(() => {
    const map = new Map<string, LabelCheck>();
    for (const label of labels) map.set(label.id, labelCheck(targets, label.id));
    return map;
  }, [labels, targets]);
  /** What the user has clicked to, by id. Absent means unchanged. */
  const [chosen, setChosen] = useState<Map<string, LabelCheck>>(() => new Map());
  const stateOf = (id: string): LabelCheck => chosen.get(id) ?? initial.get(id) ?? "none";

  const after = useMemo(() => {
    const map = new Map(initial);
    for (const [id, state] of chosen) map.set(id, state);
    return map;
  }, [initial, chosen]);
  const changes = labelChanges(initial, after);
  const changed = changes.add.length + changes.remove.length > 0;

  /** A click: clear → checked, checked → clear, mixed → checked (Gmail's order). */
  const toggle = (id: string) => {
    const next: LabelCheck = stateOf(id) === "all" ? "none" : "all";
    setChosen((current) => new Map(current).set(id, next));
  };

  const shown = filterLabels(labels, query);
  const typed = query.trim();
  const exact = labels.some((label) => label.name.toLowerCase() === typed.toLowerCase());
  const problem = typed && !exact ? labelNameProblem(typed, labels) : null;

  useEffect(() => setCreateError(null), [query]);

  const create = async () => {
    if (!typed || exact || problem || creating) return;
    setCreating(true);
    try {
      const label = await onCreate(typed);
      setChosen((current) => new Map(current).set(label.id, "all"));
      setQuery("");
      inputRef.current?.focus();
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Couldn't make that label.");
    } finally {
      setCreating(false);
    }
  };

  const apply = () => {
    if (!changed) return;
    onApply(changes.add, changes.remove);
  };

  const count = targets.length;
  return (
    <Sheet
      label="Label as"
      onClose={onClose}
      initialFocus={inputRef}
      dismissOnBackdrop
      // The surface is the caller's to draw: without these the list sat on the backdrop.
      className="flex w-full max-w-[400px] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift"
    >
      <div data-label-picker="" className="flex max-h-[min(560px,85vh)] flex-col">
        <SheetHeader title={count === 1 ? "Label as" : `Label ${count} messages as`} onClose={onClose} />
        <div className="border-b border-hairline px-5 py-3">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              // Enter makes the typed label when it is new, and applies otherwise.
              if (typed && !exact) void create();
              else apply();
            }}
            aria-label="Find or make a label"
            placeholder="Find or make a label"
            spellCheck={false}
            className="w-full rounded-ctl border border-control-border bg-surface px-3 py-1.5 text-ui text-ink placeholder:text-ink-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </div>

        <div role="group" aria-label="Labels" className="min-h-0 flex-1 overflow-y-auto py-1">
          {loading && labels.length === 0 && <p className="px-5 py-3 text-ui text-ink-muted">Loading your labels…</p>}
          {!loading && labels.length === 0 && !typed && (
            <p className="px-5 py-3 text-ui text-ink-muted">You have no labels yet. Type a name above to make one.</p>
          )}
          {shown.map((label) => {
            const state = stateOf(label.id);
            return (
              <button
                key={label.id}
                type="button"
                role="checkbox"
                aria-checked={state === "all" ? "true" : state === "some" ? "mixed" : "false"}
                data-label-option={label.id}
                onClick={() => toggle(label.id)}
                className="flex w-full items-center gap-3 px-5 py-2 text-left text-ui text-ink-body transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none"
              >
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-ctl border ${
                    state === "none" ? "border-control-border" : "border-accent bg-accent text-on-accent"
                  }`}
                >
                  {state === "all" && <Check size={12} strokeWidth={3} />}
                  {state === "some" && <Minus size={12} strokeWidth={3} />}
                </span>
                <Tag size={14} strokeWidth={2} aria-hidden="true" className="shrink-0 text-ink-icon" />
                <span className="min-w-0 truncate">{label.name}</span>
              </button>
            );
          })}
          {typed && !exact && (
            <div className="px-5 py-2">
              <button
                type="button"
                data-label-create=""
                disabled={problem !== null || creating}
                onClick={() => void create()}
                className="flex w-full items-center gap-3 rounded-ctl py-1 text-left text-ui font-medium text-ink-body transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Plus size={14} strokeWidth={2.2} aria-hidden="true" className="shrink-0 text-ink-icon" />
                <span className="min-w-0 truncate">{creating ? `Making “${typed}”…` : `Make “${typed}”`}</span>
              </button>
              {(problem ?? createError) && (
                <p role="alert" data-label-problem="" className="mt-1 pl-[26px] text-meta text-danger">
                  {problem ?? createError}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-ctl border border-control-border px-4 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            data-label-apply=""
            disabled={!changed}
            onClick={apply}
            className="rounded-ctl bg-accent px-4 py-1.5 text-ui font-semibold text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </div>
    </Sheet>
  );
}
