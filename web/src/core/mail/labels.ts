/**
 * Gmail user labels: the "Label as…" picker's rules.
 *
 * Winnow files mail into mailboxes (Inbox, Archive, Spam, Trash), which are Gmail's
 * system labels under other names. *User* labels — the ones the user made — are
 * separate, many per message, and are what "Label as…" edits. System labels are never
 * offered here: Move to and the archive/trash verbs own those.
 *
 * Pure, so the tri-state and the add/remove arithmetic are tested without a picker.
 */

/** One of the user's own Gmail labels. `name` may contain `/` for nesting. */
export type UserLabel = {
  /** Gmail's id: `Label_12`. */
  id: string;
  name: string;
};

/**
 * Whether a label id is a user label. Gmail gives every user label an id of the form
 * `Label_<n>`; system labels (INBOX, UNREAD, CATEGORY_*, IMPORTANT…) are their own
 * uppercase names. `labels.list` says so too (`type: "user"`), but a message's
 * `labelIds` carries ids alone, so this is how a message's labels are read.
 */
export function isUserLabelId(id: string): boolean {
  return /^Label_\d+$/.test(id);
}

/** The user labels among a message's `labelIds`, in Gmail's order. */
export function userLabelIds(labelIds: readonly string[]): string[] {
  return labelIds.filter(isUserLabelId);
}

/** Whether a label is on every target, some, or none: the checkbox's three states. */
export type LabelCheck = "all" | "some" | "none";

export function labelCheck(targets: ReadonlyArray<{ labels?: readonly string[] }>, labelId: string): LabelCheck {
  if (targets.length === 0) return "none";
  const on = targets.filter((target) => target.labels?.includes(labelId)).length;
  if (on === 0) return "none";
  return on === targets.length ? "all" : "some";
}

/**
 * What to ask Gmail for: labels that ended up checked are added, ones that ended up
 * clear are removed, and a label left mixed (`some`, untouched) is left exactly as it
 * is on each message. A label whose state did not change is not sent at all.
 */
export function labelChanges(
  before: ReadonlyMap<string, LabelCheck>,
  after: ReadonlyMap<string, LabelCheck>,
): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const [id, state] of after) {
    const was = before.get(id) ?? "none";
    if (state === was || state === "some") continue;
    if (state === "all") add.push(id);
    else remove.push(id);
  }
  return { add, remove };
}

/** A message's user labels after the change: removes first, then adds, no duplicates. */
export function applyLabelChange(
  labels: readonly string[] | undefined,
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const kept = (labels ?? []).filter((id) => !remove.includes(id));
  for (const id of add) if (!kept.includes(id)) kept.push(id);
  return kept;
}

/** Gmail's own system label names, which a user label cannot take (case-insensitive). */
const RESERVED = [
  "inbox",
  "spam",
  "trash",
  "unread",
  "starred",
  "important",
  "sent",
  "draft",
  "drafts",
  "chat",
  "chats",
  "all mail",
  "snoozed",
  "scheduled",
  "outbox",
];

/** Gmail's limit on a label's name, in characters. */
export const MAX_LABEL_NAME = 225;

/**
 * Whether `name` can be a new label: a reason it cannot, or `null` when it can. Checked
 * here so the picker says why in place, rather than after Gmail answers 400.
 */
export function labelNameProblem(name: string, existing: readonly UserLabel[]): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Type a name for the label.";
  if (trimmed.length > MAX_LABEL_NAME) return `Label names can be up to ${MAX_LABEL_NAME} characters.`;
  if (RESERVED.includes(trimmed.toLowerCase())) return `“${trimmed}” is one of Gmail's own labels.`;
  if (trimmed.split("/").some((part) => part.trim() === "")) return "A nested label needs a name on each side of “/”.";
  if (existing.some((label) => label.name.toLowerCase() === trimmed.toLowerCase())) {
    return `There is already a label called “${trimmed}”.`;
  }
  return null;
}

/** Labels in the order a picker lists them: by name, nested ones beside their parent. */
export function sortLabels(labels: readonly UserLabel[]): UserLabel[] {
  return [...labels].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** The labels whose name contains `query` (case-insensitive), all of them for "". */
export function filterLabels(labels: readonly UserLabel[], query: string): UserLabel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...labels];
  return labels.filter((label) => label.name.toLowerCase().includes(q));
}
