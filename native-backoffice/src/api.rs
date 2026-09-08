// Talks to the same live /api/manage/* endpoints the real Next.js
// backoffice's own client components call -- there is no separate Rust
// backend/DB layer serving this data today (engine/'s own README says so
// explicitly: "Postgres/NATS wiring... are Phase 2 work -- not started",
// pure unit-tested business logic with no I/O yet). This mirrors the
// proven reqwest-with-cookie-jar pattern manager-tauri's old ApiBridge
// used before it switched to loading the real page directly -- same
// reasoning, just now there IS no "real page" to load since this is a
// genuinely native, non-webview UI, so the HTTP call is this app's only
// way to reach real data at all.
//
// Runs every call on a background tokio runtime and reports back through
// an mpsc channel, since egui's own update() is called synchronously
// every frame and can't .await -- see app.rs's own ApiEvent handling.
use eframe::egui;
use serde::{Deserialize, Serialize};
use std::sync::mpsc::Sender;

#[derive(Debug, Clone, Deserialize)]
pub struct DashboardData {
    #[serde(rename = "totalClients")]
    pub total_clients: i64,
    #[serde(rename = "newClients7d")]
    pub new_clients_7d: i64,
    #[serde(rename = "depositsSum30d")]
    pub deposits_sum_30d: f64,
    #[serde(rename = "activeTrades")]
    pub active_trades: i64,
    #[serde(rename = "activeTradeAccountCount")]
    pub active_trade_account_count: i64,
    #[serde(rename = "pendingKyc")]
    pub pending_kyc: i64,
    #[serde(rename = "pendingWithdrawalCount")]
    pub pending_withdrawal_count: i64,
    #[serde(rename = "pendingWithdrawalSum")]
    pub pending_withdrawal_sum: f64,
    pub activity: Vec<ActivityRow>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityRow {
    #[serde(rename = "actionLabel")]
    pub action_label: String,
    #[serde(rename = "actorEmail")]
    pub actor_email: String,
    #[serde(rename = "createdAtLabel")]
    pub created_at_label: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountRow {
    pub id: String,
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
    pub email: String,
    #[serde(rename = "accountMode")]
    pub account_mode: String,
    pub currency: String,
    pub leverage: i64,
    pub balance: String,
    pub status: String,
    #[serde(rename = "groupName")]
    pub group_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PositionRow {
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "accountFullName")]
    pub account_full_name: String,
    #[serde(rename = "symbolName")]
    pub symbol_name: String,
    pub side: String,
    pub volume: String,
    #[serde(rename = "openPrice")]
    pub open_price: String,
    #[serde(rename = "currentPrice")]
    pub current_price: Option<String>,
    #[serde(rename = "floatingPnl")]
    pub floating_pnl: Option<String>,
    #[serde(rename = "openedAt")]
    pub opened_at: String,
}

#[derive(Debug, Deserialize)]
struct PositionsResponse {
    rows: Vec<PositionRow>,
}

#[derive(Debug, Serialize)]
struct LoginBody<'a> {
    email: &'a str,
    password: &'a str,
    remember: bool,
}

#[derive(Debug, Deserialize)]
struct LoginResponse {
    #[serde(rename = "requiresTwoFactor", default)]
    requires_two_factor: bool,
    #[serde(default)]
    role: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct NewAccountBody {
    #[serde(rename = "fullName")]
    pub full_name: String,
    pub email: String,
    pub password: String,
    #[serde(rename = "accountMode")]
    pub account_mode: String,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    error: String,
}

// --- Dealing ---
#[derive(Debug, Clone, Deserialize)]
pub struct DealingOrderRow {
    pub id: String,
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "accountFullName")]
    pub account_full_name: String,
    pub symbol: String,
    pub side: String,
    pub volume: String,
    #[serde(rename = "requestedPrice")]
    pub requested_price: Option<String>,
    #[serde(rename = "liveBid")]
    pub live_bid: Option<String>,
    #[serde(rename = "liveAsk")]
    pub live_ask: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DealingQueueResponse {
    rows: Vec<DealingOrderRow>,
}

