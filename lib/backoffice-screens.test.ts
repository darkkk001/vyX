import { describe, expect, it } from "vitest";
import { allowedBackofficeScreens, BACKOFFICE_SCREENS } from "@/lib/backoffice-screens";
import { expectedAllowed, MANIFEST, PERSONA_DEFS, type PersonaKey } from "@/lib/manage-permission-manifest";

// Phase 2 batch 4: the backoffice menu (shell-info `screens`) must never offer a
// screen whose data the person can't read, nor hide one they can. Each screen
// names the routes it loads; lib/manage-permission-manifest.ts holds the
// per-route expectations the permission matrix test proves against the real
// handlers. Here: for every persona, a screen is in the menu EXACTLY when every
// one of its routes lets that persona through. Change a route's gate (and its
// manifest row) without the screen rule -- or the other way round -- and this
// fails.

type Persona = PersonaKey | "brokerAdmin";
const PERSONAS: Persona[] = ["readonly", "dealer", "finance", "support", "brokerAdmin"];

function personaRole(p: Persona) {
  return p === "brokerAdmin" ? { role: "BROKER_ADMIN", extraPermissions: [] as string[] } : PERSONA_DEFS[p];
}

function routeAllowed(route: string, persona: Persona): boolean {
  const [mod, method] = route.split(" ");
  const row = MANIFEST.find((r) => r.mod === mod && r.method === method);
  if (!row) throw new Error(`screen route ${route} has no row in lib/manage-permission-manifest.ts`);
  if (persona === "brokerAdmin") return true; // BROKER_ADMIN passes every /api/manage gate
  return expectedAllowed(row.perm, persona, row.supportRead);
}

describe("backoffice menu (shell-info screens) agrees with the route permission manifest", () => {
  for (const persona of PERSONAS) {
    const { role, extraPermissions } = personaRole(persona);
    const menu = new Set(allowedBackofficeScreens(role, extraPermissions));
    for (const screen of BACKOFFICE_SCREENS) {
      const expected = screen.routes.every((r) => routeAllowed(r, persona));
      it(`${screen.code} -- ${persona} ${expected ? "sees it" : "does not"}`, () => {
        expect(menu.has(screen.code)).toBe(expected);
      });
    }
  }

  it("every screen code is unique", () => {
    const codes = BACKOFFICE_SCREENS.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives the owner-decided menus", () => {
    // SUPPORT: read-only support -- clients, KYC, notifications, trade history, deposits/withdrawals, own security
    expect(allowedBackofficeScreens("SUPPORT", [])).toEqual(["NTF", "DLS", "CLI", "KYC", "DEP", "SEC"]);
    // a MANAGER without delegations: no USR / CFG / LP / ROUTE / RPT-LP / PSP (BROKER_ADMIN only),
    // no IB / DEP / KYC / LAR / TRX / MIR / RISK / EMG (each needs its permission)
    const plain = allowedBackofficeScreens("MANAGER", []);
    for (const code of ["USR", "CFG", "LP", "ROUTE", "RPT-LP", "PSP", "IB", "DEP", "KYC", "LAR", "TRX", "MIR", "RISK", "EMG"]) expect(plain).not.toContain(code);
    for (const code of ["DASH", "RPT", "NTF", "EXP", "DEAL", "DLS", "CLI", "AUD", "SEC"]) expect(plain).toContain(code);
    // delegations open exactly their screens
    expect(allowedBackofficeScreens("MANAGER", ["IB_PAYOUTS"])).toContain("IB");
    expect(allowedBackofficeScreens("MANAGER", ["FUNDS_APPROVAL"])).toContain("DEP");
    expect(allowedBackofficeScreens("MANAGER", ["EMERGENCY_CONTROLS"])).toEqual(expect.arrayContaining(["EMG", "RISK"]));
    expect(allowedBackofficeScreens("MANAGER", ["RISK_SETTINGS"])).toEqual(expect.arrayContaining(["EMG", "RISK"]));
    // BROKER_ADMIN: everything
    expect(allowedBackofficeScreens("BROKER_ADMIN", [])).toEqual(BACKOFFICE_SCREENS.map((s) => s.code));
    // anything else: nothing
    expect(allowedBackofficeScreens("SUPER_ADMIN", [])).toEqual([]);
  });
});
