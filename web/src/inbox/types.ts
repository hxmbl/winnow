/** One inbox thread row — matches mock seed shape */
export type RelayEmail = {
  id: number;
  sender: string;
  name?: string;
  email?: string;
  /** Unix ms — source of truth for sort order */
  receivedAt: number;
  subject: string;
  body: string;
  type: string;
  starred: boolean;
  urgent: boolean;
};

/** Trash/recycle — only sender matters for frequency bias (nothing deleted from inbox here). */
export type TrashRow = {
  sender: string;
};
