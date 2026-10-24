/**
 * Google's setup errors, explained, on the setup sheet's last step.
 *
 * Two pieces, both driven by `core/session/googleErrors`:
 *
 *   - `SetupFix`: the card under a failed test or sign-in — what went wrong in plain
 *     words, the fix, and a button that jumps back to the step where it is fixed.
 *   - `SetupTroubleshoot`: "Google showed an error?" — a disclosure with a field to paste
 *     what Google's page said, explained as you type, and the common errors listed so
 *     one tap shows the fix. Google shows most setup errors on its own pages and never
 *     sends the user back, so this is the only way Winnow can help with them.
 */

import { useId, useState } from "react";
import { ArrowLeft, ChevronDown, Lightbulb } from "lucide-react";
import type { ClientKind } from "../../core/session/credentials";
import { COMMON_GOOGLE_ERRORS, explainGoogleText, type GoogleErrorHelp } from "../../core/session/googleErrors";
import { SETUP_STEPS, stepIndexOf, type SetupStep } from "../googleSetupSteps";

/** `steps` is the walkthrough on screen (Android's has one more), so the index matches it. */
type StepProps = { steps?: readonly SetupStep[]; onGoToStep: (index: number) => void };

export function SetupFix({ help, steps = SETUP_STEPS, onGoToStep }: { help: GoogleErrorHelp } & StepProps) {
  const index = stepIndexOf(help.step, steps);
  const isPaste = help.step === "paste";
  return (
    <div
      className="flex flex-col gap-1.5 rounded-pane border border-hairline bg-surface px-3 py-2.5 text-ui"
      data-setup-fix={help.code}
    >
      <p className="flex items-start gap-1.5 font-semibold text-ink">
        <Lightbulb size={14} className="mt-[3px] shrink-0 text-accent" aria-hidden="true" />
        <span>{help.title}</span>
      </p>
      <p className="selectable text-meta leading-relaxed text-ink-body">{help.fix}</p>
      {!isPaste && (
        <button
          type="button"
          onClick={() => onGoToStep(index)}
          className="inline-flex w-fit items-center gap-1 rounded-ctl text-meta font-semibold text-ink-body underline underline-offset-2 hover:text-ink max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          data-setup-fix-step={help.step}
        >
          <ArrowLeft size={12} aria-hidden="true" />
          Back to step {index + 1}: {steps[index]!.title}
        </button>
      )}
    </div>
  );
}

export function SetupTroubleshoot({ kind, steps = SETUP_STEPS, onGoToStep }: { kind: ClientKind } & StepProps) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const help = explainGoogleText(text, kind);
  const field = `${ids}-google-said`;
  const panel = `${ids}-troubleshoot`;

  return (
    <div className="rounded-pane border border-hairline-soft" data-setup-troubleshoot="">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 rounded-pane px-3 py-2 text-left text-ui font-medium text-ink-body hover:bg-surface-hover max-sm:min-h-11 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Google showed an error?
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>
      {open && (
        <div id={panel} className="flex flex-col gap-2.5 px-3 pb-3">
          <label htmlFor={field} className="text-meta text-ink-subtle">
            Paste what Google's page said, or choose it below.
          </label>
          <textarea
            id={field}
            rows={2}
            value={text}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            placeholder="Error 400: redirect_uri_mismatch"
            className="w-full resize-none rounded-pane border border-hairline bg-surface px-2.5 py-1.5 font-mono text-meta text-ink outline-hidden placeholder:text-ink-placeholder focus-visible:border-accent max-sm:text-ui"
            data-setup-google-said=""
          />
          <ul className="flex flex-wrap gap-1.5" aria-label="Common errors">
            {COMMON_GOOGLE_ERRORS.map((item) => (
              <li key={item.label}>
                <button
                  type="button"
                  onClick={() => setText(item.sample)}
                  className="rounded-full border border-hairline px-2.5 py-0.5 text-left font-mono text-meta text-ink-muted hover:bg-surface-hover hover:text-ink max-sm:min-h-9 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
          <div role="status" aria-live="polite">
            {help ? (
              <SetupFix help={help} steps={steps} onGoToStep={onGoToStep} />
            ) : text.trim() ? (
              <p className="text-meta text-ink-subtle" data-setup-fix="unknown">
                Winnow doesn't recognise that one. The setup guide covers more cases.
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
