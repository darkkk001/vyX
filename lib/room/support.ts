// Trader's Room / backoffice ticket number as people read it: TCK-0042.
export function ticketRef(n: number): string {
  return `TCK-${String(n).padStart(4, "0")}`;
}
