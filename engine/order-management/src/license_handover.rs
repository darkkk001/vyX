//! The real [`crate::license_gate::Handover`]: the three steps against the database and the platform.
//!
//! The ordering and every "may risk stop yet?" decision live in `license_gate`, which is why that
//! module has no database and no HTTP in it. This one only knows how to perform a step.
//!
//! ## Why the confirmation has its own route
//!
//! The web's existing minute-by-minute fallback (`/api/internal/risk-fallback`) already answers
//! `ran: true` when it has run a full margin pass, which is exactly the evidence wanted -- but it is
//! authorised with `CRON_SECRET`, the cron's key to every internal cron route, and an engine has no
//! business holding that. So the confirmation goes to a purpose-made route authorised with the
//! `INTERNAL_SERVICE_SECRET` the engine already has:
//!
//!   GET {web}/api/internal/risk-handover      -> { "tookOver": bool, "accountsEvaluated": n, ... }
//!
//! which refuses unless this engine's heartbeat really is not-alive, then runs the web's own full
//! margin pass and says so. The refusal matters: it stops an engine from being told "the web has taken
//! over" while the engine is still beating and still acting, which would let both act at once.

use crate::license_gate::Handover;
use sqlx::PgPool;

/// What the engine needs to hand risk authority over, FOR ONE SUBJECT -- the whole engine, or one
/// broker. One of these per subject, because the two releases are different acts:
///
///   * the ENGINE's release puts the heartbeat down, which releases every broker at once;
///   * a BROKER's release sets that broker's `riskAuthority` to WEB, which releases exactly it and
///     leaves the engine serving the rest.
///
/// Both go through the web: the engine asks, and the control-plane write happens server-side.
pub struct WebHandover {
    pub subject: crate::license_fleet::Subject,
    pub pool: PgPool,
    pub client: reqwest::Client,
    /// `{web}/api/internal/risk-handover`
    pub handover_url: String,
    pub secret: String,
    /// This engine's own id, for the audit trail and for the route's log line.
    pub engine_id: String,
    /// The license reason that caused the stop (revoked / expired / machine / grace exhausted).
    pub reason: String,
}

/// The audit action the intent is written under. One string, so a query for "has an engine ever handed
/// its risk over, and when" is one WHERE.
pub const HANDOVER_ACTION: &str = "ENGINE_RISK_HANDOVER_INTENT";

impl WebHandover {
    /// The brokers whose risk this engine currently holds -- the ones the handover is ABOUT. Scoped by
    /// the broker assignment when one is installed, so a regional engine names only its own.
    async fn brokers_held(&self) -> Result<Vec<String>, sqlx::Error> {
        if let crate::license_fleet::Subject::Broker(id) = &self.subject {
            return Ok(vec![id.clone()]);
        }
        let scope = protocol::broker_scope::assigned();
        let sql = crate::authority::authority_cache_sql(scope.as_deref());
        let mut q = sqlx::query_as::<_, (String, bool)>(&sql);
        if let Some(ids) = &scope {
            q = q.bind(ids.clone());
        }
        Ok(q.fetch_all(&self.pool).await?.into_iter().map(|(id, _)| id).collect())
    }
}

