/**
 * "What's new": the release notes for every version since the installed one, newest
 * first, in a sheet opened from the update notice or Settings › About.
 *
 * The notes are parsed into data (`core/updates/changelog.ts`) and rendered here as
 * React elements, never as HTML: a release body cannot run script or load a picture.
 * Links are `https:` only and open in the system browser through the platform.
 */

import { useRef } from "react";
import { Sheet, SheetHeader } from "./Overlay";
import { parseMarkdown, type Block, type Inline } from "../../core/updates/changelog";
import type { ChangelogState } from "../useUpdates";
import { GIT_PULL_COMMAND, type UpdateOffer } from "../../core/updates/updates";

type Props = {
  offer: UpdateOffer;
  state: ChangelogState;
  /** The pill's / Settings' action for this offer, or null when there is nothing to press (web). */
  actionLabel: string | null;
  onAction: () => void;
  onOpenLink: (url: string) => void;
  onClose: () => void;
  phone: boolean;
};

function dateLabel(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function Inlines({ nodes, onOpenLink }: { nodes: Inline[]; onOpenLink: (url: string) => void }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case "text":
            return <span key={index}>{node.text}</span>;
          case "code":
            return (
              <code key={index} className="rounded-ctl bg-surface-sunken px-1 py-0.5 font-mono text-[0.92em] text-ink-body">
                {node.text}
              </code>
            );
          case "strong":
            return (
              <strong key={index} className="font-semibold text-ink">
                <Inlines nodes={node.children} onOpenLink={onOpenLink} />
              </strong>
            );
          case "em":
            return (
              <em key={index}>
                <Inlines nodes={node.children} onOpenLink={onOpenLink} />
              </em>
            );
          case "link":
            return (
              <a
                key={index}
                href={node.href}
                rel="noreferrer noopener"
                target="_blank"
                onClick={(event) => {
                  event.preventDefault();
                  onOpenLink(node.href);
                }}
                className="break-words text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <Inlines nodes={node.children} onOpenLink={onOpenLink} />
              </a>
            );
        }
      })}
    </>
  );
}

function Blocks({ blocks, onOpenLink }: { blocks: Block[]; onOpenLink: (url: string) => void }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <p key={index} role="heading" aria-level={4} className="pt-2 text-ui font-semibold text-ink">
                <Inlines nodes={block.children} onOpenLink={onOpenLink} />
              </p>
            );
          case "paragraph":
            return (
              <p key={index}>
                <Inlines nodes={block.children} onOpenLink={onOpenLink} />
              </p>
            );
          case "quote":
            return (
              <p key={index} className="border-l-2 border-hairline pl-3 text-ink-muted">
                <Inlines nodes={block.children} onOpenLink={onOpenLink} />
              </p>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={index} className={`flex flex-col gap-1 pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <Inlines nodes={item} onOpenLink={onOpenLink} />
                  </li>
                ))}
              </List>
            );
          }
          case "code":
            return (
              <pre
                key={index}
                className="selectable overflow-x-auto rounded-ctl bg-surface-sunken px-3 py-2 font-mono text-meta text-ink-body"
              >
                {block.text}
              </pre>
            );
          case "table":
            return (
              <div key={index} className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-meta">
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} className="border-b border-hairline py-1 pr-3 font-semibold text-ink">
                          <Inlines nodes={cell} onOpenLink={onOpenLink} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="border-b border-hairline py-1 pr-3 align-top">
                            <Inlines nodes={cell} onOpenLink={onOpenLink} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr key={index} className="border-hairline" />;
        }
      })}
    </>
  );
}

export function WhatsNew(props: Props) {
  const close = useRef<HTMLButtonElement>(null);
  const { offer, state } = props;
  return (
    <Sheet
      label={`What's new in Winnow ${offer.version}`}
      onClose={props.onClose}
      initialFocus={close}
      placement={props.phone ? "bottom" : "center"}
      className={`flex w-full max-w-[620px] flex-col overflow-hidden border border-hairline bg-chrome shadow-lift ${
        props.phone ? "max-h-[85vh] rounded-t-pane" : "max-h-[80vh] rounded-pane"
      }`}
    >
      <div data-whats-new={state.status} className="flex min-h-0 flex-1 flex-col">
        <SheetHeader title="What's new" onClose={props.onClose} touch={props.phone} />
        <div className="selectable thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4 text-ui text-ink-body" aria-busy={state.status === "loading"}>
          <p className="pb-3 text-meta text-ink-muted">
            Winnow {offer.version} is available. You have {offer.current}.
          </p>
          {offer.action.kind === "git-pull" && (
            <p className="pb-3 text-meta text-ink-muted">
              This copy runs from your own deployment. To update it, run{" "}
              <code className="rounded-ctl bg-surface-sunken px-1 py-0.5 font-mono text-ink-body">{GIT_PULL_COMMAND}</code>{" "}
              in your clone, then redeploy.
            </p>
          )}
          {state.status === "loading" && <p className="text-meta text-ink-subtle">Getting the release notes…</p>}
          {state.status === "failed" && (
            <p className="text-meta text-ink-muted">
              Couldn't get the release notes ({state.reason}).{" "}
              <a
                href={offer.pageUrl}
                onClick={(event) => {
                  event.preventDefault();
                  props.onOpenLink(offer.pageUrl);
                }}
                className="text-accent underline-offset-2 hover:underline"
              >
                Read them on GitHub
              </a>
              .
            </p>
          )}
          {state.status === "ok" && state.entries.length === 0 && (
            <p className="text-meta text-ink-muted">This release has no notes.</p>
          )}
          {state.status === "ok" &&
            state.entries.map((entry) => (
              <section key={entry.version} data-whats-new-version={entry.version} className="flex flex-col gap-2 pb-5">
                <h3 className="text-ui font-semibold text-ink">
                  Winnow {entry.version}
                  {dateLabel(entry.date) && (
                    <span className="pl-2 text-meta font-normal text-ink-subtle">{dateLabel(entry.date)}</span>
                  )}
                </h3>
                {entry.notes.trim() ? (
                  <Blocks blocks={parseMarkdown(entry.notes)} onOpenLink={props.onOpenLink} />
                ) : (
                  <p className="text-meta text-ink-subtle">No notes for this release.</p>
                )}
              </section>
            ))}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            ref={close}
            type="button"
            onClick={props.onClose}
            className="rounded-ctl px-4 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Close
          </button>
          {props.actionLabel && (
            <button
              type="button"
              data-whats-new-action=""
              onClick={props.onAction}
              className="rounded-ctl bg-accent px-4 py-1.5 text-ui font-semibold text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {props.actionLabel}
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
