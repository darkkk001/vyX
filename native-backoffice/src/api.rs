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
    #[serde(rename = "accountTypeId")]
    pub account_type_id: Option<String>,
    #[serde(rename = "accountTypeName")]
    pub account_type_name: Option<String>,
    pub currency: String,
    pub leverage: i64,
    pub balance: String,
    pub credit: String,
    pub status: String,
    #[serde(rename = "groupId")]
    pub group_id: Option<String>,
    #[serde(rename = "groupName")]
    pub group_name: Option<String>,
    #[serde(rename = "maxDailyLoss")]
    pub max_daily_loss: Option<String>,
    // Tri-state: Some(true)=swap-free, Some(false)=charge swap, None=inherit.
    #[serde(rename = "swapFree")]
    pub swap_free: Option<bool>,
    pub country: Option<String>,
    #[serde(rename = "kycStatus")]
    pub kyc_status: Option<String>,
    pub mirror: Option<MirrorInfo>,
    #[serde(rename = "hasCustomPricing", default)]
    pub has_custom_pricing: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MirrorInfo {
    pub direction: String,
    pub multiplier: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AccountTypeOption {
    pub id: String,
    pub name: String,
    #[serde(rename = "pricingHint")]
    pub pricing_hint: Option<String>,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PendingAdjustment {
    pub id: String,
    pub status: String,
    pub amount: String,
    pub note: String,
    #[serde(rename = "requestedByName")]
    pub requested_by_name: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub account: PendingAdjustmentAccount,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PendingAdjustmentAccount {
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
    pub balance: String,
}

#[derive(Debug, Deserialize)]
struct CreateAccountResponse {
    #[serde(rename = "accountNumber")]
    account_number: String,
}

#[derive(Debug, Deserialize)]
struct ResetPasswordResponse {
    password: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PositionRow {
    pub id: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "accountFullName")]
    pub account_full_name: String,
    #[serde(rename = "groupId")]
    pub group_id: Option<String>,
    #[serde(rename = "groupName")]
    pub group_name: Option<String>,
    #[serde(rename = "ibAccountId")]
    pub ib_account_id: Option<String>,
    #[serde(rename = "symbolName")]
    pub symbol_name: String,
    #[serde(default)]
    pub digits: i64,
    pub side: String,
    pub volume: String,
    #[serde(rename = "openPrice")]
    pub open_price: String,
    #[serde(rename = "currentPrice")]
    pub current_price: Option<String>,
    #[serde(rename = "floatingPnl")]
    pub floating_pnl: Option<String>,
    #[serde(rename = "slPrice")]
    pub sl_price: Option<String>,
    #[serde(rename = "tpPrice")]
    pub tp_price: Option<String>,
    #[serde(default)]
    pub mirrored: bool,
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
    #[serde(rename = "accountTypeId", skip_serializing_if = "Option::is_none")]
    pub account_type_id: Option<String>,
    pub currency: String,
    #[serde(rename = "groupId", skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub leverage: Option<f64>,
    #[serde(rename = "initialBalance")]
    pub initial_balance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    #[serde(rename = "dateOfBirth", skip_serializing_if = "Option::is_none")]
    pub date_of_birth: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
pub struct RequotedOrderRow {
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
    #[serde(rename = "requotedPrice")]
    pub requoted_price: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct DealingQueueResponse {
    rows: Vec<DealingOrderRow>,
    #[serde(rename = "requotedRows", default)]
    requoted_rows: Vec<RequotedOrderRow>,
}

// --- Dealer ON/OFF toggle (GET/PATCH /api/manage/dealing-desk-toggle) ---
#[derive(Debug, Clone, Deserialize)]
pub struct DealerToggleState {
    #[serde(rename = "dealerOn")]
    pub dealer_on: bool,
    #[serde(default)]
    pub filled: usize,
    #[serde(default)]
    pub skipped: usize,
}

#[derive(Debug, Deserialize)]
struct DealerToggleGetResponse {
    #[serde(rename = "dealerOn")]
    dealer_on: bool,
}

#[derive(Debug, Deserialize)]
struct FlushedFill {
    #[serde(default)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct DealerTogglePatchResponse {
    #[serde(rename = "dealerOn")]
    dealer_on: bool,
    #[serde(default)]
    flushed: Vec<FlushedFill>,
}

// --- Dealing desk panel: DEALING-group resting orders + scoped activity
// feed (GET /api/manage/dealing-desk) ---
#[derive(Debug, Clone, Deserialize)]
pub struct DealingDeskAccount {
    pub id: String,
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RestingOrderRow {
    #[serde(rename = "orderId")]
    pub order_id: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "accountFullName")]
    pub account_full_name: String,
    pub symbol: String,
    #[serde(default)]
    pub digits: i64,
    pub side: String,
    pub volume: String,
    #[serde(rename = "orderType")]
    pub order_type: String,
    #[serde(rename = "requestedPrice")]
    pub requested_price: Option<String>,
    #[serde(rename = "slPrice")]
    pub sl_price: Option<String>,
    #[serde(rename = "tpPrice")]
    pub tp_price: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// Live activity / dealer-activity feed row -- shared shape for both
// /api/manage/live-activity (broker-wide, Live Exposure) and the
// feedRows returned by /api/manage/dealing-desk (DEALING-group only).
// `values` is left as a raw JSON blob (matches the web's own loosely-typed
// Record<string, unknown>) and rendered with a small ad hoc describer
// instead of a fully-typed struct per action.
#[derive(Debug, Clone, Deserialize)]
pub struct ActivityFeedRow {
    pub id: String,
    pub at: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "accountFullName")]
    pub account_full_name: String,
    #[serde(rename = "isDealingGroup", default)]
    pub is_dealing_group: bool,
    pub action: String,
    pub symbol: Option<String>,
    pub side: Option<String>,
    pub volume: Option<String>,
    #[serde(default)]
    pub values: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct DealingDeskResponse {
    accounts: Vec<DealingDeskAccount>,
    #[serde(rename = "restingOrders")]
    resting_orders: Vec<RestingOrderRow>,
    #[serde(rename = "feedRows")]
    feed_rows: Vec<ActivityFeedRow>,
}

#[derive(Debug, Deserialize)]
struct LiveActivityResponse {
    rows: Vec<ActivityFeedRow>,
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
    #[serde(rename = "marginCallLevel", default)]
    pub margin_call_level: String,
    #[serde(rename = "stopOutLevel", default)]
    pub stop_out_level: String,
    #[serde(rename = "maxLotSize", default)]
    pub max_lot_size: String,
    #[serde(rename = "tradingRestriction", default)]
    pub trading_restriction: String,
    #[serde(rename = "dealingMode", default)]
    pub dealing_mode: String,
    #[serde(rename = "forceDealingMode", default)]
    pub force_dealing_mode: bool,
    #[serde(rename = "swapFree", default)]
    pub swap_free: Option<bool>,
    #[serde(rename = "hasMirrorRule", default)]
    pub has_mirror_rule: bool,
}

// Shared 5-field per-symbol pricing shape (spreadMarkup/
// targetTotalSpreadPips are mutually exclusive per row, see
// components/manage/SymbolPricingEditor.tsx's own comment) -- same
// GET/PATCH shape across Group/AccountType/Account pricing editors.
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
    #[serde(rename = "targetTotalSpreadPips")]
    pub target_total_spread_pips: Option<String>,
    #[serde(rename = "commissionPerLot")]
    pub commission_per_lot: Option<String>,
    #[serde(rename = "swapLong")]
    pub swap_long: Option<String>,
    #[serde(rename = "swapShort")]
    pub swap_short: Option<String>,
    #[serde(rename = "defaultSpreadMarkup")]
    pub default_spread_markup: Option<String>,
    #[serde(rename = "defaultCommissionPerLot")]
    pub default_commission_per_lot: Option<String>,
    #[serde(rename = "defaultSwapLong")]
    pub default_swap_long: Option<String>,
    #[serde(rename = "defaultSwapShort")]
    pub default_swap_short: Option<String>,
}

// --- Client KYC ---
#[derive(Debug, Clone, Deserialize)]
pub struct KycRow {
    pub id: String,
    pub status: String,
    #[serde(rename = "documentType")]
    pub document_type: String,
    #[serde(rename = "rejectionReason")]
    pub rejection_reason: Option<String>,
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "accountFullName")]
    pub account_full_name: String,
    #[serde(rename = "accountCountry")]
    pub account_country: Option<String>,
    #[serde(rename = "accountPhone")]
    pub account_phone: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClientKycRow {
    pub id: String,
    pub status: String,
    #[serde(rename = "documentType")]
    pub document_type: String,
    #[serde(rename = "rejectionReason")]
    pub rejection_reason: Option<String>,
    #[serde(rename = "hasAddressProof", default)]
    pub has_address_proof: bool,
    #[serde(rename = "annualIncome")]
    pub annual_income: Option<String>,
    #[serde(rename = "sourceOfFunds")]
    pub source_of_funds: Option<String>,
    #[serde(rename = "tradingExperience")]
    pub trading_experience: Option<String>,
    #[serde(rename = "employmentStatus")]
    pub employment_status: Option<String>,
    #[serde(rename = "riskTolerance")]
    pub risk_tolerance: Option<String>,
    #[serde(rename = "clientFullName")]
    pub client_full_name: String,
    #[serde(rename = "clientEmail")]
    pub client_email: String,
    #[serde(rename = "clientCountry")]
    pub client_country: Option<String>,
    #[serde(rename = "clientPhone")]
    pub client_phone: Option<String>,
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
    pub id: String,
    #[serde(rename = "type")]
    pub notif_type: String,
    pub title: String,
    pub body: String,
    #[serde(rename = "entityType")]
    pub entity_type: Option<String>,
    #[serde(rename = "entityId")]
    pub entity_id: Option<String>,
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
    #[serde(rename = "canManageFinance", default)]
    pub can_manage_finance: bool,
}

// --- Reports ---
#[derive(Debug, Clone, Deserialize)]
pub struct ReportsSummary {
    #[serde(rename = "tradingVolume")]
    pub trading_volume: f64,
    #[serde(rename = "commissionRevenue")]
    pub commission_revenue: f64,
    #[serde(rename = "netDeposits")]
    pub net_deposits: f64,
    #[serde(rename = "newClients")]
    pub new_clients: i64,
}

// --- Symbols ---
#[derive(Debug, Clone, Deserialize)]
pub struct SymbolConfigRow {
    #[serde(rename = "symbolName")]
    pub symbol_name: String,
    pub category: String,
    pub enabled: bool,
    #[serde(rename = "spreadMarkup")]
    pub spread_markup: String,
    #[serde(rename = "commissionPerLot")]
    pub commission_per_lot: String,
}

// --- Team (admins) ---
#[derive(Debug, Clone, Deserialize)]
pub struct AdminRow {
    pub id: String,
    pub email: String,
    pub role: String,
    pub status: String,
    #[serde(rename = "lastLoginAt")]
    pub last_login_at: Option<String>,
}

// --- Transfers ---
#[derive(Debug, Clone, Deserialize)]
pub struct TransferRow {
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "type")]
    pub transfer_type: String,
    pub amount: String,
    pub note: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

