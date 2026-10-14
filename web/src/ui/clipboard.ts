/**
 * Copy text to the system clipboard.
 *
 * The async Clipboard API first (browsers, and the desktop webviews, which allow it from
 * a user gesture), then a hidden textarea and `execCommand("copy")` where it is refused
 * (an older webview, a page without focus). No Tauri plugin is involved: both paths run
 * inside the desktop webview and reach the OS clipboard from there.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
