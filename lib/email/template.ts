import "server-only";

// One branded HTML/text shell every transactional email renders through
// -- verification, password reset, and (as they're built) deposit/
// withdrawal confirmations, KYC status, Live-account approval. Per-tenant:
// the broker's own logo/name/accent color, not this platform's. Table-
// based layout with every style inline -- the only markup that survives
// Gmail/Outlook/Apple Mail's own CSS stripping, unlike a <style> block or
// external stylesheet, which several major clients simply discard.

export type BrokerEmailBranding = {
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  supportEmail: string | null;
};

export type BrandedEmailContent = {
  // Hidden preview text most clients show next to the subject line in
  // the inbox list, before the email is opened.
  preheader: string;
  heading: string;
  // Each string is its own paragraph -- kept as plain text (not html),
  // so callers never have to think about escaping.
  bodyLines: string[];
  cta?: { label: string; url: string };
  // e.g. "This link expires in 1 hour." -- shown after the CTA, before
  // the footer's standard "if you didn't request this" line.
  extraNote?: string;
};

const DEFAULT_ACCENT = "#16C784"; // same fallback as BrokerLandingPage.module.css's --accent

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Buttons filled with the broker's own accent should show dark text
// against a light color (barely-there contrast otherwise) and white
// text against a dark one -- perceived brightness (YIQ), not a literal
// lightness reading, matches what looks right across hues.
function readableTextColor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#04140C";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#04140C" : "#FFFFFF";
}

export function renderBrokerEmail(broker: BrokerEmailBranding, content: BrandedEmailContent): { html: string; text: string } {
  const accent = broker.primaryColor?.trim() || DEFAULT_ACCENT;
  const accentText = readableTextColor(accent);
  const brokerName = escapeHtml(broker.name);

  const headerLogo = broker.logoUrl
    ? `<img src="${escapeHtml(broker.logoUrl)}" alt="${brokerName}" height="32" style="display:block;height:32px;width:auto;border:0;" />`
    : `<span style="font-size:18px;font-weight:700;color:#16181D;">${brokerName}</span>`;

  const bodyParagraphs = content.bodyLines
    .map((line) => `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#3C4149;">${escapeHtml(line)}</p>`)
    .join("\n");

  const ctaBlock = content.cta
    ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">
        <tr>
          <td align="center" bgcolor="${accent}" style="border-radius:8px;">
            <a href="${escapeHtml(content.cta.url)}" target="_blank"
               style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:700;color:${accentText};text-decoration:none;border-radius:8px;font-family:Arial,Helvetica,sans-serif;">
              ${escapeHtml(content.cta.label)}
            </a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 20px;font-size:12px;line-height:1.6;color:#8A909B;">
        If the button above doesn't work, copy and paste this link into your browser:<br />
        <a href="${escapeHtml(content.cta.url)}" style="color:${accent};word-break:break-all;">${escapeHtml(content.cta.url)}</a>
      </p>`
    : "";

  const extraNote = content.extraNote
    ? `<p style="margin:0 0 20px;font-size:12px;line-height:1.6;color:#8A909B;">${escapeHtml(content.extraNote)}</p>`
    : "";

  const supportLine = broker.supportEmail
    ? `Need help? Contact <a href="mailto:${escapeHtml(broker.supportEmail)}" style="color:${accent};text-decoration:none;">${escapeHtml(broker.supportEmail)}</a>.`
    : `Need help? Contact ${brokerName} support.`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(content.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#EEF0F3;font-family:Arial,Helvetica,sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EEF0F3;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px;border-bottom:3px solid ${accent};">
                ${headerLogo}
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;color:#16181D;">${escapeHtml(content.heading)}</h1>
                ${bodyParagraphs}
                ${ctaBlock}
                ${extraNote}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background-color:#F7F8FA;border-top:1px solid #E7E9ED;">
                <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#8A909B;">${supportLine}</p>
                <p style="margin:0;font-size:12px;line-height:1.6;color:#8A909B;">
                  If you didn't request this, you can safely ignore this email.
                </p>
                <p style="margin:12px 0 0;font-size:11px;line-height:1.6;color:#B0B5BD;">&copy; ${new Date().getFullYear()} ${brokerName}. All rights reserved.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textLines = [
    content.heading,
    "",
    ...content.bodyLines,
    ...(content.cta ? ["", `${content.cta.label}: ${content.cta.url}`] : []),
    ...(content.extraNote ? ["", content.extraNote] : []),
    "",
    broker.supportEmail ? `Need help? Contact ${broker.supportEmail}.` : `Need help? Contact ${broker.name} support.`,
    "If you didn't request this, you can safely ignore this email.",
  ];
  const text = textLines.join("\n");

  return { html, text };
}
