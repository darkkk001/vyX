// Trader's Room brand line: the broker's own logo when it has one, else the gem mark + the broker's name as a wordmark.
export function GemMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <path d="M13 2 24 13 13 24 2 13Z" fill="none" stroke="var(--r-accent)" strokeWidth="1.6" />
      <path d="M13 2V24M2 13H24" stroke="var(--r-accent)" strokeWidth="0.9" opacity="0.55" />
    </svg>
  );
}

export default function RoomBrand({ name, logoUrl, size = 26 }: { name: string; logoUrl: string | null; size?: number }) {
  if (logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logoUrl} alt={name} />;
  }
  return (
    <>
      <GemMark size={size} />
      <span className="r-wordmark">{name}</span>
    </>
  );
}
