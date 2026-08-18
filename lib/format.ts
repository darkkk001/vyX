// Small formatting helpers shared by the Manager/Super Admin admin
// surfaces.

// AdminUser has no `name` column, so avatar/pill initials are always
// derived from an email or a display string (broker name, etc.).
export function initialsFrom(text: string): string {
  const base = text.includes("@") ? text.split("@")[0] : text;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? [parts[0][0], parts[1][0]] : [base.slice(0, 2)];
  return letters.join("").toUpperCase().slice(0, 2);
}
