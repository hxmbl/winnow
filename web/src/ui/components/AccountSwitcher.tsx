/**
 * The account switcher (1.4.0): the sheet the avatar in the phone top bar and the
 * desktop sidebar header opens. Each signed-in account with its avatar, address,
 * unread count and colour ring, the open one ticked; one tap switches. Then Add account,
 * with the Testing-mode note, the demo inbox, and Manage accounts, which opens the
 * Accounts page (`AccountsPage.tsx`).
 *
 * The decisions are in `ui/accounts.ts`; this only lays them out.
 */

import { useRef } from "react";
import { Check, FlaskConical, Plus, Settings } from "lucide-react";
import { Sheet, SheetHeader } from "./Overlay";
import { Avatar } from "./Avatar";
import type { AccountSummary } from "../../core/store/store";
import { ADD_ACCOUNT_HELP, ACCOUNTS_FULL, accountColorHex, unreadLabel } from "../accounts";
import { MAX_ACCOUNTS } from "../../core/session/accounts";
import { accountStatusLine } from "../accountsPage";
import type { ThemeName } from "../theme";
import { Icon } from "./Icon";

export type AccountSwitcherProps = {
  accounts: readonly AccountSummary[];
  scheme: ThemeName;
  /** The open account's unread inbox, which the store knows better than the light sync. */
  activeUnread: number;
  /** An account is being added or opened: the rows wait. */
  busy: boolean;
  error: string | null;
  phone: boolean;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  /**
   * Look around the demo mailbox while signed in. The session stays on the device, so
   * the demo's "Back to your inbox" returns without a new sign-in. Absent in the demo.
   */
  onOpenDemo?: () => void;
  onManage: () => void;
  onClose: () => void;
};

/**
 * The account's colour as a thin ring around its avatar (it was a dot badge until 1.6.3,
 * and the open account also had a soft halo until the UI refinement pass): the ring tells
 * accounts apart. Colour is never the only cue: the open account's row carries
 * `aria-current` and a tick, and the trigger's label names the account. Under forced
 * colours the browser drops the shadow, and those cues remain. `data-account-glow-active`
 * still marks the open account for tests and styling.
 *
 * Place it inside the `relative` wrapper that holds the avatar; it covers the avatar exactly.
 */
export function AccountGlow({ color, scheme, active }: { color: string; scheme: ThemeName; active: boolean }) {
  const hex = accountColorHex(color, scheme);
  const ring = `0 0 0 1.5px ${hex}`;
  return (
    <span
      aria-hidden="true"
      data-account-glow={color}
      data-account-glow-active={active ? "" : undefined}
      className="pointer-events-none absolute inset-0 rounded-full"
      style={{ boxShadow: ring }}
    />
  );
}

