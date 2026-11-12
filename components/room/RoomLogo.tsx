import { wordmarkPieces, type WordmarkStyle } from "@/lib/room/wordmark";
import BrokerLogoImg from "./BrokerLogoImg";

// The broker's full logo for the Trader's Room sign-in, register and forgot-password pages and the onboarding header:
// its mark (Broker.logoUrl) on the left, its name as a wordmark on the right. The wordmark follows the broker's own
// setting (Broker.wordmark, lib/room/wordmark.ts): which part takes the accent (Broker.primaryColor, --r-accent) and
// whether it is in capitals. Not set: the first word in the accent, capitals (FUTURIX GLOBAL).

export function Wordmark({ name, style, className }: { name: string; style: WordmarkStyle | null; className: string }) {
  const { pieces, caps } = wordmarkPieces(name, style);
  return (
    <span className={`${className}${caps ? "" : " r-wm-mixed"}`} aria-hidden="true">
      {pieces.map((p, i) => (p.accent ? <span key={i} className="r-logo-first">{p.text}</span> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

export default function RoomLogo({ name, logoUrl, wordmark = null, size = "lg" }: { name: string; logoUrl: string | null; wordmark?: WordmarkStyle | null; size?: "lg" | "sm" }) {
  return (
    <span className={`r-logo r-logo-${size}`} aria-label={name} role="img">
      {/* the sign-in top row draws it 48 px tall, the onboarding header 28 (room.css .r-logo img, .r-logo-sm img) */}
      {logoUrl ? <BrokerLogoImg src={logoUrl} height={size === "sm" ? 28 : 48} /> : null}
      <Wordmark name={name} style={wordmark} className="r-logo-word" />
    </span>
  );
}
