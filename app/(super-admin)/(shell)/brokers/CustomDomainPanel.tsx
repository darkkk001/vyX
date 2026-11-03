"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

// The broker's own client domain (white label). Set it, show the DNS record the broker adds, check it; once it answers
// here the broker's vyxtrader address redirects to it (GET / PUT / POST /api/admin/brokers/<id>/custom-domain).
type View = {
  subdomain: string;
  customDomain: string | null;
  live: boolean;
  liveSince: string | null;
  records: { cname: { host: string; value: string; fqdn: string }; note: string } | null;
  check: { live: boolean; dns: string; https: string } | null;
};

export default function CustomDomainPanel({ brokerId }: { brokerId: string }) {
  const [v, setV] = useState<View | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/brokers/${brokerId}/custom-domain`, { cache: "no-store" });
    if (res.ok) { const body: View = await res.json(); setV(body); setDraft(body.customDomain ?? ""); }
  }, [brokerId]);
  useEffect(() => { void load(); }, [load]);

  async function call(method: "PUT" | "POST", body?: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/brokers/${brokerId}/custom-domain`, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const out = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(out.error ?? "Save failed."); return; }
    setV(out);
    setDraft(out.customDomain ?? "");
  }

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex items-center gap-2">
        <input
          aria-label="Custom domain"
          className="mono flex-1 rounded-md border border-[var(--border)] bg-[var(--bg-1)] px-2 py-1.5"
          placeholder="portal.brokername.com"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button size="sm" variant="primary" disabled={busy || draft.trim() === (v?.customDomain ?? "")} onClick={() => call("PUT", { customDomain: draft.trim() || null })}>
          {busy ? "Saving..." : "Save"}
        </Button>
        {v?.customDomain ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => call("POST")}>Check now</Button> : null}
      </div>
      {v?.customDomain ? (
        <>
          <div className="flex items-center gap-2">
            <Badge tone={v.live ? "success" : "warning"}>{v.live ? "LIVE" : "NOT LIVE"}</Badge>
            <span className="text-[var(--text-3)]">{v.live ? `${v.subdomain} pages redirect to ${v.customDomain}.` : `${v.subdomain} pages stay where they are until the domain answers here.`}</span>
          </div>
          {v.check ? <span className="mono text-[var(--text-3)]">{v.check.dns} · {v.check.https}</span> : null}
          {v.records ? (
            <div className="rounded-md border border-[var(--border)] p-2">
              <div className="mono">CNAME {v.records.cname.host} → {v.records.cname.value}</div>
              <div className="mt-1 text-[var(--text-3)]">{v.records.note} Then add {v.records.cname.fqdn} to the platform project&apos;s Domains in Vercel.</div>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? <p className="text-[var(--sell)]">{error}</p> : null}
    </div>
  );
}
