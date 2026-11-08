// The broker's full logo for the Trader's Room sign-in, register and forgot-password pages: its mark (Broker.logoUrl)
// beside its name as a two-part wordmark, the first word in the broker's accent (Broker.primaryColor, set as
// --r-accent by RoomFrame). Everything comes from the tenant's brand config, so each broker shows its own.

/** "Futurix Global" -> ["Futurix", "Global"]; a one-word name has no second part. */
export function wordmarkParts(name: string): [string, string] {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return [words[0] ?? "", words.slice(1).join(" ")];
}

export default function RoomLogo({ name, logoUrl, size = "lg" }: { name: string; logoUrl: string | null; size?: "lg" | "sm" }) {
  const [first, rest] = wordmarkParts(name);
  return (
    <span className={`r-logo r-logo-${size}`} aria-label={name} role="img">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {logoUrl ? <img src={logoUrl} alt="" /> : null}
      <span className="r-logo-word" aria-hidden="true">
        <span className="r-logo-first">{first}</span>
        {rest ? <> {rest}</> : null}
      </span>
    </span>
  );
}
