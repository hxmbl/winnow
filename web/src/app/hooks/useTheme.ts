import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "../../core/store/store";
import { ACCENTS, CUSTOM_ACCENT_LABEL, applyTheme, customAccentFor, paletteFor, resolveScheme } from "../../ui/theme";
import { DARK_EMAIL_PALETTE, OLED_EMAIL_PALETTE } from "../../core/mail/emailDark";
import { ACCENT_THEMES, CUSTOM_ACCENT } from "../../core/model/appearance";

type Options = {
  preferences: Snapshot["preferences"];
};

/**
 * The theme, owned in one place: the resolved mode, the palette applied to the
 * document, the email-body dark palette, and the accent picker's swatches.
 */
export function useTheme({ preferences }: Options) {
  const [systemDark, setSystemDark] = useState(
    () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );

  useEffect(() => {
    const query = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    // Subscribed rather than read once: a user who switches their system to dark
    // at 6pm should not have to reload a mail client to see it.
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const themeMode = resolveScheme(preferences.appearance, systemDark);

  // Email dark mode: the palette a message body is drawn in, or null for its own light page.
  const emailDarkPalette =
    !preferences.emailDarkMode || themeMode === "light"
      ? null
      : themeMode === "oled"
        ? OLED_EMAIL_PALETTE
        : DARK_EMAIL_PALETTE;

  useEffect(() => {
    applyTheme(document.documentElement, themeMode, preferences.accent, preferences.accentCustom);
  }, [themeMode, preferences.accent, preferences.accentCustom]);

  /** The picker's swatches, drawn in the mode on screen so each one shows what it will look like. */
  const accentChoices = useMemo(
    () => [
      ...ACCENT_THEMES.map((id) => ({
        id,
        label: ACCENTS[id].label,
        swatch: paletteFor(themeMode, id).color.accent,
      })),
      { id: CUSTOM_ACCENT, label: CUSTOM_ACCENT_LABEL, swatch: customAccentFor(preferences.accentCustom).tones[themeMode].accent },
    ],
    [themeMode, preferences.accentCustom],
  );
  /** The custom colour as picked, and whether this mode had to move it for contrast. */
  const accentCustom = useMemo(() => {
    const derived = customAccentFor(preferences.accentCustom);
    return { value: derived.input, adjusted: derived.adjusted[themeMode] };
  }, [themeMode, preferences.accentCustom]);

  return { themeMode, emailDarkPalette, accentChoices, accentCustom };
}
