/**
 * The composer's To field: chips, and a combobox of people from the mail in the store.
 *
 * The pattern is the ARIA 1.2 editable combobox with list autocomplete, and three of its
 * decisions are the ones that are usually got wrong:
 *
 *   - **Nothing is highlighted until the user moves.** Selecting the first row on focus
 *     means the next character replaces it, and Enter sends a suggestion nobody chose. So
 *     `active` starts at -1 and only a deliberate arrow key sets it.
 *   - **Tab only accepts once the user has navigated.** Tab is how keyboard focus leaves
 *     a field (WCAG 2.1.1), and swallowing it to accept a suggestion makes the rest of the
 *     composer unreachable. With no arrow key pressed, Tab moves focus as it always does.
 *   - **Escape is consumed only while the list is open.** One Escape closes the list and
 *     leaves the composer open with the draft intact; the next closes the composer, which
 *     still goes through the discard confirmation in `App.tsx`. The event is stopped from
 *     propagating so neither the sheet's own Escape handler nor the app's keybind router
 *     sees it — two handlers closing two things for one keypress is how a sheet closes the
 *     reader *and* itself.
 *
 * The list is drawn over the composer rather than beside it because there is no room
 * beside it at 390px, and it is capped at `MAX_SUGGESTIONS` so it cannot outgrow the
 * scroll port it sits in.
 */

import { useCallback, useId, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  chipLabel,
  isAlreadyOnMessage,
  suggestContacts,
} from "../../core/contacts/suggest";
import { isValidAddress, parseRecipients } from "../../core/contacts/addresses";
import type { ContactIndex } from "../../core/contacts/index";
import { Icon } from "./Icon";

export type RecipientFieldProps = {
  /** The addresses on the message. A bare address is what the draft carries. */
  recipients: readonly string[];
  onChange: (recipients: string[]) => void;
  /** Everyone the mail in the store knows about, or `null` while there is none. */
  contacts: ContactIndex | null;
  /** Where focus goes when the composer opens on a forward. */
  inputRef: React.RefObject<HTMLInputElement | null>;
  id: string;
  /** The field's name, on its label and its combobox: "To", "Cc" or "Bcc". */
  label?: string;
  /**
   * The text typed but not yet a chip, when the parent needs it.
   *
   * Controlled from the composer so Send can count — and send to — an address that was
   * typed and never committed with a comma or Enter. Without it, typing an address and
   * pressing ⌘⏎ left Send refusing a message that visibly had a recipient.
   */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Something at the right end of the label row, such as the composer's "Cc/Bcc". */
  trailing?: React.ReactNode;
};

/** Chip height, and the touch target inside it. 28px clears WCAG 2.5.8's 24px floor. */
const CHIP_BUTTON = "h-7 w-7";

