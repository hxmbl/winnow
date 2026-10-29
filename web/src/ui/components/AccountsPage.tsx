/**
 * The Accounts page (1.5): every signed-in account, and one page per account with what
 * can be done to it (switch, colour, notifications while it is not open, sign out). Then
 * Add account, the demo inbox, Sign out of all, and the Google client every account
 * signs in with. The switcher's "Manage accounts" opens it, and so does Settings →
 * Google account → Accounts.
 *
 * On a phone it is a full-screen sheet with touch-sized rows, behind the floating dock
 * like Settings; on a larger screen a centred panel. The rules are in `../accountsPage.ts`
 * and the words and colours shared with the switcher in `../accounts.ts`; sign-in,
 * sign-out and revocation are App's, unchanged.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ArrowLeft, ArrowLeftRight, Check, ChevronLeft, ChevronRight, FlaskConical, KeyRound, LogOut, Plus, Settings as SettingsIcon } from "lucide-react";
import { Sheet } from "./Overlay";
import { Avatar } from "./Avatar";
import { AccountGlow } from "./AccountSwitcher";
import { SettingBlock, SettingLabel, Toggle } from "./SettingsControls";
import { SettingsExplain } from "../settingsExplainContext";
import { INFO_CLOSED, infoReducer } from "../settingsView";
import type { AccountSummary } from "../../core/store/store";
import { ACCOUNT_COLORS, type AccountColor } from "../../core/session/accounts";
import { ACCOUNT_COLOR_LABEL, accountColorHex, unreadLabel } from "../accounts";
import {
  ACCOUNTS_LIST,
  accountDetail,
  accountStatusLine,
  accountsBack,
  accountsPageModel,
  resolveView,
  type AccountsView,
} from "../accountsPage";
import type { ThemeName } from "../theme";
import { Icon } from "./Icon";

export type AccountsPageProps = {
  accounts: readonly AccountSummary[];
  scheme: ThemeName;
  /** The open account's unread inbox, which the store knows better than the light sync. */
  activeUnread: number;
  /** An account is being added, opened or signed out: the controls wait. */
  busy: boolean;
  error: string | null;
  phone: boolean;
  /** The Google client every account signs in with, shortened, or `null` before setup. */
  googleClient: string | null;
  signedIn: boolean;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  /** Look around the demo mailbox while signed in (the switcher's, since 1.4.0). Absent in the demo. */
  onOpenDemo?: () => void;
  /** Asked first on a phone; revokes and erases that account (App's `confirmSignOutAccount`). */
  onSignOut: (id: string) => void;
  onSignOutAll: () => void;
  onColor: (id: string, color: AccountColor) => void;
  onNotify: (id: string, notify: boolean) => void;
  /** Set up, change or remove the Google client (the Google account sheet). */
  onGoogleClient: () => void;
  /** Settings → Google account, for contacts and the rest of the client's settings. */
  onGoogleSettings: () => void;
  onClose: () => void;
};

/**
 * How far the phone page's scroller pads its end: past the floating dock plus a little
 * air, as Settings does, so the last row scrolls clear of the pill.
 */
const PHONE_END = "calc(var(--wn-phone-tabs, env(safe-area-inset-bottom, 0px)) + 1rem)";

const FOCUS = "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring";

