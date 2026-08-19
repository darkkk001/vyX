// POST /v1/positions/:id/modify — edits an open position's SL/TP.
// Mirrors orders.ts's shape exactly; forwards to engine/server's
// /v1/positions/{id}/modify (order_management::modify_position_sl_tp),
// which already rejects with NotFound if the position's own account_id
// doesn't match what this Gateway sends.

import { Router } from "express";
import type { AuthedRequest } from "../auth.js";
import { requireTraderSession } from "../auth.js";
import { rateLimitOrders } from "../rate-limit.js";
import { getAccount, writeAuditLog } from "../db.js";
import { parseUpstreamJson } from "../http.js";
import { modifyPositionSchema, validateBody } from "../validation.js";
import type { z } from "zod";

const router = Router();

const TRADING_CORE_URL = process.env.TRADING_CORE_URL ?? "http://127.0.0.1:8081";
const INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET ?? "";

type ModifyPositionBody = z.infer<typeof modifyPositionSchema>;

router.post(
  "/:id/modify",
  requireTraderSession,
  rateLimitOrders(30, 60),
  validateBody(modifyPositionSchema),
  async (req: AuthedRequest, res) => {
    const body = req.body as ModifyPositionBody;
    const session = req.session!;
    const brokerId = req.headers["x-broker-id"] as string;

    const account = await getAccount(session.accountId, brokerId);
    if (!account) {
      res.status(404).json({ error: "account not found" });
      return;
    }
    if (account.status !== "ACTIVE") {
      res.status(403).json({ error: "account is not active" });
      return;
    }

    const payload = {
      account_id: session.accountId,
      current_price: body.current_price,
      sl_price: body.sl_price,
      tp_price: body.tp_price,
    };

    const positionId = req.params.id as string;
    const upstream = await fetch(`${TRADING_CORE_URL}/v1/positions/${encodeURIComponent(positionId)}/modify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SERVICE_SECRET },
      body: JSON.stringify(payload),
    });

    const data = await parseUpstreamJson(upstream);
    if (upstream.ok) {
      await writeAuditLog({
        brokerId,
        action: "GATEWAY_POSITION_MODIFIED",
        entityType: "Position",
        entityId: positionId,
        newValue: { accountId: session.accountId, slPrice: body.sl_price, tpPrice: body.tp_price, result: data },
      }).catch((err) => console.error("audit log write failed", err));
    }
    res.status(upstream.status).json(data);
  }
);

export default router;
