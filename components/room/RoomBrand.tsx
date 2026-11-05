// Trader's Room brand line: the broker's own logo when it has one, else the gem mark + the broker's name as a wordmark.
// showName keeps the name beside a logo too (the sidebar: a broker's logo can be just a small mark).
export function GemMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <path d="M13 2 24 13 13 24 2 13Z" fill="none" stroke="var(--r-accent)" strokeWidth="1.6" />
      <path d="M13 2V24M2 13H24" stroke="var(--r-accent)" strokeWidth="0.9" opacity="0.55" />
    </svg>
  );
}

export default function RoomBrand({ name, logoUrl, size = 26, showName = false }: { name: string; logoUrl: string | null; size?: number; showName?: boolean }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    const logo = <img src={logoUrl} alt={showName ? "" : name} />;
    return showName ? <>{logo}<span className="r-wordmark">{name}</span></> : logo;
  }
  return (
    <>
      <GemMark size={size} />
      <span className="r-wordmark">{name}</span>
    </>
  );
}
