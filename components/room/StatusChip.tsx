// Status text with its dot: green only for a finished/approved state, amber for waiting, red for refused.
const CLS: Record<string, string> = {
  Completed: "r-chip-ok", Approved: "r-chip-ok", Active: "r-chip-ok", Resolved: "r-chip-ok",
  Pending: "r-chip-pending", "In review": "r-chip-pending", Open: "r-chip-pending",
  Rejected: "r-chip-bad", Cancelled: "r-chip-off", "Not started": "r-chip-off",
};

export default function StatusChip({ status, size = 11 }: { status: string; size?: number }) {
  return (
    <span className={`r-chip ${CLS[status] ?? "r-chip-off"}`} style={{ fontSize: size }}>
      <span className="r-dot" style={{ width: 5, height: 5 }} />
      {status}
    </span>
  );
}