export function AccountSwitcher(props: AccountSwitcherProps) {
  const first = useRef<HTMLButtonElement>(null);
  const demo = props.accounts.some((account) => account.demo);
  const full = !demo && props.accounts.length >= MAX_ACCOUNTS;
  return (
    <Sheet
      label="Accounts"
      onClose={props.onClose}
      initialFocus={first}
      placement={props.phone ? "bottom" : "center"}
      // A solid panel like every other sheet: without its own surface the chips and the
      // dock showed straight through it on a phone.
      className="flex max-h-(--wn-sheet-max-h) w-full max-w-sheet-sm flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift"
    >
      <div data-account-switcher="" className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        <SheetHeader title="Accounts" onClose={props.onClose} touch={props.phone} />
        <ul className="flex flex-col gap-0.5 p-2" aria-label="Signed-in accounts">
          {props.accounts.map((account, index) => {
            const count = account.active ? props.activeUnread : account.unread;
            const label = unreadLabel(count);
            const status = accountStatusLine(account, props.activeUnread);
            return (
              <li key={account.id}>
                <button
                  ref={index === 0 ? first : undefined}
                  type="button"
                  data-account-row={account.id}
                  data-account-email={account.email}
                  aria-current={account.active ? "true" : undefined}
                  disabled={props.busy && !account.active}
                  onClick={() => (account.active ? props.onClose() : props.onSwitch(account.id))}
                  className={`flex w-full items-center gap-3 rounded-ctl px-2.5 text-left transition-colors hover:bg-surface-hover disabled:opacity-60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
                    props.phone ? "min-h-14 py-2" : "min-h-12 py-1.5"
                  } ${account.active ? "bg-surface-selected" : ""}`}
                >
                  <span className="relative shrink-0">
                    <Avatar lookup={false} name={account.email} address={account.email} photo={account.picture} />
                    <AccountGlow color={account.color} scheme={props.scheme} active={account.active} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium text-ink">{account.email || "Your account"}</span>
                    <span className="block truncate text-meta text-ink-subtle">{status}</span>
                  </span>
                  {label && !account.active && (
                    <span data-account-unread="" className="shrink-0 rounded-full bg-surface-active px-2 text-meta font-semibold text-ink">
                      {label}
                    </span>
                  )}
                  {account.active && <Icon icon={Check} size={20} className="shrink-0 text-accent" />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-hairline-soft p-2">
          <button
            type="button"
            data-account-add=""
            disabled={props.busy || full}
            onClick={props.onAdd}
            className={`flex w-full items-center gap-3 rounded-ctl px-2.5 text-left text-ui font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
              props.phone ? "min-h-12" : "min-h-10"
            }`}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-hairline">
              <Icon icon={Plus} size={16} />
            </span>
            {props.busy ? "Waiting for Google…" : demo ? "Connect Gmail" : "Add account"}
          </button>
          <p className="px-2.5 pb-1 pt-1.5 text-meta text-ink-subtle">{full ? ACCOUNTS_FULL : ADD_ACCOUNT_HELP}</p>
          {props.error && (
            <p role="alert" className="selectable px-2.5 pb-1 text-meta text-danger">
              {props.error}
            </p>
          )}
          {!demo && props.onOpenDemo && (
            <button
              type="button"
              data-account-demo=""
              disabled={props.busy}
              onClick={props.onOpenDemo}
              className="mt-1 flex min-h-10 w-full items-center gap-3 rounded-ctl px-2.5 text-left text-ui text-ink-body transition-colors hover:bg-surface-hover disabled:opacity-60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              <Icon icon={FlaskConical} size={16} className="ml-1.5 mr-1.5 shrink-0" />
              Open demo inbox
            </button>
          )}
          <button
            type="button"
            data-account-manage=""
            onClick={props.onManage}
            className="mt-1 flex min-h-10 w-full items-center gap-3 rounded-ctl px-2.5 text-left text-ui text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <Icon icon={Settings} size={16} className="ml-1.5 mr-1.5 shrink-0" />
            Manage accounts
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** The avatar that opens the switcher: the open account's, ringed in its colour. */
export function AccountButton({
  accounts,
  scheme,
  onOpen,
  glass = false,
  label,
}: {
  accounts: readonly AccountSummary[];
  scheme: ThemeName;
  onOpen: () => void;
  glass?: boolean;
  label: string;
}) {
  const active = accounts.find((account) => account.active);
  const others = accounts.filter((account) => !account.active && (account.unread ?? 0) > 0).length;
  return (
    <button
      type="button"
      data-account-switcher-trigger=""
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      onClick={onOpen}
      className={`pointer-events-auto relative flex h-11 w-11 shrink-0 items-center justify-center rounded-ctl focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${glass ? "wn-glass" : "hover:bg-surface-hover"}`}
    >
      <span className="relative flex rounded-full">
        <Avatar lookup={false} name={active?.email ?? "You"} address={active?.email ?? "you@winnow.demo"} photo={active?.picture} />
        {active && <AccountGlow color={active.color} scheme={scheme} active />}
      </span>
      {others > 0 && (
        <span data-account-others="" aria-hidden="true" className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-accent" />
      )}
    </button>
  );
}
