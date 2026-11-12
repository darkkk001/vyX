// The funding wallet before it exists (owner 2026-11-12). Deposit names it "wallet": GET /api/room/funds?account=wallet
// shows its methods and a payment reference (DEP-WALLET-XXXX) without creating it; the first deposit request
// (POST /api/room/deposit accountId "wallet") creates it (lib/room/wallet.ts ensureWallet) and keeps that reference.
export const WALLET_KEY = "wallet";
export const NEW_WALLET_NUMBER = "WALLET";
