// A broker's name as a wordmark (owner 2026-11-12). Broker.wordmark says how the name is split, which part takes the
// brand accent and whether it is set in capitals: QoreTrader = {"parts":["Qore","Trader"],"accent":1,"caps":false}
// ("Qore" in the text colour, "Trader" in the accent, mixed case). Not set (null) = the look every broker had before:
// the first word in the accent, the rest in the text colour, capitals (FUTURIX GLOBAL).

export type WordmarkStyle = { parts: string[]; accent: number; caps: boolean };
export type WordmarkPiece = { text: string; accent: boolean };

/** A valid style for this broker name, or null. The parts must spell the name exactly, so the two never drift apart. */
export function parseWordmark(raw: unknown, name: string): WordmarkStyle | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.parts) || r.parts.length < 1 || r.parts.length > 3) return null;
  if (!r.parts.every((p) => typeof p === "string" && p.length > 0 && p.length <= 60)) return null;
  const parts = r.parts as string[];
  if (parts.join("") !== name) return null;
  const accent = typeof r.accent === "number" && Number.isInteger(r.accent) && r.accent >= -1 && r.accent < parts.length ? r.accent : null;
  if (accent === null || typeof r.caps !== "boolean") return null;
  return { parts, accent, caps: r.caps };
}

/** The pieces to draw. `style` null = the default split: first word in the accent, the rest plain, capitals. */
export function wordmarkPieces(name: string, style: WordmarkStyle | null): { pieces: WordmarkPiece[]; caps: boolean } {
  if (style) return { pieces: style.parts.map((text, i) => ({ text, accent: i === style.accent })), caps: style.caps };
  const words = name.trim().split(/\s+/).filter(Boolean);
  const rest = words.slice(1).join(" ");
  return { pieces: [{ text: words[0] ?? "", accent: true }, ...(rest ? [{ text: ` ${rest}`, accent: false }] : [])], caps: true };
}

/** "Qore|Trader" -> parts, for the Super Admin field; the bars mark the split, spaces are kept as typed. */
export function partsFromSplitText(text: string): string[] {
  return text.split("|").filter((p) => p.length > 0);
}