export function AccountsPage(props: AccountsPageProps) {
  const [asked, setView] = useState<AccountsView>(ACCOUNTS_LIST);
  const view = resolveView(asked, props.accounts);
  const [info, dispatchInfo] = useReducer(infoReducer, INFO_CLOSED);
  const explain = useMemo(
    () => ({ mode: "popover" as const, point: () => {}, pointed: null, info, dispatchInfo }),
    [info],
  );
  const model = accountsPageModel(props.accounts, { busy: props.busy, canOpenDemo: Boolean(props.onOpenDemo) });
  const selected = view.screen === "detail" ? props.accounts.find((account) => account.id === view.id) ?? null : null;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>());
  /** Where focus goes after a screen change: the new heading going in, the account's row coming back. */
  const focusNext = useRef<{ kind: "heading" } | { kind: "row"; id: string } | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (!next) return;
    if (next.kind === "heading") headingRef.current?.focus();
    else (rowRefs.current.get(next.id) ?? headingRef.current)?.focus();
  }, [view.screen, selected?.id]);

  const open = (id: string) => {
    dispatchInfo({ type: "outside" });
    focusNext.current = { kind: "heading" };
    setView({ screen: "detail", id });
  };
  const back = () => {
    const next = accountsBack(view);
    dispatchInfo({ type: "outside" });
    if (next === "close") {
      props.onClose();
      return;
    }
    if (view.screen === "detail") focusNext.current = { kind: "row", id: view.id };
    setView(next);
  };

  const title = selected ? selected.email || "Your account" : "Accounts";
  const header = (
    <div
      className={`flex shrink-0 items-center gap-1 border-b border-hairline ${
        props.phone ? "px-2 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]" : "px-3 py-2.5"
      }`}
    >
      {(selected || props.phone) && (
        <button
          type="button"
          data-accounts-back=""
          aria-label={selected ? "Back to Accounts" : "Close Accounts"}
          onClick={back}
          className={`flex shrink-0 items-center justify-center rounded-ctl text-ink transition-colors hover:bg-surface-hover active:bg-surface-hover ${FOCUS} ${
            props.phone ? "h-11 w-9" : "h-8 w-8"
          }`}
        >
          {props.phone ? <Icon icon={ChevronLeft} size={20} /> : <Icon icon={ArrowLeft} size={16} />}
        </button>
      )}
      <h2
        ref={headingRef}
        tabIndex={-1}
        data-accounts-title=""
        className={`min-w-0 flex-1 truncate font-semibold text-ink outline-hidden ${props.phone ? "text-read" : "px-2 text-read"} ${selected && !props.phone ? "px-1!" : ""}`}
      >
        {title}
      </h2>
      {!props.phone && (
        <button
          type="button"
          data-accounts-close=""
          onClick={props.onClose}
          aria-label="Close Accounts"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover ${FOCUS}`}
        >
          <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </div>
  );

  const body = selected ? (
    <AccountDetailScreen account={selected} props={props} />
  ) : (
    <AccountsListScreen props={props} model={model} rowRefs={rowRefs} onOpen={open} />
  );

  return (
    <SettingsExplain.Provider value={explain}>
      <Sheet
        label="Accounts"
        onClose={props.onClose}
        onEscape={back}
        placement={props.phone ? "fill" : "center"}
        dismissOnBackdrop={!props.phone}
        initialFocus={headingRef}
        backdrop={props.phone ? "opaque" : "scrim"}
        className={
          props.phone
            ? "flex h-full w-full flex-col overscroll-none bg-chrome"
            : "flex max-h-(--wn-sheet-max-h) w-full max-w-sheet-md flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift"
        }
      >
        <div
          data-accounts-page={view.screen}
          data-accounts-layout={props.phone ? "phone" : "desktop"}
          className="flex min-h-0 flex-1 flex-col"
        >
          {header}
          <div
            key={view.screen === "detail" ? `detail-${view.id}` : "list"}
            data-accounts-body=""
            className={`thin-scroll min-h-0 flex-1 animate-appear overflow-y-auto overscroll-contain ${props.phone ? "px-3 pt-2" : "px-2 py-2"}`}
            style={props.phone ? { paddingBottom: PHONE_END } : undefined}
          >
            {body}
          </div>
        </div>
      </Sheet>
    </SettingsExplain.Provider>
  );
}

/** A row of the page that does one thing: an icon, its words, and (optionally) a line under them. */
function ActionRow({
  icon,
  label,
  hint,
  onClick,
  disabled,
  danger = false,
  phone,
  data,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  phone: boolean;
  data: Record<string, string>;
}) {
  return (
    <button
      type="button"
      {...data}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-ctl px-2.5 text-left transition-colors hover:bg-surface-hover active:bg-surface-hover disabled:opacity-50 ${FOCUS} ${
        phone ? "min-h-12 py-2" : "min-h-10 py-1.5"
      } ${danger ? "text-danger hover:bg-danger-wash" : "text-ink-body"}`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-ui font-medium ${danger ? "text-danger" : "text-ink"}`}>{label}</span>
        {hint && <span className="block text-meta text-ink-subtle wrap-anywhere">{hint}</span>}
      </span>
    </button>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="px-2.5 pb-1 pt-3 text-meta font-semibold text-ink-subtle first:pt-1">{children}</h3>;
}

function AccountsListScreen({
  props,
  model,
  rowRefs,
  onOpen,
}: {
  props: AccountsPageProps;
  model: ReturnType<typeof accountsPageModel>;
  rowRefs: React.RefObject<Map<string, HTMLButtonElement | null>>;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      <SectionTitle>{model.demo ? "Demo accounts" : "Signed in on this device"}</SectionTitle>
      {props.accounts.length === 0 ? (
        <p data-accounts-empty="" className="px-2.5 py-2 text-ui text-ink-muted">
          No Gmail account is signed in yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5" aria-label={model.demo ? "Demo accounts" : "Signed-in accounts"}>
          {props.accounts.map((account) => {
            const count = account.active ? props.activeUnread : account.unread;
            const label = unreadLabel(count);
            const status = accountStatusLine(account, props.activeUnread);
            return (
              <li key={account.id}>
                <button
                  ref={(element) => {
                    rowRefs.current.set(account.id, element);
                  }}
                  type="button"
                  data-accounts-row={account.id}
                  data-account-email={account.email}
                  aria-current={account.active ? "true" : undefined}
                  aria-label={`${account.email || "Your account"}, ${status}. Manage`}
                  onClick={() => onOpen(account.id)}
                  className={`flex w-full items-center gap-3 rounded-ctl px-2.5 text-left transition-colors hover:bg-surface-hover active:bg-surface-hover ${FOCUS} ${
                    props.phone ? "min-h-16 py-2" : "min-h-12 py-1.5"
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
                    <span data-account-unread="" aria-hidden="true" className="shrink-0 rounded-full bg-surface-active px-2 text-meta font-semibold text-ink">
                      {label}
                    </span>
                  )}
                  {account.active && <Icon icon={Check} size={20} className="shrink-0 text-accent" />}
                  <Icon icon={ChevronRight} size={20} className="shrink-0 text-ink-subtle" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 border-t border-hairline-soft pt-2">
        <ActionRow
          phone={props.phone}
          data={{ "data-accounts-add": "" }}
          icon={
            <span className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline">
              <Icon icon={Plus} size={16} />
            </span>
          }
          label={model.addLabel}
          disabled={model.addDisabled}
          onClick={props.onAdd}
        />
        <p data-accounts-add-help="" className="px-2.5 pb-1 pt-1 text-meta text-ink-subtle">
          {model.addHelp}
        </p>
        {props.error && (
          <p role="alert" className="selectable px-2.5 pb-1 text-meta text-danger">
            {props.error}
          </p>
        )}
        {model.openDemo && props.onOpenDemo && (
          <ActionRow
            phone={props.phone}
            data={{ "data-accounts-demo": "" }}
            icon={<Icon icon={FlaskConical} size={16} />}
            label="Open demo inbox"
            hint="Your accounts stay signed in."
            disabled={props.busy}
            onClick={props.onOpenDemo}
          />
        )}
      </div>

      <SectionTitle>Google client</SectionTitle>
      <ActionRow
        phone={props.phone}
        data={{ "data-accounts-client": "" }}
        icon={<Icon icon={KeyRound} size={16} />}
        label={props.googleClient ? "Change Google client" : "Set up Google client"}
        hint={
          props.googleClient
            ? `${props.googleClient}${props.signedIn ? " · connected" : ""}`
            : "Every account signs in with a client from your own Google Cloud project."
        }
        onClick={props.onGoogleClient}
      />
      <ActionRow
        phone={props.phone}
        data={{ "data-accounts-google-settings": "" }}
        icon={<Icon icon={SettingsIcon} size={16} />}
        label="Google account settings"
        hint="Profile picture, contact photos and suggestions, and the client."
        onClick={props.onGoogleSettings}
      />

      {model.signOutAll && (
        <div className="mt-2 border-t border-hairline-soft pt-2">
          <ActionRow
            phone={props.phone}
            data={{ "data-accounts-sign-out-all": "" }}
            icon={<Icon icon={LogOut} size={16} />}
            label="Sign out of all"
            hint="Clears every account's mail from this device and revokes Winnow's access to each."
            danger
            disabled={props.busy}
            onClick={props.onSignOutAll}
          />
        </div>
      )}
    </>
  );
}