// --- IB relationships ---
#[derive(Debug, Clone, Deserialize)]
pub struct IbRelationshipRow {
    #[serde(rename = "ibAccountNumber")]
    pub ib_account_number: String,
    #[serde(rename = "ibAccountFullName")]
    pub ib_account_full_name: String,
    #[serde(rename = "clientAccountNumber")]
    pub client_account_number: String,
    #[serde(rename = "clientAccountFullName")]
    pub client_account_full_name: String,
    #[serde(rename = "commissionType")]
    pub commission_type: String,
}

// --- Leads ---
#[derive(Debug, Clone, Deserialize)]
pub struct LeadRow {
    // Not read anywhere yet -- this pass's Leads screen is list-only, no
    // per-row action (convert-to-account, status change) wired here.
    #[allow(dead_code)]
    pub id: String,
    #[serde(rename = "fullName")]
    pub full_name: String,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub status: String,
    pub source: Option<String>,
}

// --- Deals (closed/voided positions) ---
#[derive(Debug, Clone, Deserialize)]
pub struct DealRow {
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    pub symbol: String,
    pub side: String,
    pub status: String,
    pub volume: String,
    #[serde(rename = "closePrice")]
    pub close_price: String,
    #[serde(rename = "realizedPnl")]
    pub realized_pnl: String,
    #[serde(rename = "closedAt")]
    pub closed_at: String,
}