// --- Groups ---
#[derive(Debug, Clone, Deserialize)]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub leverage: i64,
    pub tier: String,
    #[serde(rename = "groupType")]
    pub group_type: String,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GroupPricingRow {
    #[serde(rename = "symbolId")]
    pub symbol_id: String,
    #[serde(rename = "symbolName")]
    pub symbol_name: String,
    #[serde(rename = "hasOverride")]
    pub has_override: bool,
    #[serde(rename = "spreadMarkup")]
    pub spread_markup: Option<String>,
    #[serde(rename = "commissionPerLot")]
    pub commission_per_lot: Option<String>,
    #[serde(rename = "defaultSpreadMarkup")]
    pub default_spread_markup: String,
    #[serde(rename = "defaultCommissionPerLot")]
    pub default_commission_per_lot: String,
}

// --- Client KYC ---
#[derive(Debug, Clone, Deserialize)]
pub struct ClientKycRow {
    pub id: String,
    pub status: String,
    #[serde(rename = "documentType")]
    pub document_type: String,
    #[serde(rename = "clientFullName")]
    pub client_full_name: String,
    #[serde(rename = "clientEmail")]
    pub client_email: String,
    #[serde(rename = "clientCountry")]
    pub client_country: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// --- Live account requests ---
#[derive(Debug, Clone, Deserialize)]
pub struct LiveAccountRequestRow {
    pub id: String,
    pub status: String,
    #[serde(rename = "accountTypeName")]
    pub account_type_name: Option<String>,
    #[serde(rename = "clientFullName")]
    pub client_full_name: String,
    #[serde(rename = "clientEmail")]
    pub client_email: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// --- Notifications ---
#[derive(Debug, Clone, Deserialize)]
pub struct NotificationRow {
    // Not read anywhere yet -- this pass only wired mark-all-read
    // (main.rs's own comment on why); kept for the per-row mark-read/
    // delete actions the real /api/manage/notifications/[id] route
    // already supports, once that's wired here too.
    #[allow(dead_code)]
    pub id: String,
    #[serde(rename = "type")]
    pub notif_type: String,
    pub title: String,
    pub body: String,
    pub read: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// --- Risk radar (live exposure/behavior) ---
#[derive(Debug, Clone, Deserialize)]
pub struct RiskRadarRow {
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "trades30d")]
    pub trades_30d: i64,
    #[serde(rename = "winRatePct")]
    pub win_rate_pct: Option<f64>,
    #[serde(rename = "avgLot")]
    pub avg_lot: Option<f64>,
    #[serde(rename = "profitVelocityPerDay")]
    pub profit_velocity_per_day: f64,
    #[serde(rename = "scalpFlag")]
    pub scalp_flag: bool,
    #[serde(rename = "martingaleFlag")]
    pub martingale_flag: bool,
}

// --- Settings ---
#[derive(Debug, Clone, Deserialize)]
pub struct SettingsData {
    pub name: String,
    #[serde(rename = "defaultAccountCurrency")]
    pub default_account_currency: String,
    #[serde(rename = "defaultAccountLeverage")]
    pub default_account_leverage: i64,
}

// --- per-tenant branding (/api/manage/shell-info) ---
#[derive(Debug, Clone, Deserialize)]
pub struct ShellInfo {
    #[serde(rename = "brokerName")]
    pub broker_name: String,
    #[serde(rename = "brokerLogoUrl")]
    pub broker_logo_url: Option<String>,
    #[serde(rename = "brokerPrimaryColor")]
    pub broker_primary_color: Option<String>,
}

pub enum ApiEvent {
    LoginResult(Result<String, String>),
    Dashboard(Result<DashboardData, String>),
    Accounts(Result<Vec<AccountRow>, String>),
    Positions(Result<Vec<PositionRow>, String>),
    DealingQueue(Result<Vec<DealingOrderRow>, String>),
    Groups(Result<Vec<GroupRow>, String>),
    GroupPricing(Result<Vec<GroupPricingRow>, String>),
    ClientKyc(Result<Vec<ClientKycRow>, String>),
    LiveAccountRequests(Result<Vec<LiveAccountRequestRow>, String>),
    Notifications(Result<Vec<NotificationRow>, String>),
    RiskRadar(Result<Vec<RiskRadarRow>, String>),
    Settings(Result<SettingsData, String>),
    ShellInfo(Result<ShellInfo, String>),
    // Raw decoded RGBA pixels for the broker's logo, ready for
    // egui::ColorImage::from_rgba_unmultiplied -- decoded here (not on
    // the UI thread) since image decoding is exactly the kind of work
    // this background-task/channel pattern exists to keep off it.
    LogoImage(Result<(Vec<u8>, [usize; 2]), String>),
    // Generic "an action completed" signal (create/update account, dealing
    // accept/reject, KYC/live-account approve/reject, pricing save, mark-
    // all-read, settings save) -- the screen that triggered it just
    // re-fetches its own list on success rather than threading the
    // changed row back through its own variant.
    ActionDone(Result<String, String>),
}

#[derive(Clone)]
pub struct ApiClient {
    client: reqwest::Client,
    base_url: String,
}

impl ApiClient {
    pub fn new(host: &str) -> Self {
        let client = reqwest::Client::builder()
            .cookie_store(true)
            .build()
            .expect("failed to build reqwest client");
        Self { client, base_url: format!("https://{host}") }
    }

