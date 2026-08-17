import Link from "next/link";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Nav bar shared across every /manage/* page once a manager screen exists
// to link to -- only shown when actually signed in (so /manage/login
// itself stays a plain, standalone form).
export default async function ManageLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  const isManager = requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]);

  return (
    <div style={{ fontFamily: "sans-serif" }}>
      {isManager ? (
        <nav
          style={{
            display: "flex",
            gap: 20,
            padding: "12px 24px",
            borderBottom: "1px solid #ddd",
            fontSize: 14,
          }}
        >
          <strong>VyXTrader Manager</strong>
          <Link href="/manage/symbols">Symbols</Link>
          <Link href="/manage/positions">Positions</Link>
          <Link href="/manage/accounts">Accounts</Link>
          <Link href="/manage/groups">Groups</Link>
          {session!.role === "BROKER_ADMIN" ? <Link href="/manage/funds">Funds</Link> : null}
          {session!.role === "BROKER_ADMIN" ? <Link href="/manage/kyc">KYC</Link> : null}
          {session!.role === "BROKER_ADMIN" ? <Link href="/manage/ib">IB</Link> : null}
        </nav>
      ) : null}
      {children}
    </div>
  );
}