// --- Audit log ---
#[derive(Debug, Clone, Deserialize)]
pub struct AuditLogRow {
    #[serde(rename = "actorEmail")]
    pub actor_email: String,
    #[serde(rename = "actionLabel")]
    pub action_label: String,
    #[serde(rename = "entityType")]
    pub entity_type: String,
    #[serde(rename = "createdAtLabel")]
    pub created_at_label: String,
}

// --- Funds requests (deposits/withdrawals) ---
#[derive(Debug, Clone, Deserialize)]
pub struct FundsRequestRow {
    pub id: String,
    #[serde(rename = "type")]
    pub request_type: String,
    pub status: String,
    pub amount: String,
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "accountFullName")]
    pub account_full_name: String,
}

#[derive(Debug, Deserialize)]
struct FundsRequestsResponse {
    rows: Vec<FundsRequestRow>,
}

// --- Payment methods ---
#[derive(Debug, Clone, Deserialize)]
pub struct PaymentMethodRow {
    #[serde(rename = "type")]
    pub method_type: String,
    pub enabled: bool,
    #[serde(rename = "minAmount")]
    pub min_amount: String,
    #[serde(rename = "feePercent")]
    pub fee_percent: String,
}

// --- Margin ---
#[derive(Debug, Clone, Deserialize)]
pub struct MarginRow {
    #[serde(rename = "accountNumber")]
    pub account_number: String,
    #[serde(rename = "positionCount")]
    pub position_count: i64,
    pub exposure: String,
    #[serde(rename = "floatingPnl")]
    pub floating_pnl: String,
    #[serde(rename = "marginLevel")]
    pub margin_level: Option<f64>,
    #[serde(rename = "marginCallLevel", default)]
    pub margin_call_level: f64,
    #[serde(rename = "stopOutLevel", default)]
    pub stop_out_level: f64,
}