impl Handover for WebHandover {
    /// Step 1: the intent, durable, before anything moves. ONE ROW PER BROKER whose risk is being
    /// handed over, because that is the question someone will ask afterwards -- not "did an engine
    /// stop" but "whose accounts changed hands, and when".
    ///
    /// A fresh id per attempt on purpose: a retry after a failure is a real event and the trail should
    /// show both, rather than one row quietly overwritten.
    async fn record_intent(&self) -> Result<(), String> {
        let brokers = self.brokers_held().await.map_err(|e| format!("could not read the brokers held: {e}"))?;
        if brokers.is_empty() {
            // Nothing is held, so there is nothing to record and nothing to hand over. Not an error:
            // the gate still runs the release and the confirmation, which are cheap and idempotent.
            tracing::warn!(engine = %self.engine_id, "risk handover: this engine holds no broker's risk; recording no intent");
            return Ok(());
        }
        let payload = serde_json::json!({
            "engineId": self.engine_id,
            "reason": self.reason,
            "brokers": brokers,
            "note": "license stop: the engine is handing its risk authority to the web and will not stop acting until the web confirms it took over",
        })
        .to_string();
        for broker in &brokers {
            sqlx::query(
                r#"INSERT INTO "AuditLog" (id, "brokerId", action, "entityType", "entityId", "newValue", "createdAt")
                   VALUES ($1, $2, $3, 'Broker', $2, $4::jsonb, now())"#,
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(broker)
            .bind(HANDOVER_ACTION)
            .bind(&payload)
            .execute(&self.pool)
            .await
            .map_err(|e| format!("could not write the handover intent for {broker}: {e}"))?;
        }
        tracing::error!(
            engine = %self.engine_id, reason = %self.reason, brokers = brokers.len(),
            "LICENSE STOP: risk handover intent recorded for {} broker(s). New orders are already refused; risk evaluation CONTINUES until the web confirms it has taken over.",
            brokers.len()
        );
        Ok(())
    }

    /// Step 2: the release. Making the heartbeat not-alive IS the release -- the web's takeover is
    /// heartbeat-driven, so there is nothing to flip on `Broker` and no new state to keep in step.
    ///
    /// `beatAt` is pushed a full `staleAfterSecs` plus a minute into the past rather than simply
    /// stopping the beat: stopping would leave the web waiting out the staleness window, and during
    /// that window neither side would consider itself the owner.
    async fn release_authority(&self) -> Result<(), String> {
        // A BROKER'S RELEASE IS NOT THE HEARTBEAT. The heartbeat is engine-wide, so putting it down
        // for one broker's licence would release every other broker with it. The per-broker release
        // asks the web to set that broker's riskAuthority to WEB -- the thing its owner rule already
        // reads -- and the web does the write, as it does every control-plane write.
        if let crate::license_fleet::Subject::Broker(id) = &self.subject {
            let res = self
                .client
                .post(format!("{}?brokerId={id}", self.handover_url))
                .header("x-internal-secret", &self.secret)
                .header("x-engine-id", &self.engine_id)
                .send()
                .await
                .map_err(|e| format!("could not ask the web to take broker {id}: {e}"))?;
            if !res.status().is_success() {
                return Err(format!("the web refused to take broker {id}: {}", res.status()));
            }
            tracing::warn!(broker = %id, "risk handover: broker released to the web (riskAuthority set to WEB by the platform)");
            return Ok(());
        }
        let n = sqlx::query(
            r#"UPDATE "RiskEngineHeartbeat"
                  SET "beatAt" = clock_timestamp() - make_interval(secs => "staleAfterSecs" + 60)
                WHERE name = 'risk'"#,
        )
        .execute(&self.pool)
        .await
        .map_err(|e| format!("could not release the heartbeat: {e}"))?
        .rows_affected();
        if n == 0 {
            // No row means nothing ever claimed authority through it; the web already owns everything.
            tracing::warn!("risk handover: no 'risk' heartbeat row to release -- the web already owns every account");
        } else {
            tracing::warn!("risk handover: heartbeat released (beatAt pushed past staleAfterSecs); the web now owns every RUST account");
        }
        Ok(())
    }

    /// Step 3: the confirmation. `Ok(false)` for every answer that is not a positive "I took over" --
    /// unreachable, a 5xx, a refusal, a body that does not say so. Only `Err` for something that is
    /// worth reporting as broken rather than as not-yet.
    async fn confirm_web_took_over(&self) -> Result<bool, String> {
        let res = self
            .client
            .get(match &self.subject {
                crate::license_fleet::Subject::Engine => self.handover_url.clone(),
                crate::license_fleet::Subject::Broker(id) => format!("{}?brokerId={id}", self.handover_url),
            })
            // x-internal-secret, NOT a bearer: that is the gate every other /api/internal route uses
            // (lib/internal-auth.ts secretMatches), and the engine already holds this secret.
            .header("x-internal-secret", &self.secret)
            .header("x-engine-id", &self.engine_id)
            .send()
            .await;
        let res = match res {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "risk handover: the web could not be reached; risk evaluation stays on");
                return Ok(false);
            }
        };
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if !status.is_success() {
            tracing::warn!(%status, body = %body.chars().take(200).collect::<String>(),
                "risk handover: the web did not confirm; risk evaluation stays on");
            return Ok(false);
        }
        let parsed: serde_json::Value = match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(e) => return Err(format!("the web's answer was not JSON: {e}")),
        };
        let took_over = parsed.get("tookOver").and_then(|v| v.as_bool()).unwrap_or(false);
        let evaluated = parsed.get("accountsEvaluated").and_then(|v| v.as_u64()).unwrap_or(0);
        if took_over {
            tracing::warn!(accounts = evaluated, "risk handover CONFIRMED: the web ran a full margin pass as owner; the engine may now stop evaluating risk");
        } else {
            tracing::warn!(body = %body.chars().take(200).collect::<String>(),
                "risk handover: the web answered but has not taken over yet; risk evaluation stays on");
        }
        Ok(took_over)
    }
}