    async fn error_from_response(res: reqwest::Response) -> String {
        let status = res.status();
        match res.json::<ApiError>().await {
            Ok(body) => body.error,
            Err(_) => format!("request failed ({status})"),
        }
    }

    pub fn login(&self, ctx: egui::Context, tx: Sender<ApiEvent>, email: String, password: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/login", self.base_url);
        spawn(async move {
            let result = async {
                let res = client
                    .post(&url)
                    .json(&LoginBody { email: &email, password: &password, remember: true })
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: LoginResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                if body.requires_two_factor {
                    return Err("2FA-enabled accounts aren't supported in the native app yet -- use the web backoffice or disable 2FA for this account.".to_string());
                }
                Ok(body.role.unwrap_or_default())
            }
            .await;
            let _ = tx.send(ApiEvent::LoginResult(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_dashboard(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/dashboard", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<DashboardData>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Dashboard(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_accounts(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/accounts", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<AccountRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Accounts(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_positions(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/positions", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: PositionsResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok(body.rows)
            }
            .await;
            let _ = tx.send(ApiEvent::Positions(result));
            ctx.request_repaint();
        });
    }

    pub fn create_account(&self, ctx: egui::Context, tx: Sender<ApiEvent>, body: NewAccountBody) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/accounts", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.post(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(format!("account created for {}", body.email))
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn set_account_status(&self, ctx: egui::Context, tx: Sender<ApiEvent>, account_id: String, status: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/accounts/{}", self.base_url, account_id);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({ "status": status }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(format!("status set to {status}"))
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_dealing_queue(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/dealing-queue", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: DealingQueueResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok(body.rows)
            }
            .await;
            let _ = tx.send(ApiEvent::DealingQueue(result));
            ctx.request_repaint();
        });
    }

    // action: "ACCEPT" or "REJECT" -- REQUOTE isn't supported by this
    // native pass (see main.rs's own dealing screen comment).
    pub fn dealing_action(&self, ctx: egui::Context, tx: Sender<ApiEvent>, order_id: String, action: String, reason: Option<String>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/dealing-queue/{}", self.base_url, order_id);
        spawn(async move {
            let mut body = serde_json::json!({ "action": action });
            if let Some(reason) = &reason {
                body["reason"] = serde_json::Value::String(reason.clone());
            }
            let result = async {
                let res = client.patch(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(format!("order {action_lower}", action_lower = action.to_lowercase()))
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_groups(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/groups", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<GroupRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Groups(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_group_pricing(&self, ctx: egui::Context, tx: Sender<ApiEvent>, group_id: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/groups/{}/pricing", self.base_url, group_id);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<GroupPricingRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::GroupPricing(result));
            ctx.request_repaint();
        });
    }

    // Only spreadMarkup/commissionPerLot -- see main.rs's own groups
    // screen comment on why swap/targetTotalSpreadPips aren't in this pass.
    pub fn update_group_pricing(
        &self,
        ctx: egui::Context,
        tx: Sender<ApiEvent>,
        group_id: String,
        symbol_id: String,
        spread_markup: String,
        commission_per_lot: String,
    ) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/groups/{}/pricing", self.base_url, group_id);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({
                        "symbolId": symbol_id,
                        "spreadMarkup": spread_markup,
                        "commissionPerLot": commission_per_lot,
                    }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok("pricing saved".to_string())
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_client_kyc(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/client-kyc-requests", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<ClientKycRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::ClientKyc(result));
            ctx.request_repaint();
        });
    }