// --- Liquidity (book exposure) ---
#[derive(Debug, Clone, Deserialize)]
pub struct LiquidityExposureRow {
    pub symbol: String,
    #[serde(rename = "aBookVolume")]
    pub a_book_volume: String,
    #[serde(rename = "bBookVolume")]
    pub b_book_volume: String,
}

// --- Liquidity routing rules ---
#[derive(Debug, Clone, Deserialize)]
pub struct LpRoutingRow {
    #[serde(rename = "liquidityProviderName")]
    pub liquidity_provider_name: String,
    #[serde(rename = "liquidityProviderStatus")]
    pub liquidity_provider_status: String,
    #[serde(rename = "symbolName")]
    pub symbol_name: Option<String>,
    pub priority: i64,
}

// --- Feed health (proxies the Rust trading core/gateway -- usually
// unreachable today, see engine/'s own Phase-1-scaffold status) ---
#[derive(Debug, Clone, Deserialize)]
pub struct FeedHealthData {
    #[serde(rename = "feedStats")]
    pub feed_stats: Option<serde_json::Value>,
    #[serde(rename = "gatewayStats")]
    pub gateway_stats: Option<serde_json::Value>,
}

// --- Broker-wide risk policy (GET/PATCH /api/manage/risk) -- backs BOTH
// Emergency (tradingHalted only) and the separate "Risk rules" screen
// (everything else: dealingMode, exposure/position limits, Smart
// Dealer %s). One real endpoint, two different screens' concerns. ---
#[derive(Debug, Clone, Deserialize)]
pub struct RiskData {
    #[serde(rename = "tradingHalted")]
    pub trading_halted: bool,
    #[serde(rename = "dealingMode", default)]
    pub dealing_mode: bool,
    #[serde(rename = "totalExposureLimit")]
    pub total_exposure_limit: Option<String>,
    #[serde(rename = "maxOpenPositionsPerAccount")]
    pub max_open_positions_per_account: Option<i64>,
    #[serde(rename = "smartDealerAcceptPct")]
    pub smart_dealer_accept_pct: Option<String>,
    #[serde(rename = "smartDealerRejectPct")]
    pub smart_dealer_reject_pct: Option<String>,
}

