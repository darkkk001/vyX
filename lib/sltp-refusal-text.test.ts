import { describe, expect, it } from "vitest";
import { clientRefusal } from "@/lib/client-reason";
import { validateSlTp } from "@/lib/trading";
import { orderRef, positionRef, slTpRefusalText } from "@/lib/sltp-refusal-text";

// Owner 2026-11-10: a refused SL / TP shows the real reason, not "Invalid SL or TP". The rule (validateSlTp) is unchanged.
describe("SL / TP refusals say why", () => {
  it("wrong side and too close, for an open position, name the account's bid / ask and its value", () => {
    const buy = positionRef("BUY", "4049.93");
    expect(slTpRefusalText(validateSlTp({ side: "BUY", referencePrice: "4049.93", slPrice: "4049.95", digits: 2 }), buy)).toBe("Stop loss must be below your bid (4049.93) for a BUY");
    expect(slTpRefusalText(validateSlTp({ side: "BUY", referencePrice: "4049.93", slPrice: "4049.50", digits: 2, stopLevel: 100 }), buy)).toBe("Stop loss must be at least 1 away from your bid (4049.93)");
    expect(slTpRefusalText(validateSlTp({ side: "SELL", referencePrice: "3950.30", tpPrice: "3951.00", digits: 2 }), positionRef("SELL", "3950.30"))).toBe("Take profit must be below your ask (3950.30) for a SELL");
    expect(slTpRefusalText(validateSlTp({ side: "BUY", referencePrice: "4100.00", tpPrice: "4090", digits: 2 }), orderRef("4100.00"))).toBe("Take profit must be above the entry price (4100.00) for a BUY");
  });

  it("the client answer carries that sentence as error and message; clientReason stays INVALID_SLTP; the internal text and the ref never leak", () => {
    const internal = { error: "SL must be below the reference price for a BUY", sltpRef: positionRef("BUY", "4049.93") };
    expect(clientRefusal(internal)).toEqual({ error: "Stop loss must be below your bid (4049.93) for a BUY", clientReason: "INVALID_SLTP", message: "Stop loss must be below your bid (4049.93) for a BUY" });
  });

  it("anything else stays as it was: no ref -> 'the current price'; an unknown SL / TP refusal -> the generic sentence", () => {
    expect(clientRefusal({ error: "SL must be below the reference price for a BUY" }).message).toBe("Stop loss must be below the current price for a BUY");
    expect(clientRefusal({ error: "break-even needs a profit" })).toEqual({ error: "Invalid SL or TP", clientReason: "INVALID_SLTP", message: "Invalid SL or TP" });
    expect(clientRefusal({ error: "NO_LIVE_FEED" }).clientReason).toBe("OFF_QUOTES");
  });
});