function AccountDetailScreen({ account, props }: { account: AccountSummary; props: AccountsPageProps }) {
  const can = accountDetail(account, props.busy);
  const email = account.email || "Your account";
  return (
    <div data-accounts-detail={account.id}>
      <div className="flex items-center gap-3 px-2.5 pb-3 pt-2">
        <span className="relative shrink-0">
          <Avatar lookup={false} name={account.email} address={account.email} photo={account.picture} />
          <AccountGlow color={account.color} scheme={props.scheme} active={account.active} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="selectable block truncate text-ui font-medium text-ink">{email}</span>
          <span data-accounts-status="" className="block truncate text-meta text-ink-subtle">
            {accountStatusLine(account, props.activeUnread)}
          </span>
        </span>
      </div>

      {account.active ? (
        <p className="mx-2.5 mb-2 flex items-center gap-2 rounded-ctl bg-surface-selected px-3 py-2 text-meta font-medium text-ink-body">
          <Icon icon={Check} size={16} className="shrink-0 text-accent" />
          This account is open now.
        </p>
      ) : (
        <ActionRow
          phone={props.phone}
          data={{ "data-accounts-switch": account.id }}
          icon={<Icon icon={ArrowLeftRight} size={16} />}
          label="Switch to this account"
          hint="Opens its inbox. Nothing of the other accounts is cleared."
          disabled={!can.canSwitch}
          onClick={() => props.onSwitch(account.id)}
        />
      )}

      {can.canEdit && (
        <div className="mt-1 border-t border-hairline-soft px-2.5 pt-1">
          <SettingBlock setting="accountColor" className="mx-0! px-0!">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SettingLabel setting="accountColor" id={`winnow-account-colour-${account.id}`} />
              <ColourPicker account={account} scheme={props.scheme} phone={props.phone} onColor={props.onColor} />
            </div>
          </SettingBlock>
          <SettingBlock setting="accountNotify" className="mx-0! px-0!">
            <div className={`flex items-center justify-between gap-2 ${props.phone ? "min-h-11" : ""}`}>
              <SettingLabel setting="accountNotify" />
              <span data-accounts-notify={account.id} className="flex">
                <Toggle
                  checked={account.notify}
                  onChange={(value) => props.onNotify(account.id, value)}
                  label={`Notify about ${email} when it is not open`}
                />
              </span>
            </div>
          </SettingBlock>
        </div>
      )}

      <div className="mt-1 border-t border-hairline-soft pt-2">
        {can.connectInstead ? (
          <>
            <p className="px-2.5 pb-1 text-meta text-ink-subtle">
              A demo account, so there is nothing to sign out of. Connect Gmail to use your own mail.
            </p>
            <ActionRow
              phone={props.phone}
              data={{ "data-accounts-connect": "" }}
              icon={
                <span className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline">
                  <Icon icon={Plus} size={16} />
                </span>
              }
              label={props.busy ? "Waiting for Google…" : "Connect Gmail"}
              disabled={props.busy}
              onClick={props.onAdd}
            />
          </>
        ) : (
          <ActionRow
            phone={props.phone}
            data={{ "data-accounts-sign-out": account.id }}
            icon={<Icon icon={LogOut} size={16} />}
            label="Sign out of this account"
            hint={
              account.active
                ? "Clears its mail from this device and revokes Winnow's access."
                : "Clears its mail from this device and revokes Winnow's access. Your other accounts stay signed in."
            }
            danger
            disabled={!can.canSignOut}
            onClick={() => props.onSignOut(account.id)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The five colours as one radio group: one Tab stop (the chosen colour), the arrow keys
 * move the choice and the focus together, Home and End jump to the ends.
 */
function ColourPicker({
  account,
  scheme,
  phone,
  onColor,
}: {
  account: AccountSummary;
  scheme: ThemeName;
  phone: boolean;
  onColor: (id: string, color: AccountColor) => void;
}) {
  const refs = useRef(new Map<AccountColor, HTMLButtonElement | null>());
  const current = (ACCOUNT_COLORS as readonly string[]).includes(account.color) ? (account.color as AccountColor) : ACCOUNT_COLORS[0];
  const choose = (color: AccountColor) => {
    onColor(account.id, color);
    refs.current.get(color)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-labelledby={`winnow-account-colour-${account.id}`}
      data-accounts-colours={account.id}
      className="flex items-center gap-1"
    >
      {ACCOUNT_COLORS.map((color, index) => {
        const checked = current === color;
        return (
          <button
            key={color}
            ref={(element) => {
              refs.current.set(color, element);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={ACCOUNT_COLOR_LABEL[color]}
            title={ACCOUNT_COLOR_LABEL[color]}
            data-accounts-colour={color}
            tabIndex={checked ? 0 : -1}
            onClick={() => choose(color)}
            onKeyDown={(event) => {
              const last = ACCOUNT_COLORS.length - 1;
              const next =
                event.key === "ArrowRight" || event.key === "ArrowDown"
                  ? (index + 1) % ACCOUNT_COLORS.length
                  : event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? (index + last) % ACCOUNT_COLORS.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? last
                        : null;
              if (next === null) return;
              event.preventDefault();
              choose(ACCOUNT_COLORS[next]);
            }}
            className={`flex items-center justify-center rounded-ctl ${FOCUS} ${phone ? "h-11 w-11" : "h-8 w-8"}`}
          >
            <span
              aria-hidden="true"
              className={`flex items-center justify-center rounded-full border-2 ${checked ? "border-ink" : "border-transparent"} ${phone ? "h-8 w-8" : "h-7 w-7"}`}
            >
              <span className="h-4 w-4 rounded-full" style={{ background: accountColorHex(color, scheme) }} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
