import "server-only";

// Extracted out of app/api/trade/kyc/route.ts so the Client Portal's own
// KYC submission (app/api/portal/kyc/route.ts) validates uploads exactly
// the same way -- the same magic-byte sniffing (2026-09-05 audit fix:
// never trust the client-declared Content-Type), the same size/type
// limits -- rather than a second, driftable copy of this logic.

export const KYC_ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
export const KYC_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
export const KYC_DOCUMENT_TYPES = new Set(["passport", "national_id", "drivers_license"]);

export function sniffMimeType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "application/pdf"; // "%PDF-"
  }
  return null;
}

export async function validateKycFile(
  file: File | null,
  label: string
): Promise<{ error: string } | { error: null; bytes: Buffer; sniffedType: string }> {
  if (!file || file.size === 0) {
    return { error: `${label} is required` };
  }
  if (!KYC_ALLOWED_TYPES.has(file.type)) {
    return { error: `${label} must be a JPEG, PNG, or PDF` };
  }
  if (file.size > KYC_MAX_SIZE_BYTES) {
    return { error: `${label} must be under 10MB` };
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const sniffedType = sniffMimeType(bytes);
  if (!sniffedType) {
    return { error: `${label} doesn't look like a real JPEG, PNG, or PDF file` };
  }
  return { error: null, bytes, sniffedType };
}
