// The native mobile app's thin-stroke line icons (qoretrader-mobile lib/app/tab_icons.dart), drawn on the same 20-unit grid
// so the phone WebTrader reads as the same product. Stroke 1.6, round caps and joins, currentColor.

export type MobileGlyph =
  | "quotes" | "charts" | "trade" | "history" | "settings"
  | "search" | "plus" | "chevronDown" | "chevronRight" | "lock" | "bell" | "sun" | "oneClick" | "signOut" | "export";

const gear = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  return `M${10 + 5.2 * Math.cos(a)} ${10 + 5.2 * Math.sin(a)}L${10 + 7.6 * Math.cos(a)} ${10 + 7.6 * Math.sin(a)}`;
}).join("");
const rays = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  return `M${10 + 6.4 * Math.cos(a)} ${10 + 6.4 * Math.sin(a)}L${10 + 8.6 * Math.cos(a)} ${10 + 8.6 * Math.sin(a)}`;
}).join("");

function paths(g: MobileGlyph) {
  switch (g) {
    case "quotes": return <path d="M3 5H17M3 10H13M3 15H16" />;
    case "charts": return <path d="M6 2.5V17.5M3.8 6H8.2V13H3.8ZM14 3.5V16.5M11.8 5.5H16.2V11H11.8Z" />;
    case "trade": return <path d="M2.5 15.5L7.5 10L10.5 12.5L17 5M12.8 5H17V9.2" />;
    case "history": return <><circle cx="10" cy="10" r="7.5" /><path d="M10 5.8V10L13 11.8" /></>;
    case "settings": return <><circle cx="10" cy="10" r="5.2" /><circle cx="10" cy="10" r="2.1" /><path d={gear} /></>;
    case "search": return <><circle cx="8.8" cy="8.8" r="5.6" /><path d="M13 13L17 17" /></>;
    case "plus": return <path d="M10 3.5V16.5M3.5 10H16.5" />;
    case "chevronDown": return <path d="M6 8L10 12L14 8" />;
    case "chevronRight": return <path d="M8 6L12 10L8 14" />;
    case "lock": return <><rect x="4" y="9" width="12" height="8.5" rx="1.5" /><path d="M6.8 9V6.5A3.2 3.2 0 0 1 13.2 6.5V9" /></>;
    case "bell": return <path d="M4 14.5H16L14.5 12.5V8.5A4.5 4.5 0 0 0 5.5 8.5V12.5ZM8.5 17H11.5" />;
    case "sun": return <><circle cx="10" cy="10" r="3.6" /><path d={rays} /></>;
    case "oneClick": return <path d="M11.5 2.5L5 11H9.6L8.5 17.5L15 8.8H10.4Z" />;
    case "signOut": return <path d="M8 3.5H4V16.5H8M8.5 10H17M13.5 6.5L17 10L13.5 13.5" />;
    case "export": return <path d="M6.5 8H4V17H16V8H13.5M10 2.8V12M7 5.8L10 2.8L13 5.8" />;
  }
}

export default function MobileIcon({ glyph, size = 18 }: { glyph: MobileGlyph; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths(glyph)}
    </svg>
  );
}
