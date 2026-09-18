// Talks to the same live /api/trade/* endpoints the real WebTrader uses --
// same reasoning as native-backoffice/src/api.rs's own top comment (no
// separate Rust trading-data layer exists yet). Login is by account
// number (MT-style), not email -- see app/api/trade/login/route.ts's own
// comment on why.
use eframe::egui;
use serde::{Deserialize, Serialize};
use std::sync::mpsc::Sender;

#[derive(Debug, Clone, Deserialize)]
pub struct AccountInfo {
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "accountMode")]
    pub account_mode: String,
    pub currency: String,
    pub leverage: i64,
    pub balance: String,
    pub credit: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SymbolInfo {
    pub id: String,
    pub name: String,
    pub category: String,
    pub digits: i64,
}

#[derive(Debug, Deserialize)]
struct WatchlistResponse {
    symbols: Vec<SymbolInfo>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PriceTick {
    pub symbol: String,
    pub bid: String,
    pub ask: String,
    #[serde(rename = "marketClosed", default)]
    pub market_closed: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Candle {
    pub open: String,
    pub high: String,
    pub low: String,
    pub close: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PositionRow {
    pub id: String,
    pub side: String,
    pub volume: String,
    #[serde(rename = "openPrice")]
    pub open_price: String,
    #[serde(rename = "slPrice")]
    pub sl_price: Option<String>,
    #[serde(rename = "tpPrice")]
    pub tp_price: Option<String>,
    pub status: String,
    #[serde(rename = "closePrice")]
    pub close_price: Option<String>,
    #[serde(rename = "realizedPnl")]
    pub realized_pnl: Option<String>,
    pub symbol: PositionSymbol,
    #[serde(rename = "openedAt")]
    pub opened_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PositionSymbol {
    pub name: String,
    pub digits: i64,
}

#[derive(Debug, Serialize)]
pub struct NewOrderBody {
    pub symbol: String,
    pub side: String,
    #[serde(rename = "type")]
    pub order_type: String,
    pub volume: String,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
    #[serde(rename = "slPrice", skip_serializing_if = "Option::is_none")]
    pub sl_price: Option<String>,
    #[serde(rename = "tpPrice", skip_serializing_if = "Option::is_none")]
    pub tp_price: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    error: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BrokerBranding {
    #[serde(rename = "brokerName")]
    pub broker_name: String,
    #[serde(rename = "brokerLogoUrl")]
    pub broker_logo_url: String,
    #[serde(rename = "primaryColor")]
    pub primary_color: Option<String>,
}

pub enum ApiEvent {
    LoginResult(Result<String, String>),
    AccountInfo(Result<AccountInfo, String>),
    Watchlist(Result<Vec<SymbolInfo>, String>),
    Prices(Result<Vec<PriceTick>, String>),
    Candles(Result<Vec<Candle>, String>),
    Positions(Result<Vec<PositionRow>, String>),
    History(Result<Vec<PositionRow>, String>),
    ActionDone(Result<String, String>),
    Branding(Result<BrokerBranding, String>),
    LogoImage(Result<(Vec<u8>, [usize; 2]), String>),
}

#[derive(Clone)]
pub struct ApiClient {
    client: reqwest::Client,
    base_url: String,
}

impl ApiClient {
    pub fn new(host: &str) -> Self {
        let client = reqwest::Client::builder().cookie_store(true).build().expect("failed to build reqwest client");
        Self { client, base_url: format!("https://{host}") }
    }

    async fn error_from_response(res: reqwest::Response) -> String {
        let status = res.status();
        match res.json::<ApiError>().await {
            Ok(body) => body.error,
            Err(_) => format!("request failed ({status})"),
        }
    }

    pub fn login(&self, ctx: egui::Context, tx: Sender<ApiEvent>, account_number: String, password: String) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/login", self.base_url);
        spawn(async move {
            let result = async {
                let res = client
                    .post(&url)
                    .json(&serde_json::json!({ "accountNumber": account_number, "password": password, "remember": true }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: serde_json::Value = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                if body.get("requiresTwoFactor").and_then(|v| v.as_bool()).unwrap_or(false) {
                    return Err("2FA-enabled accounts aren't supported in the native terminal yet -- use WebTrader for those.".to_string());
                }
                Ok(account_number.clone())
            }
            .await;
            let _ = tx.send(ApiEvent::LoginResult(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_account_info(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/me", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<AccountInfo>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::AccountInfo(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_watchlist(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/watchlist", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: WatchlistResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok(body.symbols)
            }
            .await;
            let _ = tx.send(ApiEvent::Watchlist(result));
            ctx.request_repaint();
        });
    }

    pub fn add_to_watchlist(&self, ctx: egui::Context, tx: Sender<ApiEvent>, symbol_id: String) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/watchlist", self.base_url);
        spawn(async move {
            let result = async {
                let res = client
                    .post(&url)
                    .json(&serde_json::json!({ "symbolId": symbol_id }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok("added to watchlist".to_string())
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn remove_from_watchlist(&self, ctx: egui::Context, tx: Sender<ApiEvent>, symbol_id: String) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/watchlist/{}", self.base_url, symbol_id);
        spawn(async move {
            let result = async {
                let res = client.delete(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok("removed from watchlist".to_string())
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_prices(&self, ctx: egui::Context, tx: Sender<ApiEvent>, symbols: Vec<String>) {
        if symbols.is_empty() {
            return;
        }
        let client = self.client.clone();
        let url = format!("{}/api/trade/prices?symbols={}", self.base_url, symbols.join(","));
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<PriceTick>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Prices(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_candles(&self, ctx: egui::Context, tx: Sender<ApiEvent>, symbol: String, timeframe: String) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/candles?symbol={}&tf={}", self.base_url, symbol, timeframe);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<Candle>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Candles(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_positions(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/positions", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<PositionRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Positions(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_history(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/history", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<PositionRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::History(result));
            ctx.request_repaint();
        });
    }

    pub fn place_order(&self, ctx: egui::Context, tx: Sender<ApiEvent>, body: NewOrderBody) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/orders", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.post(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(format!("{} {} {} submitted", body.side, body.volume, body.symbol))
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn close_position(&self, ctx: egui::Context, tx: Sender<ApiEvent>, position_id: String) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/positions/{}/close", self.base_url, position_id);
        spawn(async move {
            let result = async {
                let res = client.patch(&url).json(&serde_json::json!({})).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok("position closed".to_string())
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn modify_position(&self, ctx: egui::Context, tx: Sender<ApiEvent>, position_id: String, sl: Option<String>, tp: Option<String>) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/positions/{}", self.base_url, position_id);
        spawn(async move {
            let mut body = serde_json::Map::new();
            body.insert("slPrice".to_string(), sl.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
            body.insert("tpPrice".to_string(), tp.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null));
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::Value::Object(body))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok("position updated".to_string())
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_branding(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/trade/broker-branding", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<BrokerBranding>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Branding(result));
            ctx.request_repaint();
        });
    }

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

fn spawn<F: std::future::Future<Output = ()> + Send + 'static>(fut: F) {
    use std::sync::OnceLock;
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    let runtime = RUNTIME.get_or_init(|| tokio::runtime::Runtime::new().expect("failed to start tokio runtime"));
    runtime.spawn(fut);
}
