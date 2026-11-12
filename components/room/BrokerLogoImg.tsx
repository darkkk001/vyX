import { logoResizable, logoSources, type LogoHeight } from "@/lib/broker-logo-paths";

// The broker's logo at one of the heights it is drawn at, from the resized copies (lib/broker-logo-paths.ts): WebP
// where the browser takes it, else PNG, 2x on retina screens. <picture> is display: contents, so the <img> lays out
// exactly as the plain <img> did. A logo with no copies (SVG, relative path) is the plain <img> as before.
export default function BrokerLogoImg({ src, height, className, alt = "" }: { src: string; height: LogoHeight; className?: string; alt?: string }) {
  if (!logoResizable(src)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={src} alt={alt} />;
  }
  const s = logoSources(src, height);
  return (
    <picture style={{ display: "contents" }}>
      <source type="image/webp" srcSet={s.webpSet} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className={className} src={s.png} srcSet={s.pngSet} alt={alt} />
    </picture>
  );
}
