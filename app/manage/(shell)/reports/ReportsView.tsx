import { Table } from "@/components/ui/Table";

// Real exports (see app/api/manage/reports/*/route.ts) -- plain <a> links
// so the browser handles the download, no client-side fetch/blob dance
// needed since these are simple authenticated same-origin GETs.
export default function ReportsView() {
  return (
    <Table title="Export">
      <tbody>
        <tr>
          <td className="flex flex-wrap gap-2.5 p-[18px]">
            <a
              href="/api/manage/reports/trading"
              className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
            >
              Trading report (CSV)
            </a>
            <a
              href="/api/manage/reports/financial"
              className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
            >
              Financial report (CSV)
            </a>
            <a
              href="/api/manage/reports/client"
              className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
            >
              Client report (CSV)
            </a>
            <a
              href="/api/manage/reports/ib"
              className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
            >
              IB report (CSV)
            </a>
            <a
              href="/api/manage/reports/risk"
              className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
            >
              Risk report (CSV)
            </a>
            <a
              href="/api/manage/reports/lp"
              className="inline-flex items-center rounded-lg border border-[var(--border-strong)] bg-[var(--bg-3)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--text-1)] hover:border-[var(--text-3)]"
            >
              LP report (CSV)
            </a>
          </td>
        </tr>
      </tbody>
    </Table>
  );
}
