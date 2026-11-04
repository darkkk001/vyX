// The status line on the Trader's Room sign-in. ONLINE only when every check reported OK; a failed check says so; no
// recent report (null) shows nothing, so the page never claims a state nobody measured.
export type RoomServiceStatus = "ONLINE" | "AFFECTED" | null;

export function roomServiceStatus(states: readonly ("OK" | "FAIL" | "NO_REPORT")[]): RoomServiceStatus {
  if (states.includes("FAIL")) return "AFFECTED";
  return states.length > 0 && states.every((s) => s === "OK") ? "ONLINE" : null;
}