export function RecipientField({
  recipients,
  onChange,
  contacts,
  inputRef,
  id,
  label = "To",
  query: controlledQuery,
  onQueryChange,
  trailing,
}: RecipientFieldProps) {
  const [ownQuery, setOwnQuery] = useState("");
  const query = controlledQuery ?? ownQuery;
  const setQuery = useCallback(
    (next: string) => {
      setOwnQuery(next);
      onQueryChange?.(next);
    },
    [onQueryChange],
  );
  const [focused, setFocused] = useState(false);
  /** Set by Escape so the list stays down until the query changes. */
  const [dismissed, setDismissed] = useState(false);
  /** The highlighted row, or -1 for "none". See the note on auto-selecting above. */
  const [active, setActive] = useState(-1);

  const listboxId = useId();
  const errorId = `${id}-error`;
  const invalid = recipients.filter((address) => !isValidAddress(address));

  const suggestions = useMemo(
    () => suggestContacts(contacts, query, { exclude: recipients }),
    [contacts, query, recipients],
  );

  const open = focused && !dismissed && suggestions.length > 0;
  const activeId = open && active >= 0 && active < suggestions.length
    ? `${listboxId}-${active}`
    : undefined;

  /**
   * Turn text into chips.
   *
   * A token already on the message is skipped rather than duplicated, and a token that is
   * not an address is kept — see `parseRecipients`.
   */
  const commit = useCallback(
    (text: string) => {
      const tokens = parseRecipients(text);
      setQuery("");
      if (tokens.length === 0) return;
      const next = [...recipients];
      for (const token of tokens) {
        if (isAlreadyOnMessage(token.value, next)) continue;
        next.push(token.value);
      }
      if (next.length !== recipients.length) onChange(next);
    },
    [recipients, onChange, setQuery],
  );

  const removeAt = useCallback(
    (index: number) => {
      const next = recipients.filter((_, i) => i !== index);
      onChange(next);
      // Focus belongs to the input, so removing a chip from the mouse leaves the keyboard
      // where it was rather than on a button that has just been removed from the DOM.
      inputRef.current?.focus();
    },
    [recipients, onChange, inputRef],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // A comma or semicolon commits what has been typed, and never reaches the field:
      // a trailing separator is a keystroke of *finishing*, not of text.
      if (event.key === "," || event.key === ";") {
        event.preventDefault();
        commit(query);
        return;
      }

      if (event.key === "Backspace" && query === "" && recipients.length > 0) {
        event.preventDefault();
        removeAt(recipients.length - 1);
        return;
      }

      // Enter finishes a typed address, unless it is picking a highlighted suggestion.
      // ⌘⏎ is left alone: it is the composer's Send, which takes typed text with it.
      if (
        event.key === "Enter" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !(open && active >= 0) &&
        query.trim() !== ""
      ) {
        event.preventDefault();
        commit(query);
        return;
      }

      if (event.key === "Escape") {
        // Only while there is something to dismiss. Otherwise the event is left alone so
        // the sheet and the keybind router each close the composer, once, as they did.
        if (!open) return;
        event.preventDefault();
        event.stopPropagation();
        setDismissed(true);
        setActive(-1);
        return;
      }

      if (!open) {
        // Reopening on a keystroke after an Escape, so the list comes back the moment
        // the user is clearly looking for something again.
        if (event.key.length === 1 && dismissed) setDismissed(false);
        return;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setActive((current) => (current + 1) % suggestions.length);
          return;
        case "ArrowUp":
          event.preventDefault();
          setActive((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
          return;
        case "Home":
          event.preventDefault();
          setActive(0);
          return;
        case "End":
          event.preventDefault();
          setActive(suggestions.length - 1);
          return;
        case "Enter":
          if (active < 0) return;
          event.preventDefault();
          commit(suggestions[active].address);
          setActive(-1);
          return;
        case "Tab":
          // The exception, and the reason it is conditional: accepting a suggestion the
          // user never highlighted would be a guess, and trapping Tab would make the rest
          // of the composer unreachable by keyboard.
          if (active < 0) return;
          event.preventDefault();
          commit(suggestions[active].address);
          setActive(-1);
          return;
        default:
      }
    },
    [active, commit, dismissed, open, query, recipients, removeAt, suggestions],
  );

  return (
    <div className="flex items-start gap-2 text-meta">
      <label htmlFor={id} className="w-(--wn-composer-label) shrink-0 pt-1.5 text-ink-subtle">
        {label}
      </label>

      <div className="relative min-w-0 flex-1">
        <div
          // The border lives on the wrapper because the chips are inside it, so the field
          // is one box. `focus-within` rather than `focus-visible` on the input: the focus
          // ring should follow the field the user is in, not the last thing they clicked.
          className={`flex min-h-9 flex-wrap items-center gap-1.5 rounded-field border bg-surface px-2.5 py-1 transition-colors ${
            invalid.length > 0 ? "border-(--wn-danger)" : "border-hairline"
          } focus-within:border-accent`}
        >
          {recipients.map((address, position) => {
            const label = chipLabel(address, contacts);
            const bad = !isValidAddress(address);
            return (
              <span
                key={`${address}-${position}`}
                // `invalid` rather than colour alone: a chip that cannot be delivered to
                // has to say so to somebody who cannot see that it is red.
                aria-invalid={bad || undefined}
                className={`inline-flex max-w-full items-center gap-0.5 rounded-ctl border py-0.5 pl-2.5 pr-0.5 text-meta ${
                  bad
                    ? "border-(--wn-danger) text-(--wn-danger)"
                    : "border-hairline bg-surface-sunken text-ink-body"
                }`}
              >
                <span className="min-w-0 truncate">{label}</span>
                <button
                  type="button"
                  // Named by what it does to this chip, not "remove": in a list of eight,
                  // "Remove" alone says which of the eight only by position.
                  aria-label={`Remove ${label}`}
                  onClick={() => removeAt(position)}
                  className={`flex ${CHIP_BUTTON} shrink-0 items-center justify-center rounded-ctl text-current opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring`}
                >
                  <Icon icon={X} size={12} />
                </button>
              </span>
            );
          })}

          <input
            ref={inputRef}
            id={id}
            type="text"
            role="combobox"
            aria-label={label}
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={activeId}
            aria-invalid={invalid.length > 0 || undefined}
            aria-describedby={invalid.length > 0 ? errorId : undefined}
            autoComplete="off"
            spellCheck={false}
            // Short enough for a 360px phone; `text-ellipsis` ends it cleanly if it is ever cut.
            placeholder={recipients.length === 0 ? "name@example.com" : ""}
            value={query}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              // Leaving the field finishes what was typed, as every mail client does: an
              // address typed and tabbed away from is a recipient, not a half-thought.
              if (query.trim() !== "") commit(query);
            }}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(-1);
              // Typing after an Escape means the user is looking for something again.
              if (dismissed) setDismissed(false);
            }}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (pasted === "") return;
              event.preventDefault();
              // Committed together with what was already typed: pasting an address into a
              // half-written one and losing the half would be its own small betrayal.
              commit(`${query}${pasted}`);
            }}
            // `min-w-28` so the field does not collapse to nothing once chips fill the
            // row, and `grow` so there is always somewhere to type.
            className="min-w-28 flex-1 text-ellipsis border-0 bg-transparent px-1 py-0.5 text-ui text-ink outline-hidden placeholder:text-ink-placeholder max-sm:text-read"
          />
        </div>

        {/*
          The list. `absolute` rather than in the flow, so eight rows do not push the
          subject field and the whole composer down as each keystroke changes the list —
          and `max-h` so it cannot outgrow the sheet's scroll port on a short window.
        */}
        {open && (
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Suggested recipients"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[min(15rem,38vh)] thin-scroll overflow-y-auto rounded-pane border border-hairline bg-surface p-1 shadow-lift"
          >
            {suggestions.map((suggestion, position) => (
              <li
                key={suggestion.address}
                id={`${listboxId}-${position}`}
                role="option"
                aria-selected={position === active}
                // `onMouseDown` with `preventDefault`, not `onClick`: a mousedown that is
                // not prevented blurs the input first, which closes the list, so the click
                // lands on nothing.
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(suggestion.address);
                  inputRef.current?.focus();
                }}
                onMouseEnter={() => setActive(position)}
                // The name has priority: the address gives way first (desktop), and on a
                // phone the address goes under the name rather than squeezing it to a
                // few letters beside a full address.
                className={`flex cursor-pointer items-baseline gap-2 rounded-ctl px-3 py-2 max-sm:flex-col max-sm:items-stretch max-sm:gap-0 max-sm:px-4 ${
                  position === active ? "bg-surface-active" : ""
                }`}
              >
                <span
                  data-suggestion-name=""
                  className="min-w-0 max-w-[60%] shrink-0 truncate text-ui text-ink-body max-sm:max-w-full"
                >
                  {suggestion.name ?? suggestion.address}
                </span>
                {suggestion.name && (
                  <span data-suggestion-address="" className="min-w-0 flex-1 truncate text-meta text-ink-subtle">
                    {suggestion.address}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {/*
          Said in words as well as colour. A Send button that is disabled with no
          explanation is a small puzzle, and the person who cannot work out why has to
          guess which of their recipients is wrong.

          Quoted rather than bare, because the chip's own label is arbitrary text — the
          whole point of keeping an undeliverable entry is that it is whatever the user
          typed, so it cannot be spliced into a sentence without sounding like a claim.
        */}
        {invalid.length > 0 && (
          <p id={errorId} className="mt-1.5 text-meta font-medium text-danger">
            {invalid.length === 1
              ? `“${chipLabel(invalid[0], contacts)}” is not an email address.`
              : `${invalid.length} of the recipients are not email addresses.`}
          </p>
        )}
      </div>
      {trailing}
    </div>
  );
}