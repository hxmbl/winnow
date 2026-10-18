/**
 * The user's labels by id, for the chips on rows and in the reader, handed down through
 * context so the list's memoised rows need no new prop. `hidden` is the label being
 * browsed as a mailbox: every row there carries it, so it is not repeated as a chip.
 */

import { createContext, useContext } from "react";

export type LabelNames = { names: ReadonlyMap<string, string>; hidden: string | null };

const EMPTY: LabelNames = { names: new Map(), hidden: null };

export const LabelNamesContext = createContext<LabelNames>(EMPTY);

export function useLabelNames(): LabelNames {
  return useContext(LabelNamesContext);
}