pub type RiskSettings = RiskData;

pub enum ApiEvent {
    LoginResult(Result<String, String>),
    Dashboard(Result<DashboardData, String>),
    Accounts(Result<Vec<AccountRow>, String>),
    Positions(Result<Vec<PositionRow>, String>),
    DealingQueue(Result<(Vec<DealingOrderRow>, Vec<RequotedOrderRow>), String>),
    DealerToggle(Result<DealerToggleState, String>),
    DealingDesk(Result<(Vec<DealingDeskAccount>, Vec<RestingOrderRow>, Vec<ActivityFeedRow>), String>),
    LiveActivity(Result<Vec<ActivityFeedRow>, String>),
    Groups(Result<Vec<GroupRow>, String>),
    GroupPricing(Result<Vec<GroupPricingRow>, String>),
    PasswordReset(Result<String, String>),
    AccountTypes(Result<Vec<AccountTypeOption>, String>),
    AccountCreated(Result<(String, String), String>),
    AdjustBalance(Result<bool, String>),
    PendingAdjustments(Result<Vec<PendingAdjustment>, String>),
    Kyc(Result<Vec<KycRow>, String>),
    KycDocument(Result<(Vec<u8>, [usize; 2]), String>),
    ClientKyc(Result<Vec<ClientKycRow>, String>),
    RiskSettings(Result<RiskSettings, String>),
    LiveAccountRequests(Result<Vec<LiveAccountRequestRow>, String>),
    Notifications(Result<Vec<NotificationRow>, String>),
    RiskRadar(Result<Vec<RiskRadarRow>, String>),
    Settings(Result<SettingsData, String>),
    ShellInfo(Result<ShellInfo, String>),
    ReportsSummary(Result<ReportsSummary, String>),
    Symbols(Result<Vec<SymbolConfigRow>, String>),
    Admins(Result<Vec<AdminRow>, String>),
    Transfers(Result<Vec<TransferRow>, String>),
    IbRelationships(Result<Vec<IbRelationshipRow>, String>),
    Leads(Result<Vec<LeadRow>, String>),
    Deals(Result<Vec<DealRow>, String>),
    AuditLog(Result<Vec<AuditLogRow>, String>),
    FundsRequests(Result<Vec<FundsRequestRow>, String>),
    PaymentMethods(Result<Vec<PaymentMethodRow>, String>),
    Margin(Result<Vec<MarginRow>, String>),
    Liquidity(Result<Vec<LiquidityExposureRow>, String>),
    LpRouting(Result<Vec<LpRoutingRow>, String>),
    FeedHealth(Result<FeedHealthData, String>),
    Risk(Result<RiskData, String>),
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