    pub fn client_kyc_action(&self, ctx: egui::Context, tx: Sender<ApiEvent>, record_id: String, action: String, rejection_reason: Option<String>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/client-kyc-requests/{}", self.base_url, record_id);
        spawn(async move {
            let mut body = serde_json::json!({ "action": action });
            if let Some(reason) = &rejection_reason {
                body["rejectionReason"] = serde_json::Value::String(reason.clone());
            }
            let result = async {
                let res = client.patch(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(format!("KYC {}", action.to_lowercase()))
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_live_account_requests(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/live-account-requests", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<LiveAccountRequestRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::LiveAccountRequests(result));
            ctx.request_repaint();
        });
    }

    pub fn live_account_request_action(
        &self,
        ctx: egui::Context,
        tx: Sender<ApiEvent>,
        request_id: String,
        action: String,
        rejection_reason: Option<String>,
    ) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/live-account-requests/{}", self.base_url, request_id);
        spawn(async move {
            let mut body = serde_json::json!({ "action": action });
            if let Some(reason) = &rejection_reason {
                body["rejectionReason"] = serde_json::Value::String(reason.clone());
            }
            let result = async {
                let res = client.patch(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(format!("live account request {}", action.to_lowercase()))
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_notifications(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/notifications", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<NotificationRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Notifications(result));
            ctx.request_repaint();
        });
    }

    pub fn mark_all_notifications_read(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/notifications", self.base_url);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({ "markAllRead": true }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok("all notifications marked read".to_string())
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_risk_radar(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/risk-radar", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<RiskRadarRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::RiskRadar(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_settings(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/settings", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<SettingsData>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Settings(result));
            ctx.request_repaint();
        });
    }

    pub fn update_default_leverage(&self, ctx: egui::Context, tx: Sender<ApiEvent>, leverage: i64) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/settings", self.base_url);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({ "defaultAccountLeverage": leverage }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok("settings saved".to_string())
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_shell_info(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/shell-info", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<ShellInfo>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::ShellInfo(result));
            ctx.request_repaint();
        });
    }

    // Broker.logoUrl points at Vercel Blob storage (a plain public HTTPS
    // URL, no auth needed) -- fetched and decoded on this same background
    // runtime rather than the UI thread, same reasoning as every other
    // call here. Uses this client's own cookie-jar-bearing reqwest
    // instance for consistency, though the logo URL itself doesn't
    // actually require the session cookie.
    pub fn fetch_logo(&self, ctx: egui::Context, tx: Sender<ApiEvent>, url: String) {
        let client = self.client.clone();
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(format!("logo request failed ({})", res.status()));
                }
                let bytes = res.bytes().await.map_err(|e| format!("failed to read logo bytes: {e}"))?;
                let decoded = image::load_from_memory(&bytes).map_err(|e| format!("failed to decode logo image: {e}"))?.to_rgba8();
                let size = [decoded.width() as usize, decoded.height() as usize];
                Ok((decoded.into_raw(), size))
            }
            .await;
            let _ = tx.send(ApiEvent::LogoImage(result));
            ctx.request_repaint();
        });
    }
}

// One tokio runtime for the whole app's lifetime, spun up lazily on first
// use -- a plain std::thread rather than block_on'ing on egui's own UI
// thread, which must stay free to keep rendering every frame.
fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(fut: F) {
    use std::sync::OnceLock;
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| tokio::runtime::Runtime::new().expect("failed to start tokio runtime"));
    runtime.spawn(fut);
}
