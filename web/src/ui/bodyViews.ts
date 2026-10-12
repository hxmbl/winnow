import { Code2, Eye, Server, Type } from "lucide-react";
import { renderProxyUrl } from "../core/mail/proxy";
import type { BodyView } from "./components/MessageBody";

/**
 * The forms this message can be shown in, for the reader's "Show as" menu.
 *
 * Two choices rather than four when the message has no HTML part. A choice whose "Rich"
 * option renders nothing is a control lying about the message. The control used to be a
 * segmented switch above every body; it lives in the toolbar's menu now, because most
 * readers change it once, if ever.
 */
export function bodyViewOptions(hasHtml: boolean): Array<{ id: BodyView; label: string; Icon: typeof Type }> {
  return [
    ...(hasHtml ? [{ id: "rich" as BodyView, label: "Rich", Icon: Eye }] : []),
    ...(hasHtml && renderProxyUrl !== null
      ? [{ id: "proxied" as BodyView, label: "Proxied", Icon: Server }]
      : []),
    { id: "plain", label: "Plain text", Icon: Type },
    { id: "sent", label: "As sent", Icon: Code2 },
  ];
}
