"use client";

import { useRoom } from "@/components/room/RoomData";

// Sign-in details of the account picked in the header: the account number, and whether the portal password opens it.
export default function SignInCard() {
  const { selected } = useRoom();
  return (
    <div className="r-card" style={{ padding: 18, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        <div className="r-label" style={{ marginBottom: 7 }}>Sign-in details</div>
        <div style={{ fontSize: 12.5, color: "var(--r-text-2)" }}>
          {selected ? (
            <>Account <span className="mono" style={{ color: "var(--r-text)" }}>{selected.accountNumber}</span> · {selected.portalPassword ? "your portal password works on every platform." : "use the password your broker sent for it. A password change here sets one password on all your accounts."}</>
          ) : "Open an account to sign in to the platforms."}
        </div>
      </div>
      <a href="/room/profile" style={{ fontSize: 12.5, fontWeight: 500 }}>Change password</a>
    </div>
  );
}
