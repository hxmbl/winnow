import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "../../core/store/store";
import { EMPTY_SELECTION, pruneSelection, type Selection } from "../../ui/selection";

/** Ephemeral row selection, kept in step with the mailbox currently on screen. */
export function useSelection(snapshot: Pick<Snapshot, "mailbox" | "view">) {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const rowOrder = useMemo(
    () => snapshot.view.threads.map((row) => row.representative.id),
    [snapshot.view.threads],
  );

  useEffect(() => {
    setSelection((current) => pruneSelection(current, rowOrder));
  }, [rowOrder]);

  useEffect(() => {
    setSelection(EMPTY_SELECTION);
  }, [snapshot.mailbox]);

  return { selection, setSelection, selectionRef, rowOrder };
}
