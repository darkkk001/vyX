"use client";

import { useCallback, useEffect, useState } from "react";
import { useRoomEvent, type RoomTx } from "./RoomData";

// GET /api/room/funds?account= for the Deposit / Withdraw / Transfer screens.
export type FundsMethod = {
  id: string; type: string; label: string; available: boolean; min: string; max: string | null; feeLine: string | null; processing: string | null; withdraw: { min: string; max: string | null; processing: string | null };
  bank: { beneficiary: string; bank: string; iban: string; swift: string } | null; wallet: string | null; qr: string | null; warning: string | null; instructions: string | null;
};
export type PayoutMethod = { id: string; type: string; title: string; sub: string; verified: boolean };
export type Funds = {
  account: { id: string; accountNumber: string; mode: "LIVE" | "DEMO"; currency: string };
  methods: FundsMethod[];
  reference: string;
  available: string;
  payoutMethods: PayoutMethod[];
  pendingWithdrawals: { id: string; amount: string; at: string }[];
  kyc: "NONE" | "PENDING" | "APPROVED" | "REJECTED";
  transfers: RoomTx[];
};

export function useFunds(accountId: string | null | undefined) {
  const [funds, setFunds] = useState<Funds | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!accountId) return;
    const res = await fetch(`/api/room/funds?account=${encodeURIComponent(accountId)}`, { cache: "no-store" });
    if (res.ok) { setFunds(await res.json()); setError(""); } else setError("Could not load. Try again.");
  }, [accountId]);
  useEffect(() => { setFunds(null); void load(); }, [load]);
  useRoomEvent(() => { void load(); });
  return { funds, error, reload: load, setFunds };
}

/** Amount typed by the client: digits, one dot, at most 2 decimals; thousands separators are dropped. */
export function cleanAmount(s: string): string {
  return s.replace(/,/g, "").trim();
}
export function amountOk(s: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(cleanAmount(s)) && Number(cleanAmount(s)) > 0;
}

/** Reads a chosen file as a data URL (the receipt upload). */
export function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}
