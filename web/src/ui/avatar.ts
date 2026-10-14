/** The pure half of `components/Avatar`: which tone and which letter. */

export type AvatarTone = "neutral" | "accent";

/** A stable, cheap hash of the address, so a sender keeps their tone across sessions. */
export function avatarTone(address: string): AvatarTone {
  let hash = 0;
  const key = address.trim().toLowerCase();
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return (hash & 1) === 0 ? "neutral" : "accent";
}

/** One letter: the first letter or digit of the display name, else of the address. */
export function avatarInitial(name: string, address: string): string {
  const pick = (text: string) => text.match(/[\p{L}\p{N}]/u)?.[0];
  return (pick(name) ?? pick(address) ?? "?").toUpperCase();
}