    pub fn close_position(&self, ctx: egui::Context, tx: Sender<ApiEvent>, position_id: String, volume: Option<String>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/positions/{}/close", self.base_url, position_id);
        spawn(async move {
            let body = match &volume {
                Some(v) if !v.trim().is_empty() => serde_json::json!({ "volume": v.trim() }),
                _ => serde_json::json!({}),
            };
            let result = async {
                let res = client.post(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
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

    pub fn modify_position(
        &self,
        ctx: egui::Context,
        tx: Sender<ApiEvent>,
        position_id: String,
        sl_price: Option<String>,
        tp_price: Option<String>,
        reason: String,
    ) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/positions/{}", self.base_url, position_id);
        spawn(async move {
            let sl_value = match &sl_price {
                Some(v) if !v.trim().is_empty() => serde_json::Value::String(v.trim().to_string()),
                _ => serde_json::Value::Null,
            };
            let tp_value = match &tp_price {
                Some(v) if !v.trim().is_empty() => serde_json::Value::String(v.trim().to_string()),
                _ => serde_json::Value::Null,
            };
            let body = serde_json::json!({ "slPrice": sl_value, "tpPrice": tp_value, "reason": reason });
            let result = async {
                let res = client.patch(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok("position modified".to_string())
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    // Doesn't route through ApiEvent::ActionDone (which auto-refetches
    // the current screen and clears show_new_account_form) -- the web's
    // own post-create UI stays open showing the account number/password
    // once, so main.rs handles the reload itself once that screen closes.
    pub fn create_account(&self, ctx: egui::Context, tx: Sender<ApiEvent>, body: NewAccountBody) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/accounts", self.base_url);
        let password = body.password.clone();
        spawn(async move {
            let result = async {
                let res = client.post(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let created: CreateAccountResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok((created.account_number, password))
            }
            .await;
            let _ = tx.send(ApiEvent::AccountCreated(result));
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

    // Generic single-field (or small multi-field) account PATCH -- backs
    // Group/Account Type/Leverage/Max daily loss/Swap-free, matching
    // AccountsManager.tsx's own patchAccount helper.
    pub fn patch_account(&self, ctx: egui::Context, tx: Sender<ApiEvent>, account_id: String, body: serde_json::Value, message: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/accounts/{}", self.base_url, account_id);
        spawn(async move {
            let result = async {
                let res = client.patch(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(message)
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_account_types(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/account-types", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<AccountTypeOption>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::AccountTypes(result));
            ctx.request_repaint();
        });
    }

    // Returns Ok(true) if the adjustment applied immediately, Ok(false)
    // if it was filed for another admin's approval (HTTP 202, same
    // maker-checker gate as the Dealing queue) -- main.rs branches the
    // UI message on which happened, matching submitAdjustment's own
    // response.status === 202 check.
    pub fn adjust_balance(&self, ctx: egui::Context, tx: Sender<ApiEvent>, account_id: String, amount: f64, note: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/accounts/{}/adjust-balance", self.base_url, account_id);
        spawn(async move {
            let result = async {
                let res = client
                    .post(&url)
                    .json(&serde_json::json!({ "amount": amount, "note": note }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if res.status().as_u16() == 202 {
                    return Ok(true);
                }
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(false)
            }
            .await;
            let _ = tx.send(ApiEvent::AdjustBalance(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_pending_adjustments(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/balance-adjustment-requests", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<PendingAdjustment>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::PendingAdjustments(result));
            ctx.request_repaint();
        });
    }

    pub fn review_pending_adjustment(&self, ctx: egui::Context, tx: Sender<ApiEvent>, request_id: String, decision: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/balance-adjustment-requests/{}/{}", self.base_url, request_id, decision);
        spawn(async move {
            let result = async {
                let res = client.post(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(format!("adjustment {decision}d"))
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
                Ok((body.rows, body.requoted_rows))
            }
            .await;
            let _ = tx.send(ApiEvent::DealingQueue(result));
            ctx.request_repaint();
        });
    }

    // action: "ACCEPT", "REJECT", or "REQUOTE" (price required for REQUOTE).
    pub fn dealing_action(
        &self,
        ctx: egui::Context,
        tx: Sender<ApiEvent>,
        order_id: String,
        action: String,
        reason: Option<String>,
        price: Option<f64>,
    ) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/dealing-queue/{}", self.base_url, order_id);
        spawn(async move {
            let mut body = serde_json::json!({ "action": action });
            if let Some(reason) = &reason {
                body["reason"] = serde_json::Value::String(reason.clone());
            }
            if let Some(price) = price {
                body["price"] = serde_json::json!(price);
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

    pub fn fetch_dealer_toggle(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/dealing-desk-toggle", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: DealerToggleGetResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok(DealerToggleState { dealer_on: body.dealer_on, filled: 0, skipped: 0 })
            }
            .await;
            let _ = tx.send(ApiEvent::DealerToggle(result));
            ctx.request_repaint();
        });
    }

    pub fn set_dealer_toggle(&self, ctx: egui::Context, tx: Sender<ApiEvent>, dealer_on: bool) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/dealing-desk-toggle", self.base_url);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({ "dealerOn": dealer_on }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: DealerTogglePatchResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                let filled = body.flushed.iter().filter(|f| f.status == "filled").count();
                let skipped = body.flushed.iter().filter(|f| f.status == "skipped").count();
                Ok(DealerToggleState { dealer_on: body.dealer_on, filled, skipped })
            }
            .await;
            let _ = tx.send(ApiEvent::DealerToggle(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_dealing_desk(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/dealing-desk", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: DealingDeskResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok((body.accounts, body.resting_orders, body.feed_rows))
            }
            .await;
            let _ = tx.send(ApiEvent::DealingDesk(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_live_activity(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/live-activity", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: LiveActivityResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok(body.rows)
            }
            .await;
            let _ = tx.send(ApiEvent::LiveActivity(result));
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
    // mode: "markup" or "target" -- mutually exclusive per row, same as
    // SymbolPricingEditor.tsx's own per-row toggle; whichever mode isn't
    // active is sent blank (parses server-side as null).
    #[allow(clippy::too_many_arguments)]
    pub fn update_group_pricing(
        &self,
        ctx: egui::Context,
        tx: Sender<ApiEvent>,
        group_id: String,
        symbol_id: String,
        mode: String,
        spread_markup: String,
        target_total_spread_pips: String,
        commission_per_lot: String,
        swap_long: String,
        swap_short: String,
    ) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/groups/{}/pricing", self.base_url, group_id);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({
                        "symbolId": symbol_id,
                        "spreadMarkup": if mode == "markup" { spread_markup } else { String::new() },
                        "targetTotalSpreadPips": if mode == "target" { target_total_spread_pips } else { String::new() },
                        "commissionPerLot": commission_per_lot,
                        "swapLong": swap_long,
                        "swapShort": swap_short,
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

    pub fn fetch_kyc(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/kyc-requests", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<KycRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Kyc(result));
            ctx.request_repaint();
        });
    }

    pub fn kyc_action(&self, ctx: egui::Context, tx: Sender<ApiEvent>, record_id: String, action: String, rejection_reason: Option<String>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/kyc-requests/{}", self.base_url, record_id);
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

    // Fetches a KYC document photo through this app's own authenticated
    // cookie jar -- an external-browser <a target="_blank"> link (the
    // web's own approach) can't work here since the OS browser doesn't
    // share this app's session cookie; shown instead in an in-app image
    // preview window (main.rs's own KycDocument state).
    pub fn fetch_kyc_document(&self, ctx: egui::Context, tx: Sender<ApiEvent>, record_id: String, side: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/kyc-requests/{}/document?side={}", self.base_url, record_id, side);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(format!("document request failed ({})", res.status()));
                }
                let bytes = res.bytes().await.map_err(|e| format!("failed to read document bytes: {e}"))?;
                let decoded = image::load_from_memory(&bytes).map_err(|e| format!("failed to decode document image: {e}"))?.to_rgba8();
                let size = [decoded.width() as usize, decoded.height() as usize];
                Ok((decoded.into_raw(), size))
            }
            .await;
            let _ = tx.send(ApiEvent::KycDocument(result));
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

    // Fire-and-forget, same as the web's own optimistic-save/toast-free-
    // failure theme toggle (lib/admin-theme.tsx) -- the local UI already
    // flipped by the time this is called, so a dropped save just means
    // the next login falls back to whatever was last persisted.
    pub fn set_theme(&self, ctx: egui::Context, theme: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/theme", self.base_url);
        spawn(async move {
            let _ = client.patch(&url).json(&serde_json::json!({ "theme": theme })).send().await;
            ctx.request_repaint();
        });
    }

    pub fn mark_notification_read(&self, ctx: egui::Context, tx: Sender<ApiEvent>, notification_id: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/notifications/{}", self.base_url, notification_id);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({ "read": true }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok("notification marked read".to_string())
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn reset_trader_password(&self, ctx: egui::Context, tx: Sender<ApiEvent>, account_id: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/accounts/{}/reset-password", self.base_url, account_id);
        spawn(async move {
            let result = async {
                let res = client.post(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: ResetPasswordResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok(body.password)
            }
            .await;
            let _ = tx.send(ApiEvent::PasswordReset(result));
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

    pub fn fetch_reports_summary(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/reports/summary", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<ReportsSummary>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::ReportsSummary(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_symbols(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/symbols", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<SymbolConfigRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Symbols(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_admins(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        #[derive(Deserialize)]
        struct Resp {
            rows: Vec<AdminRow>,
        }
        let client = self.client.clone();
        let url = format!("{}/api/manage/admins", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: Resp = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok(body.rows)
            }
            .await;
            let _ = tx.send(ApiEvent::Admins(result));
            ctx.request_repaint();
        });
    }

    pub fn set_admin_status(&self, ctx: egui::Context, tx: Sender<ApiEvent>, admin_id: String, status: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/admins/{}", self.base_url, admin_id);
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

    pub fn fetch_transfers(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/transfers", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<TransferRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Transfers(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_ib_relationships(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/ib-relationships", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<IbRelationshipRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::IbRelationships(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_leads(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/leads", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<LeadRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Leads(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_deals(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/deals", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<DealRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Deals(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_audit_log(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/audit", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<AuditLogRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::AuditLog(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_funds_requests(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/funds-requests", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                let body: FundsRequestsResponse = res.json().await.map_err(|e| format!("bad response: {e}"))?;
                Ok(body.rows)
            }
            .await;
            let _ = tx.send(ApiEvent::FundsRequests(result));
            ctx.request_repaint();
        });
    }

    pub fn funds_request_action(&self, ctx: egui::Context, tx: Sender<ApiEvent>, request_id: String, action: String) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/funds-requests/{}", self.base_url, request_id);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({ "action": action }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(format!("funds request {}", action.to_lowercase()))
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_payment_methods(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/payment-methods", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<PaymentMethodRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::PaymentMethods(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_margin(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/margin", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<MarginRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Margin(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_liquidity(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/liquidity", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<LiquidityExposureRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Liquidity(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_lp_routing(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/lp-routing", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<Vec<LpRoutingRow>>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::LpRouting(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_feed_health(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/feed-health", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<FeedHealthData>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::FeedHealth(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_risk(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/risk", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<RiskData>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::Risk(result));
            ctx.request_repaint();
        });
    }

    pub fn fetch_risk_settings(&self, ctx: egui::Context, tx: Sender<ApiEvent>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/risk", self.base_url);
        spawn(async move {
            let result = async {
                let res = client.get(&url).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<RiskSettings>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::RiskSettings(result));
            ctx.request_repaint();
        });
    }

    pub fn set_dealing_mode(&self, ctx: egui::Context, tx: Sender<ApiEvent>, on: bool) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/risk", self.base_url);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({ "dealingMode": on }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<RiskSettings>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::RiskSettings(result));
            ctx.request_repaint();
        });
    }

    pub fn save_risk_limits(&self, ctx: egui::Context, tx: Sender<ApiEvent>, total_exposure_limit: Option<String>, max_open_positions: Option<i64>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/risk", self.base_url);
        spawn(async move {
            let body = serde_json::json!({
                "totalExposureLimit": total_exposure_limit,
                "maxOpenPositionsPerAccount": max_open_positions,
            });
            let result = async {
                let res = client.patch(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<RiskSettings>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::RiskSettings(result));
            ctx.request_repaint();
        });
    }

    pub fn save_smart_dealer(&self, ctx: egui::Context, tx: Sender<ApiEvent>, accept_pct: Option<String>, reject_pct: Option<String>) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/risk", self.base_url);
        spawn(async move {
            let body = serde_json::json!({
                "smartDealerAcceptPct": accept_pct,
                "smartDealerRejectPct": reject_pct,
            });
            let result = async {
                let res = client.patch(&url).json(&body).send().await.map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                res.json::<RiskSettings>().await.map_err(|e| format!("bad response: {e}"))
            }
            .await;
            let _ = tx.send(ApiEvent::RiskSettings(result));
            ctx.request_repaint();
        });
    }

    pub fn set_trading_halted(&self, ctx: egui::Context, tx: Sender<ApiEvent>, halted: bool) {
        let client = self.client.clone();
        let url = format!("{}/api/manage/risk", self.base_url);
        spawn(async move {
            let result = async {
                let res = client
                    .patch(&url)
                    .json(&serde_json::json!({ "tradingHalted": halted }))
                    .send()
                    .await
                    .map_err(|e| format!("network error: {e}"))?;
                if !res.status().is_success() {
                    return Err(Self::error_from_response(res).await);
                }
                Ok(if halted { "trading halted".to_string() } else { "trading resumed".to_string() })
            }
            .await;
            let _ = tx.send(ApiEvent::ActionDone(result));
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
