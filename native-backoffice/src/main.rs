// True-native (zero-webview) backoffice -- real native window via
// eframe/winit, no webview, no browser, no HTML/CSS/JS anywhere in this
// binary. See api.rs's own top comment for why this talks to the live
// /api/manage/* HTTP endpoints rather than "a Rust DB layer" -- no such
// layer exists yet (engine/ is a Phase 1, no-I/O scaffold).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;

use api::{
    AccountRow, ActivityFeedRow, AdminRow, ApiClient, ApiEvent, AuditLogRow, ClientKycRow, DashboardData,
    DealRow, DealerToggleState, DealingDeskAccount, DealingOrderRow, FeedHealthData, FundsRequestRow,
    GroupPricingRow, GroupRow, IbRelationshipRow, LeadRow, LiquidityExposureRow, LiveAccountRequestRow,
    LpRoutingRow, MarginRow, NewAccountBody, NotificationRow, PaymentMethodRow, PositionRow, ReportsSummary,
    RequotedOrderRow, RestingOrderRow, RiskData, RiskRadarRow, SettingsData, SymbolConfigRow, TransferRow,
};
use eframe::egui;
use egui_extras::{Column, TableBuilder};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, Receiver, Sender};

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Screen {
    Dashboard,
    Positions,
    Accounts,
    Dealing,
    Groups,
    ClientKyc,
    LiveAccountRequests,
    Notifications,
    RiskRadar,
    Settings,
    Reports,
    Symbols,
    Team,
    Transfers,
    Wallets,
    Ib,
    Leads,
    Deals,
    Audit,
    Security,
    Funds,
    PaymentMethods,
    Margin,
    Liquidity,
    LiquidityRouting,
    FeedHealth,
    Emergency,
}

impl Screen {
    fn label(self) -> &'static str {
        match self {
            Screen::Dashboard => "Dashboard",
            Screen::Positions => "Live Exposure",
            Screen::Accounts => "Clients / Accounts",
            Screen::Dealing => "Dealing",
            Screen::Groups => "Groups",
            Screen::ClientKyc => "Client KYC",
            Screen::LiveAccountRequests => "Live Account Requests",
            Screen::Notifications => "Notifications",
            Screen::RiskRadar => "Risk / Exposure",
            Screen::Settings => "Settings",
            Screen::Reports => "Reports",
            Screen::Symbols => "Symbols",
            Screen::Team => "Team",
            Screen::Transfers => "Transfers",
            Screen::Wallets => "Wallets",
            Screen::Ib => "IB",
            Screen::Leads => "Leads",
            Screen::Deals => "Deals",
            Screen::Audit => "Audit",
            Screen::Security => "Security",
            Screen::Funds => "Funds",
            Screen::PaymentMethods => "Payment Methods",
            Screen::Margin => "Margin",
            Screen::Liquidity => "Liquidity",
            Screen::LiquidityRouting => "Liquidity Routing",
            Screen::FeedHealth => "Feed Health",
            Screen::Emergency => "Emergency",
        }
    }

    // Plain geometric/Unicode glyphs, not an icon font -- no icon font is
    // embedded (see theme::load_fonts's own comment on the one font this
    // app does embed), and these render reliably across egui's font
    // fallback chain without needing one.
    // Reassigned (2026-09-08) after screenshotting the original set: many
    // of the "square with N hatch pattern" glyphs (▦/▤/▧/▥) are visually
    // indistinguishable from one another and from a plain missing-glyph
    // box at 16px sidebar size, which is exactly the "icons look
    // odd/mismatched" complaint. This set favors shapes with genuinely
    // different silhouettes (circle/triangle/diamond/bar-stack/arrow/
    // rectangle) so adjacent items in the sidebar read as different icons
    // at a glance, not just different Unicode code points.
    fn icon(self) -> &'static str {
        match self {
            Screen::Dashboard => "⌂",
            Screen::Positions => "⬈",
            Screen::Accounts => "●",
            Screen::Dealing => "↔",
            Screen::Groups => "⊞",
            Screen::ClientKyc => "✓",
            Screen::LiveAccountRequests => "☑",
            Screen::Notifications => "◔",
            Screen::RiskRadar => "⚠",
            Screen::Settings => "⚙",
            Screen::Reports => "▬",
            Screen::Symbols => "◆",
            Screen::Team => "⊙",
            Screen::Transfers => "⇌",
            Screen::Wallets => "$",
            Screen::Ib => "◐",
            Screen::Leads => "◇",
            Screen::Deals => "■",
            Screen::Audit => "☰",
            Screen::Security => "⊘",
            Screen::Funds => "◎",
            Screen::PaymentMethods => "▭",
            Screen::Margin => "▽",
            Screen::Liquidity => "≋",
            Screen::LiquidityRouting => "⇉",
            Screen::FeedHealth => "◍",
            Screen::Emergency => "⛔",
        }
    }
}

// Shared by Dealing/Client KYC/Live Account Requests -- all three follow
// the same "Reject requires a typed reason, Approve/Accept doesn't" shape
// in the real API, so one small inline-reason-box state does for all of
// them instead of three near-identical structs.
const NO_GROUP: &str = "__none__";

#[derive(Default)]
struct PendingReject {
    id: String,
    reason: String,
}

#[derive(Default)]
struct PendingRequote {
    id: String,
    price: String,
    error: Option<String>,
}

// Modify SL/TP modal state for the Live Exposure "Open positions" table --
// matches PositionsManager.tsx's own modify modal (reason required, S/L
// and T/P each independently clearable to blank).
#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum ExposureSideFilter {
    #[default]
    All,
    Buy,
    Sell,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum ExposurePlFilter {
    #[default]
    All,
    Profit,
    Loss,
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum ExposureSortMode {
    #[default]
    Symbol,
    Exposure,
    Risk,
}

#[derive(Default)]
struct PendingModify {
    id: String,
    account_number: String,
    symbol: String,
    sl: String,
    tp: String,
    reason: String,
    error: Option<String>,
}

// Brand palette + reusable styled widgets -- matches the real web
// backoffice's own dark theme (app/admin-theme.css's --bg-1/--bg-2/
// --text-1/--accent tokens) so this reads as the same product, not an
// unrelated tech demo. Centralized here instead of inlined at each call
// site so every screen/table/button pulls from the same small set of
// tokens -- one color to change, not forty.
mod theme {
    use eframe::egui::{self, Color32};
    use std::sync::atomic::{AtomicU8, Ordering};

    pub const BG_0: Color32 = Color32::from_rgb(0x0a, 0x0d, 0x12); // outermost app background
    pub const BG_1: Color32 = Color32::from_rgb(0x11, 0x15, 0x1c); // card / panel surface
    pub const BG_2: Color32 = Color32::from_rgb(0x19, 0x1e, 0x27); // raised surface: inputs, hover, table stripe
    pub const SIDEBAR_BG: Color32 = Color32::from_rgb(0x0d, 0x10, 0x16); // one shade darker than BG_0, separates the nav rail
    pub const BORDER: Color32 = Color32::from_rgb(0x24, 0x2a, 0x36);
    pub const TEXT_1: Color32 = Color32::from_rgb(0xed, 0xf0, 0xf5); // primary
    pub const TEXT_2: Color32 = Color32::from_rgb(0xa8, 0xb2, 0xc0); // secondary
    pub const TEXT_3: Color32 = Color32::from_rgb(0x64, 0x6f, 0x7e); // muted / placeholder
    pub const DANGER: Color32 = Color32::from_rgb(0xef, 0x4a, 0x4a);
    pub const WARNING: Color32 = Color32::from_rgb(0xe8, 0xa8, 0x38);

    const DEFAULT_ACCENT: (u8, u8, u8) = (0x16, 0xc7, 0x84); // generic VyXTrader green, shown pre-login and if a broker has no primaryColor set

    // Per-tenant accent (Broker.primaryColor, fetched via /api/manage/
    // shell-info right after login -- see BackofficeApp::drain_events's
    // own ShellInfo handling) -- three plain atomics rather than a
    // Mutex<Color32>: this app is single-threaded for UI purposes (only
    // the egui update loop ever reads these; api.rs's background tasks
    // only ever WRITE once, via set_accent), so there's no real
    // contention to guard against, just interior mutability for a global
    // ctx.set_visuals() can't itself provide since it needs a fresh
    // egui::Visuals value built from these on every theme::apply() call.
    static ACCENT_R: AtomicU8 = AtomicU8::new(DEFAULT_ACCENT.0);
    static ACCENT_G: AtomicU8 = AtomicU8::new(DEFAULT_ACCENT.1);
    static ACCENT_B: AtomicU8 = AtomicU8::new(DEFAULT_ACCENT.2);

    pub fn accent() -> Color32 {
        Color32::from_rgb(ACCENT_R.load(Ordering::Relaxed), ACCENT_G.load(Ordering::Relaxed), ACCENT_B.load(Ordering::Relaxed))
    }

    pub fn accent_dim() -> Color32 {
        accent().gamma_multiply(0.65)
    }

    pub fn set_accent(color: Color32) {
        ACCENT_R.store(color.r(), Ordering::Relaxed);
        ACCENT_G.store(color.g(), Ordering::Relaxed);
        ACCENT_B.store(color.b(), Ordering::Relaxed);
    }

    pub fn reset_accent() {
        ACCENT_R.store(DEFAULT_ACCENT.0, Ordering::Relaxed);
        ACCENT_G.store(DEFAULT_ACCENT.1, Ordering::Relaxed);
        ACCENT_B.store(DEFAULT_ACCENT.2, Ordering::Relaxed);
    }

    // Called once at startup (fonts + visuals) and again after
    // apply_visuals-only whenever set_accent changes (see
    // BackofficeApp::drain_events's ShellInfo handling) -- font loading
    // is idempotent but not free, so the post-login re-brand only redoes
    // the (cheap) visuals half via apply_visuals below, not this whole
    // function.
    pub fn apply(ctx: &egui::Context) {
        load_fonts(ctx);
        apply_visuals(ctx);
    }

    // The part of apply() that depends on accent() -- split out so
    // re-branding to a broker's own primaryColor after login doesn't
    // also redundantly reload the embedded font.
    pub fn apply_visuals(ctx: &egui::Context) {
        let accent = accent();
        let accent_dim = accent_dim();

        let mut visuals = egui::Visuals::dark();
        visuals.panel_fill = BG_0;
        visuals.window_fill = BG_1;
        visuals.extreme_bg_color = BG_2;
        visuals.faint_bg_color = BG_2;
        visuals.code_bg_color = BG_2;
        visuals.override_text_color = Some(TEXT_1);
        visuals.hyperlink_color = accent;
        visuals.selection.bg_fill = accent.linear_multiply(0.35);
        visuals.selection.stroke = egui::Stroke::new(1.0_f32, accent);
        visuals.window_stroke = egui::Stroke::new(1.0_f32, BORDER);

        let radius = egui::CornerRadius::same(8);
        visuals.window_corner_radius = radius;
        visuals.menu_corner_radius = radius;

        // Widget states: inactive (resting), hovered, active (pressed/
        // held) -- these three drive the look of every button, text
        // field, and selectable item in the app, so this is most of what
        // separates "styled" from "egui's raw default."
        visuals.widgets.noninteractive.bg_fill = BG_1;
        visuals.widgets.noninteractive.weak_bg_fill = BG_1;
        visuals.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0_f32, BORDER);
        visuals.widgets.noninteractive.fg_stroke = egui::Stroke::new(1.0_f32, TEXT_1);
        visuals.widgets.noninteractive.corner_radius = radius;

        visuals.widgets.inactive.bg_fill = BG_2;
        visuals.widgets.inactive.weak_bg_fill = BG_2;
        visuals.widgets.inactive.bg_stroke = egui::Stroke::new(1.0_f32, BORDER);
        visuals.widgets.inactive.fg_stroke = egui::Stroke::new(1.0_f32, TEXT_2);
        visuals.widgets.inactive.corner_radius = radius;

        visuals.widgets.hovered.bg_fill = BG_2.gamma_multiply(1.35);
        visuals.widgets.hovered.weak_bg_fill = BG_2.gamma_multiply(1.35);
        visuals.widgets.hovered.bg_stroke = egui::Stroke::new(1.0_f32, accent_dim);
        visuals.widgets.hovered.fg_stroke = egui::Stroke::new(1.0_f32, TEXT_1);
        visuals.widgets.hovered.corner_radius = radius;
        visuals.widgets.hovered.expansion = 0.5;

        visuals.widgets.active.bg_fill = accent.linear_multiply(0.28);
        visuals.widgets.active.weak_bg_fill = accent.linear_multiply(0.28);
        visuals.widgets.active.bg_stroke = egui::Stroke::new(1.0_f32, accent);
        visuals.widgets.active.fg_stroke = egui::Stroke::new(1.0_f32, TEXT_1);
        visuals.widgets.active.corner_radius = radius;

        visuals.widgets.open.bg_fill = BG_2;
        visuals.widgets.open.weak_bg_fill = BG_2;
        visuals.widgets.open.bg_stroke = egui::Stroke::new(1.0_f32, accent_dim);
        visuals.widgets.open.corner_radius = radius;

        // set_visuals alone follows the OS theme preference -- on a
        // light-mode system this got silently reset back to light on the
        // real first frame (confirmed live: the whole point of this pass
        // was fixing a UI that rendered plain/light despite this same
        // dark-visuals code already existing). set_theme locks the
        // preference so a light-mode Windows install can't override it,
        // and set_visuals_of targets the Dark slot explicitly rather than
        // "whatever ctx.theme() happens to resolve to at this exact call
        // site," removing the ambiguity that caused it.
        ctx.set_theme(egui::ThemePreference::Dark);
        ctx.set_visuals_of(egui::Theme::Dark, visuals);

        ctx.style_mut(|style| {
            style.spacing.item_spacing = egui::vec2(10.0, 10.0);
            style.spacing.button_padding = egui::vec2(14.0, 7.0);
            style.spacing.window_margin = egui::Margin::same(12);
            style.text_styles.insert(egui::TextStyle::Heading, egui::FontId::proportional(20.0));
            style.text_styles.insert(egui::TextStyle::Body, egui::FontId::proportional(14.0));
            style.text_styles.insert(egui::TextStyle::Button, egui::FontId::proportional(14.0));
            style.text_styles.insert(egui::TextStyle::Small, egui::FontId::proportional(11.5));
        });
    }

    // Inter (OFL-licensed, github.com/google/fonts/tree/main/ofl/inter)
    // in place of epaint's own bundled default -- that default is
    // intentionally utilitarian (it's a debug-tool font, not a product
    // font) and was the single biggest thing making this app look like a
    // dev tool rather than a real backoffice. Shipped as a variable font
    // (Google Fonts no longer publishes static per-weight Inter files);
    // ab_glyph rasterizes its default (Regular) instance, so this app
    // leans on size/color for hierarchy rather than a true bold cut --
    // see stat_card's/section headings' own use of size+ACCENT instead of
    // weight.
    fn load_fonts(ctx: &egui::Context) {
        let mut fonts = egui::FontDefinitions::default();
        fonts.font_data.insert(
            "inter".to_owned(),
            std::sync::Arc::new(egui::FontData::from_static(include_bytes!("../assets/Inter.ttf"))),
        );
        fonts.families.get_mut(&egui::FontFamily::Proportional).unwrap().insert(0, "inter".to_owned());
        ctx.set_fonts(fonts);
    }

    // A filled, accent-colored button for the one primary action in a
    // row/form (Sign in, Accept, Approve, Save, Create) -- everything
    // else stays the neutral default button so the accent still reads as
    // "the button that matters" instead of every button competing for
    // attention.
    pub fn accent_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
        accent_button_enabled(ui, true, text)
    }

    pub fn accent_button_enabled(ui: &mut egui::Ui, enabled: bool, text: &str) -> egui::Response {
        ui.add_enabled(
            enabled,
            egui::Button::new(egui::RichText::new(text).color(Color32::from_rgb(0x06, 0x0a, 0x08)).strong()).fill(accent()),
        )
    }

    pub fn danger_button_enabled(ui: &mut egui::Ui, enabled: bool, text: &str) -> egui::Response {
        ui.add_enabled(
            enabled,
            egui::Button::new(egui::RichText::new(text).color(TEXT_1))
                .fill(DANGER.linear_multiply(0.25))
                .stroke(egui::Stroke::new(1.0_f32, DANGER)),
        )
    }

    // Shared card look (form panels, per-row list items) -- same
    // fill/border/rounding as stat_card, parameterized on padding since
    // a dense list row and a spacious form need different amounts.
    pub fn card(margin: i8) -> egui::Frame {
        egui::Frame::new()
            .fill(BG_1)
            .stroke(egui::Stroke::new(1.0_f32, BORDER))
            .corner_radius(egui::CornerRadius::same(10))
            .inner_margin(egui::Margin::same(margin))
    }
}

#[derive(Default)]
struct NewAccountForm {
    full_name: String,
    email: String,
    password: String,
    is_live: bool,
}

struct BackofficeApp {
    tx: Sender<ApiEvent>,
    rx: Receiver<ApiEvent>,
    api: Option<ApiClient>,

    // --- auth / login screen ---
    logged_in: bool,
    login_busy: bool,
    login_error: Option<String>,
    host_input: String,
    email_input: String,
    password_input: String,
    logged_in_email: String,

    // --- shell ---
    screen: Screen,
    loaded_once: HashSet<Screen>,
    action_message: Option<String>,
    broker_name: Option<String>,
    broker_logo_texture: Option<egui::TextureHandle>,

    // --- dashboard ---
    dashboard: Option<DashboardData>,
    dashboard_loading: bool,
    dashboard_error: Option<String>,

    // --- positions / "Live Exposure" ---
    positions: Vec<PositionRow>,
    positions_loading: bool,
    positions_error: Option<String>,
    exposure_symbol_filter: String,
    exposure_account_filter: String,
    exposure_group_filter: String,
    exposure_side_filter: ExposureSideFilter,
    exposure_pl_filter: ExposurePlFilter,
    exposure_sort_mode: ExposureSortMode,
    position_modify: Option<PendingModify>,
    position_close_confirm: Option<(String, String)>,
    live_activity: Vec<ActivityFeedRow>,
    live_activity_loading: bool,
    live_activity_error: Option<String>,

    // --- accounts ---
    accounts: Vec<AccountRow>,
    accounts_loading: bool,
    accounts_error: Option<String>,
    accounts_filter: String,
    show_new_account_form: bool,
    new_account: NewAccountForm,

    // --- dealing ---
    dealing_queue: Vec<DealingOrderRow>,
    dealing_requoted: Vec<RequotedOrderRow>,
    dealing_loading: bool,
    dealing_error: Option<String>,
    dealing_reject: Option<PendingReject>,
    dealing_requote: Option<PendingRequote>,
    dealer_toggle: Option<DealerToggleState>,
    dealer_toggle_busy: bool,
    dealer_toggle_confirm_off: bool,
    dealing_desk_accounts: Vec<DealingDeskAccount>,
    dealing_desk_resting: Vec<RestingOrderRow>,
    dealing_desk_feed: Vec<ActivityFeedRow>,
    dealing_desk_loading: bool,
    dealing_desk_error: Option<String>,
    dealing_desk_account_filter: String,

    // --- groups (list + selected group's per-symbol pricing) ---
    groups: Vec<GroupRow>,
    groups_loading: bool,
    groups_error: Option<String>,
    selected_group: Option<GroupRow>,
    group_pricing: Vec<GroupPricingRow>,
    group_pricing_loading: bool,
    group_pricing_error: Option<String>,
    // symbolId -> (spreadMarkup input, commissionPerLot input), seeded
    // from the fetched row and edited in place before Save.
    pricing_edit_buffer: HashMap<String, (String, String)>,

    // --- client KYC ---
    client_kyc: Vec<ClientKycRow>,
    client_kyc_loading: bool,
    client_kyc_error: Option<String>,
    kyc_reject: Option<PendingReject>,

    // --- live account requests ---
    live_account_requests: Vec<LiveAccountRequestRow>,
    live_account_requests_loading: bool,
    live_account_requests_error: Option<String>,
    live_account_reject: Option<PendingReject>,

    // --- notifications ---
    notifications: Vec<NotificationRow>,
    notifications_loading: bool,
    notifications_error: Option<String>,

    // --- risk radar ---
    risk_radar: Vec<RiskRadarRow>,
    risk_radar_loading: bool,
    risk_radar_error: Option<String>,

    // --- settings ---
    settings: Option<SettingsData>,
    settings_loading: bool,
    settings_error: Option<String>,
    settings_leverage_input: String,

    // --- reports ---
    reports: Option<ReportsSummary>,
    reports_loading: bool,
    reports_error: Option<String>,

    // --- symbols ---
    symbols: Vec<SymbolConfigRow>,
    symbols_loading: bool,
    symbols_error: Option<String>,

    // --- team ---
    admins: Vec<AdminRow>,
    admins_loading: bool,
    admins_error: Option<String>,

    // --- transfers ---
    transfers: Vec<TransferRow>,
    transfers_loading: bool,
    transfers_error: Option<String>,

    // --- ib ---
    ib_relationships: Vec<IbRelationshipRow>,
    ib_loading: bool,
    ib_error: Option<String>,

    // --- leads ---
    leads: Vec<LeadRow>,
    leads_loading: bool,
    leads_error: Option<String>,

    // --- deals ---
    deals: Vec<DealRow>,
    deals_loading: bool,
    deals_error: Option<String>,

    // --- audit ---
    audit_log: Vec<AuditLogRow>,
    audit_loading: bool,
    audit_error: Option<String>,

    // --- funds ---
    funds_requests: Vec<FundsRequestRow>,
    funds_loading: bool,
    funds_error: Option<String>,

    // --- payment methods ---
    payment_methods: Vec<PaymentMethodRow>,
    payment_methods_loading: bool,
    payment_methods_error: Option<String>,

    // --- margin ---
    margin: Vec<MarginRow>,
    margin_loading: bool,
    margin_error: Option<String>,

    // --- liquidity ---
    liquidity: Vec<LiquidityExposureRow>,
    liquidity_loading: bool,
    liquidity_error: Option<String>,

    // --- liquidity routing ---
    lp_routing: Vec<LpRoutingRow>,
    lp_routing_loading: bool,
    lp_routing_error: Option<String>,

    // --- feed health ---
    feed_health: Option<FeedHealthData>,
    feed_health_loading: bool,
    feed_health_error: Option<String>,

    // --- emergency / risk ---
    risk: Option<RiskData>,
    risk_loading: bool,
    risk_error: Option<String>,
}

impl Default for BackofficeApp {
    fn default() -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            tx,
            rx,
            api: None,
            logged_in: false,
            login_busy: false,
            login_error: None,
            // A real, currently-reachable broker -- see this session's
            // own findings on which hosts actually resolve right now; any
            // broker's own subdomain works the same way.
            host_input: "futurixglobal.vyxtrader.com".to_string(),
            email_input: String::new(),
            password_input: String::new(),
            logged_in_email: String::new(),
            screen: Screen::Dashboard,
            loaded_once: HashSet::new(),
            action_message: None,
            broker_name: None,
            broker_logo_texture: None,
            dashboard: None,
            dashboard_loading: false,
            dashboard_error: None,
            positions: Vec::new(),
            positions_loading: false,
            positions_error: None,
            exposure_symbol_filter: "ALL".to_string(),
            exposure_account_filter: "ALL".to_string(),
            exposure_group_filter: "ALL".to_string(),
            exposure_side_filter: ExposureSideFilter::All,
            exposure_pl_filter: ExposurePlFilter::All,
            exposure_sort_mode: ExposureSortMode::Symbol,
            position_modify: None,
            position_close_confirm: None,
            live_activity: Vec::new(),
            live_activity_loading: false,
            live_activity_error: None,
            accounts: Vec::new(),
            accounts_loading: false,
            accounts_error: None,
            accounts_filter: String::new(),
            show_new_account_form: false,
            new_account: NewAccountForm::default(),
            dealing_queue: Vec::new(),
            dealing_requoted: Vec::new(),
            dealing_loading: false,
            dealing_error: None,
            dealing_reject: None,
            dealing_requote: None,
            dealer_toggle: None,
            dealer_toggle_busy: false,
            dealer_toggle_confirm_off: false,
            dealing_desk_accounts: Vec::new(),
            dealing_desk_resting: Vec::new(),
            dealing_desk_feed: Vec::new(),
            dealing_desk_loading: false,
            dealing_desk_error: None,
            dealing_desk_account_filter: "ALL".to_string(),
            groups: Vec::new(),
            groups_loading: false,
            groups_error: None,
            selected_group: None,
            group_pricing: Vec::new(),
            group_pricing_loading: false,
            group_pricing_error: None,
            pricing_edit_buffer: HashMap::new(),
            client_kyc: Vec::new(),
            client_kyc_loading: false,
            client_kyc_error: None,
            kyc_reject: None,
            live_account_requests: Vec::new(),
            live_account_requests_loading: false,
            live_account_requests_error: None,
            live_account_reject: None,
            notifications: Vec::new(),
            notifications_loading: false,
            notifications_error: None,
            risk_radar: Vec::new(),
            risk_radar_loading: false,
            risk_radar_error: None,
            settings: None,
            settings_loading: false,
            settings_error: None,
            settings_leverage_input: String::new(),
            reports: None,
            reports_loading: false,
            reports_error: None,
            symbols: Vec::new(),
            symbols_loading: false,
            symbols_error: None,
            admins: Vec::new(),
            admins_loading: false,
            admins_error: None,
            transfers: Vec::new(),
            transfers_loading: false,
            transfers_error: None,
            ib_relationships: Vec::new(),
            ib_loading: false,
            ib_error: None,
            leads: Vec::new(),
            leads_loading: false,
            leads_error: None,
            deals: Vec::new(),
            deals_loading: false,
            deals_error: None,
            audit_log: Vec::new(),
            audit_loading: false,
            audit_error: None,
            funds_requests: Vec::new(),
            funds_loading: false,
            funds_error: None,
            payment_methods: Vec::new(),
            payment_methods_loading: false,
            payment_methods_error: None,
            margin: Vec::new(),
            margin_loading: false,
            margin_error: None,
            liquidity: Vec::new(),
            liquidity_loading: false,
            liquidity_error: None,
            lp_routing: Vec::new(),
            lp_routing_loading: false,
            lp_routing_error: None,
            feed_health: None,
            feed_health_loading: false,
            feed_health_error: None,
            risk: None,
            risk_loading: false,
            risk_error: None,
        }
    }
}

impl BackofficeApp {
    fn drain_events(&mut self, ctx: &egui::Context) {
        while let Ok(event) = self.rx.try_recv() {
            match event {
                ApiEvent::LoginResult(Ok(_role)) => {
                    self.login_busy = false;
                    self.logged_in = true;
                    self.logged_in_email = self.email_input.clone();
                    self.password_input.clear();
                    self.ensure_loaded(ctx, Screen::Dashboard);
                    self.maybe_autonav(ctx);
                    if let Some(api) = &self.api {
                        api.fetch_shell_info(ctx.clone(), self.tx.clone());
                    }
                }
                ApiEvent::ShellInfo(Ok(info)) => {
                    self.broker_name = Some(info.broker_name);
                    if let Some(hex) = &info.broker_primary_color {
                        if let Some(color) = parse_hex_color(hex) {
                            theme::set_accent(color);
                            theme::apply_visuals(ctx);
                        }
                    }
                    if let Some(url) = info.broker_logo_url {
                        if let Some(api) = &self.api {
                            api.fetch_logo(ctx.clone(), self.tx.clone(), url);
                        }
                    }
                }
                // Non-fatal -- the sidebar just falls back to the
                // generic "VyXTrader" wordmark/green accent it already
                // shows before this fetch completes, same as a broker
                // with no logo/primaryColor configured at all.
                ApiEvent::ShellInfo(Err(_)) => {}
                ApiEvent::LogoImage(Ok((pixels, [w, h]))) => {
                    let color_image = egui::ColorImage::from_rgba_unmultiplied([w, h], &pixels);
                    self.broker_logo_texture = Some(ctx.load_texture("broker-logo", color_image, egui::TextureOptions::default()));
                }
                ApiEvent::LogoImage(Err(_)) => {}
                ApiEvent::LoginResult(Err(e)) => {
                    self.login_busy = false;
                    self.login_error = Some(e);
                }
                ApiEvent::Dashboard(result) => {
                    self.dashboard_loading = false;
                    match result {
                        Ok(data) => self.dashboard = Some(data),
                        Err(e) => self.dashboard_error = Some(e),
                    }
                }
                ApiEvent::Positions(result) => {
                    self.positions_loading = false;
                    match result {
                        Ok(rows) => self.positions = rows,
                        Err(e) => self.positions_error = Some(e),
                    }
                }
                ApiEvent::Accounts(result) => {
                    self.accounts_loading = false;
                    match result {
                        Ok(rows) => self.accounts = rows,
                        Err(e) => self.accounts_error = Some(e),
                    }
                }
                ApiEvent::DealingQueue(result) => {
                    self.dealing_loading = false;
                    match result {
                        Ok((rows, requoted)) => {
                            self.dealing_queue = rows;
                            self.dealing_requoted = requoted;
                        }
                        Err(e) => self.dealing_error = Some(e),
                    }
                }
                ApiEvent::DealerToggle(result) => {
                    self.dealer_toggle_busy = false;
                    match result {
                        Ok(state) => {
                            if !state.dealer_on && (state.filled > 0 || state.skipped > 0) {
                                self.action_message = Some(format!(
                                    "Dealer turned off: {} order{} filled at market, {} left in the queue.",
                                    state.filled,
                                    if state.filled == 1 { "" } else { "s" },
                                    state.skipped
                                ));
                            }
                            self.dealer_toggle = Some(state);
                            // A flip flushes/refills the queue server-side --
                            // reload it so the on-screen queue/resting-orders
                            // reflect the new state immediately.
                            self.fetch(ctx, Screen::Dealing);
                        }
                        Err(e) => self.dealing_error = Some(e),
                    }
                }
                ApiEvent::DealingDesk(result) => {
                    self.dealing_desk_loading = false;
                    match result {
                        Ok((accounts, resting, feed)) => {
                            self.dealing_desk_accounts = accounts;
                            self.dealing_desk_resting = resting;
                            self.dealing_desk_feed = feed;
                        }
                        Err(e) => self.dealing_desk_error = Some(e),
                    }
                }
                ApiEvent::LiveActivity(result) => {
                    self.live_activity_loading = false;
                    match result {
                        Ok(rows) => self.live_activity = rows,
                        Err(e) => self.live_activity_error = Some(e),
                    }
                }
                ApiEvent::Groups(result) => {
                    self.groups_loading = false;
                    match result {
                        Ok(rows) => {
                            self.groups = rows;
                            // Verification-only, same reasoning as
                            // maybe_autologin/maybe_autonav -- drills into
                            // the first group's pricing editor without a
                            // click, so screenshotting it never needs
                            // simulated mouse input.
                            if std::env::var("VYX_AUTOLOGIN_DRILL_GROUP").is_ok() {
                                if let Some(group) = self.groups.first().cloned() {
                                    let group_id = group.id.clone();
                                    self.selected_group = Some(group);
                                    self.fetch_group_pricing(ctx, group_id);
                                }
                            }
                        }
                        Err(e) => self.groups_error = Some(e),
                    }
                }
                ApiEvent::GroupPricing(result) => {
                    self.group_pricing_loading = false;
                    match result {
                        Ok(rows) => {
                            self.pricing_edit_buffer = rows
                                .iter()
                                .map(|r| {
                                    (
                                        r.symbol_id.clone(),
                                        (
                                            r.spread_markup.clone().unwrap_or_default(),
                                            r.commission_per_lot.clone().unwrap_or_default(),
                                        ),
                                    )
                                })
                                .collect();
                            self.group_pricing = rows;
                        }
                        Err(e) => self.group_pricing_error = Some(e),
                    }
                }
                ApiEvent::ClientKyc(result) => {
                    self.client_kyc_loading = false;
                    match result {
                        Ok(rows) => self.client_kyc = rows,
                        Err(e) => self.client_kyc_error = Some(e),
                    }
                }
                ApiEvent::LiveAccountRequests(result) => {
                    self.live_account_requests_loading = false;
                    match result {
                        Ok(rows) => self.live_account_requests = rows,
                        Err(e) => self.live_account_requests_error = Some(e),
                    }
                }
                ApiEvent::Notifications(result) => {
                    self.notifications_loading = false;
                    match result {
                        Ok(rows) => self.notifications = rows,
                        Err(e) => self.notifications_error = Some(e),
                    }
                }
                ApiEvent::RiskRadar(result) => {
                    self.risk_radar_loading = false;
                    match result {
                        Ok(rows) => self.risk_radar = rows,
                        Err(e) => self.risk_radar_error = Some(e),
                    }
                }
                ApiEvent::Settings(result) => {
                    self.settings_loading = false;
                    match result {
                        Ok(data) => {
                            self.settings_leverage_input = data.default_account_leverage.to_string();
                            self.settings = Some(data);
                        }
                        Err(e) => self.settings_error = Some(e),
                    }
                }
                ApiEvent::ReportsSummary(result) => {
                    self.reports_loading = false;
                    match result {
                        Ok(data) => self.reports = Some(data),
                        Err(e) => self.reports_error = Some(e),
                    }
                }
                ApiEvent::Symbols(result) => {
                    self.symbols_loading = false;
                    match result {
                        Ok(rows) => self.symbols = rows,
                        Err(e) => self.symbols_error = Some(e),
                    }
                }
                ApiEvent::Admins(result) => {
                    self.admins_loading = false;
                    match result {
                        Ok(rows) => self.admins = rows,
                        Err(e) => self.admins_error = Some(e),
                    }
                }
                ApiEvent::Transfers(result) => {
                    self.transfers_loading = false;
                    match result {
                        Ok(rows) => self.transfers = rows,
                        Err(e) => self.transfers_error = Some(e),
                    }
                }
                ApiEvent::IbRelationships(result) => {
                    self.ib_loading = false;
                    match result {
                        Ok(rows) => self.ib_relationships = rows,
                        Err(e) => self.ib_error = Some(e),
                    }
                }
                ApiEvent::Leads(result) => {
                    self.leads_loading = false;
                    match result {
                        Ok(rows) => self.leads = rows,
                        Err(e) => self.leads_error = Some(e),
                    }
                }
                ApiEvent::Deals(result) => {
                    self.deals_loading = false;
                    match result {
                        Ok(rows) => self.deals = rows,
                        Err(e) => self.deals_error = Some(e),
                    }
                }
                ApiEvent::AuditLog(result) => {
                    self.audit_loading = false;
                    match result {
                        Ok(rows) => self.audit_log = rows,
                        Err(e) => self.audit_error = Some(e),
                    }
                }
                ApiEvent::FundsRequests(result) => {
                    self.funds_loading = false;
                    match result {
                        Ok(rows) => self.funds_requests = rows,
                        Err(e) => self.funds_error = Some(e),
                    }
                }
                ApiEvent::PaymentMethods(result) => {
                    self.payment_methods_loading = false;
                    match result {
                        Ok(rows) => self.payment_methods = rows,
                        Err(e) => self.payment_methods_error = Some(e),
                    }
                }
                ApiEvent::Margin(result) => {
                    self.margin_loading = false;
                    match result {
                        Ok(rows) => self.margin = rows,
                        Err(e) => self.margin_error = Some(e),
                    }
                }
                ApiEvent::Liquidity(result) => {
                    self.liquidity_loading = false;
                    match result {
                        Ok(rows) => self.liquidity = rows,
                        Err(e) => self.liquidity_error = Some(e),
                    }
                }
                ApiEvent::LpRouting(result) => {
                    self.lp_routing_loading = false;
                    match result {
                        Ok(rows) => self.lp_routing = rows,
                        Err(e) => self.lp_routing_error = Some(e),
                    }
                }
                ApiEvent::FeedHealth(result) => {
                    self.feed_health_loading = false;
                    match result {
                        Ok(data) => self.feed_health = Some(data),
                        Err(e) => self.feed_health_error = Some(e),
                    }
                }
                ApiEvent::Risk(result) => {
                    self.risk_loading = false;
                    match result {
                        Ok(data) => self.risk = Some(data),
                        Err(e) => self.risk_error = Some(e),
                    }
                }
                ApiEvent::ActionDone(result) => match result {
                    Ok(msg) => {
                        self.action_message = Some(msg);
                        self.show_new_account_form = false;
                        self.new_account = NewAccountForm::default();
                        self.dealing_reject = None;
                        self.dealing_requote = None;
                        self.kyc_reject = None;
                        self.live_account_reject = None;
                        self.position_modify = None;
                        self.position_close_confirm = None;
                        // Re-fetch whichever screen is on-screen so it
                        // reflects whatever the action just changed --
                        // simplest correct way to stay in sync without
                        // hand-patching local state. Groups' pricing save
                        // needs the selected group id, not just the
                        // screen, so it's handled separately.
                        if self.screen == Screen::Groups {
                            if let Some(group) = self.selected_group.clone() {
                                self.fetch_group_pricing(ctx, group.id);
                            }
                        } else {
                            self.fetch(ctx, self.screen);
                        }
                    }
                    Err(e) => self.action_message = Some(format!("failed: {e}")),
                },
            }
        }
    }

    fn ensure_loaded(&mut self, ctx: &egui::Context, screen: Screen) {
        if !self.loaded_once.contains(&screen) {
            self.fetch(ctx, screen);
        }
    }

    fn fetch(&mut self, ctx: &egui::Context, screen: Screen) {
        let Some(api) = &self.api else { return };
        self.loaded_once.insert(screen);
        match screen {
            Screen::Dashboard => {
                self.dashboard_loading = true;
                self.dashboard_error = None;
                api.fetch_dashboard(ctx.clone(), self.tx.clone());
            }
            Screen::Positions => {
                self.positions_loading = true;
                self.positions_error = None;
                api.fetch_positions(ctx.clone(), self.tx.clone());
                self.live_activity_loading = true;
                self.live_activity_error = None;
                api.fetch_live_activity(ctx.clone(), self.tx.clone());
            }
            Screen::Accounts => {
                self.accounts_loading = true;
                self.accounts_error = None;
                api.fetch_accounts(ctx.clone(), self.tx.clone());
            }
            Screen::Dealing => {
                self.dealing_loading = true;
                self.dealing_error = None;
                api.fetch_dealing_queue(ctx.clone(), self.tx.clone());
                api.fetch_dealer_toggle(ctx.clone(), self.tx.clone());
                self.dealing_desk_loading = true;
                self.dealing_desk_error = None;
                api.fetch_dealing_desk(ctx.clone(), self.tx.clone());
            }
            Screen::Groups => {
                self.groups_loading = true;
                self.groups_error = None;
                api.fetch_groups(ctx.clone(), self.tx.clone());
            }
            Screen::ClientKyc => {
                self.client_kyc_loading = true;
                self.client_kyc_error = None;
                api.fetch_client_kyc(ctx.clone(), self.tx.clone());
            }
            Screen::LiveAccountRequests => {
                self.live_account_requests_loading = true;
                self.live_account_requests_error = None;
                api.fetch_live_account_requests(ctx.clone(), self.tx.clone());
            }
            Screen::Notifications => {
                self.notifications_loading = true;
                self.notifications_error = None;
                api.fetch_notifications(ctx.clone(), self.tx.clone());
            }
            Screen::RiskRadar => {
                self.risk_radar_loading = true;
                self.risk_radar_error = None;
                api.fetch_risk_radar(ctx.clone(), self.tx.clone());
            }
            Screen::Settings => {
                self.settings_loading = true;
                self.settings_error = None;
                api.fetch_settings(ctx.clone(), self.tx.clone());
            }
            Screen::Reports => {
                self.reports_loading = true;
                self.reports_error = None;
                api.fetch_reports_summary(ctx.clone(), self.tx.clone());
            }
            Screen::Symbols => {
                self.symbols_loading = true;
                self.symbols_error = None;
                api.fetch_symbols(ctx.clone(), self.tx.clone());
            }
            Screen::Team => {
                self.admins_loading = true;
                self.admins_error = None;
                api.fetch_admins(ctx.clone(), self.tx.clone());
            }
            Screen::Transfers => {
                self.transfers_loading = true;
                self.transfers_error = None;
                api.fetch_transfers(ctx.clone(), self.tx.clone());
            }
            // Wallets reuses accounts data (already fetched by the
            // Accounts screen) -- no separate endpoint exists, and the
            // real web page does the same (see WalletsManager.tsx's own
            // comment). Fetch accounts if this is reached first.
            Screen::Wallets => {
                self.accounts_loading = true;
                self.accounts_error = None;
                api.fetch_accounts(ctx.clone(), self.tx.clone());
            }
            Screen::Ib => {
                self.ib_loading = true;
                self.ib_error = None;
                api.fetch_ib_relationships(ctx.clone(), self.tx.clone());
            }
            Screen::Leads => {
                self.leads_loading = true;
                self.leads_error = None;
                api.fetch_leads(ctx.clone(), self.tx.clone());
            }
            Screen::Deals => {
                self.deals_loading = true;
                self.deals_error = None;
                api.fetch_deals(ctx.clone(), self.tx.clone());
            }
            Screen::Audit => {
                self.audit_loading = true;
                self.audit_error = None;
                api.fetch_audit_log(ctx.clone(), self.tx.clone());
            }
            // Security has no dedicated fetch -- see render_security's
            // own comment on why this pass shows account identity only.
            Screen::Security => {}
            Screen::Funds => {
                self.funds_loading = true;
                self.funds_error = None;
                api.fetch_funds_requests(ctx.clone(), self.tx.clone());
            }
            Screen::PaymentMethods => {
                self.payment_methods_loading = true;
                self.payment_methods_error = None;
                api.fetch_payment_methods(ctx.clone(), self.tx.clone());
            }
            Screen::Margin => {
                self.margin_loading = true;
                self.margin_error = None;
                api.fetch_margin(ctx.clone(), self.tx.clone());
            }
            Screen::Liquidity => {
                self.liquidity_loading = true;
                self.liquidity_error = None;
                api.fetch_liquidity(ctx.clone(), self.tx.clone());
            }
            Screen::LiquidityRouting => {
                self.lp_routing_loading = true;
                self.lp_routing_error = None;
                api.fetch_lp_routing(ctx.clone(), self.tx.clone());
            }
            Screen::FeedHealth => {
                self.feed_health_loading = true;
                self.feed_health_error = None;
                api.fetch_feed_health(ctx.clone(), self.tx.clone());
            }
            Screen::Emergency => {
                self.risk_loading = true;
                self.risk_error = None;
                api.fetch_risk(ctx.clone(), self.tx.clone());
            }
        }
    }

    fn fetch_group_pricing(&mut self, ctx: &egui::Context, group_id: String) {
        let Some(api) = &self.api else { return };
        self.group_pricing_loading = true;
        self.group_pricing_error = None;
        api.fetch_group_pricing(ctx.clone(), self.tx.clone(), group_id);
    }

    fn render_login(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default().frame(egui::Frame::new().fill(theme::BG_0)).show(ctx, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space(110.0);
                ui.label(egui::RichText::new("●").size(28.0).color(theme::accent()));
                ui.add_space(6.0);
                ui.label(egui::RichText::new("VyXTrader").size(26.0).color(theme::TEXT_1));
                ui.label(egui::RichText::new("BACKOFFICE").size(12.0).color(theme::TEXT_3));
                ui.add_space(28.0);

                egui::Frame::new()
                    .fill(theme::BG_1)
                    .stroke(egui::Stroke::new(1.0_f32, theme::BORDER))
                    .corner_radius(egui::CornerRadius::same(12))
                    .inner_margin(egui::Margin::same(24))
                    .show(ui, |ui| {
                        ui.set_width(360.0);
                        ui.label(egui::RichText::new("BROKER HOST").size(11.0).color(theme::TEXT_3));
                        ui.add_space(4.0);
                        ui.add(egui::TextEdit::singleline(&mut self.host_input).hint_text("brokername.vyxtrader.com").desired_width(f32::INFINITY));
                        ui.add_space(12.0);
                        ui.label(egui::RichText::new("EMAIL").size(11.0).color(theme::TEXT_3));
                        ui.add_space(4.0);
                        ui.add(egui::TextEdit::singleline(&mut self.email_input).hint_text("admin@broker.com").desired_width(f32::INFINITY));
                        ui.add_space(12.0);
                        ui.label(egui::RichText::new("PASSWORD").size(11.0).color(theme::TEXT_3));
                        ui.add_space(4.0);
                        ui.add(egui::TextEdit::singleline(&mut self.password_input).password(true).desired_width(f32::INFINITY));
                        ui.add_space(18.0);

                        let can_submit = !self.login_busy
                            && !self.host_input.trim().is_empty()
                            && !self.email_input.trim().is_empty()
                            && !self.password_input.is_empty();

                        ui.scope(|ui| {
                            ui.style_mut().spacing.button_padding = egui::vec2(0.0, 10.0);
                            let button = egui::Button::new(
                                egui::RichText::new(if self.login_busy { "Signing in..." } else { "Sign in" })
                                    .color(egui::Color32::from_rgb(0x06, 0x0a, 0x08))
                                    .strong(),
                            )
                            .fill(theme::accent())
                            .min_size(egui::vec2(ui.available_width(), 0.0));
                            if ui.add_enabled(can_submit, button).clicked() {
                                self.login_error = None;
                                self.login_busy = true;
                                let api = ApiClient::new(self.host_input.trim());
                                self.api = Some(api.clone());
                                api.login(ctx.clone(), self.tx.clone(), self.email_input.trim().to_string(), self.password_input.clone());
                            }
                        });

                        if let Some(err) = &self.login_error {
                            ui.add_space(10.0);
                            ui.colored_label(theme::DANGER, err);
                        }
                    });

                ui.add_space(16.0);
                ui.label(egui::RichText::new("2FA-enabled admin accounts aren't supported here yet -- use the web backoffice for those.").weak().small());
            });
        });
    }

    fn render_shell(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("header")
            .frame(egui::Frame::new().fill(theme::BG_0).inner_margin(egui::Margin::symmetric(20, 14)).stroke(egui::Stroke::NONE))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new(self.screen.icon()).size(18.0).color(theme::accent()));
                    ui.add_space(4.0);
                    ui.label(egui::RichText::new(self.screen.label()).size(19.0).color(theme::TEXT_1));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.add(egui::Button::new(egui::RichText::new("Log out").color(theme::TEXT_2)).fill(egui::Color32::TRANSPARENT).stroke(egui::Stroke::new(1.0_f32, theme::BORDER))).clicked() {
                            self.logged_in = false;
                            self.api = None;
                            self.loaded_once.clear();
                            self.dashboard = None;
                            self.positions.clear();
                            self.accounts.clear();
                            self.broker_name = None;
                            self.broker_logo_texture = None;
                            theme::reset_accent();
                            theme::apply_visuals(ctx);
                        }
                        ui.add_space(14.0);
                        ui.vertical(|ui| {
                            ui.label(egui::RichText::new(&self.logged_in_email).size(12.5).color(theme::TEXT_1));
                            ui.label(egui::RichText::new(&self.host_input).size(11.0).color(theme::TEXT_3));
                        });
                    });
                });
            });

        egui::SidePanel::left("sidebar")
            .resizable(false)
            .exact_width(230.0)
            .frame(egui::Frame::new().fill(theme::SIDEBAR_BG).inner_margin(egui::Margin::symmetric(0, 16)).stroke(egui::Stroke { width: 1.0, color: theme::BORDER }))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.add_space(20.0);
                    // Broker's own logo once fetched (see ApiEvent::
                    // LogoImage), falling back to the generic accent dot
                    // for a broker with none configured -- same "brand if
                    // we can, stay generic if we can't" rule the web
                    // backoffice's own sidebar follows.
                    if let Some(texture) = &self.broker_logo_texture {
                        ui.add(egui::Image::new(texture).max_height(20.0).max_width(28.0));
                    } else {
                        ui.label(egui::RichText::new("●").size(16.0).color(theme::accent()));
                    }
                    let name = self.broker_name.as_deref().unwrap_or("VyXTrader");
                    let name = if name.chars().count() > 18 { format!("{}...", name.chars().take(17).collect::<String>()) } else { name.to_string() };
                    ui.label(egui::RichText::new(name).size(17.0).color(theme::TEXT_1));
                });
                ui.label(egui::RichText::new("  BACKOFFICE").size(10.5).color(theme::TEXT_3));
                ui.add_space(14.0);
                ui.scope(|ui| {
                    ui.style_mut().visuals.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0_f32, theme::BORDER);
                    ui.add(egui::Separator::default().spacing(0.0));
                });
                ui.add_space(10.0);

                egui::ScrollArea::vertical().show(ui, |ui| {
                    let groups: [(&str, &[Screen]); 6] = [
                        ("OVERVIEW", &[Screen::Dashboard, Screen::Reports, Screen::Notifications]),
                        (
                            "TRADING",
                            &[Screen::Positions, Screen::Dealing, Screen::Deals, Screen::Symbols, Screen::Margin, Screen::RiskRadar],
                        ),
                        ("CLIENTS", &[Screen::Accounts, Screen::Leads, Screen::Ib, Screen::ClientKyc, Screen::LiveAccountRequests]),
                        (
                            "FINANCE",
                            &[Screen::Wallets, Screen::Transfers, Screen::Funds, Screen::PaymentMethods],
                        ),
                        ("LIQUIDITY", &[Screen::Liquidity, Screen::LiquidityRouting, Screen::FeedHealth]),
                        (
                            "ADMIN",
                            &[Screen::Groups, Screen::Team, Screen::Audit, Screen::Security, Screen::Emergency, Screen::Settings],
                        ),
                    ];
                    for (label, screens) in groups {
                        ui.add_space(6.0);
                        ui.horizontal(|ui| {
                            ui.add_space(20.0);
                            ui.label(egui::RichText::new(label).size(10.0).color(theme::TEXT_3).strong());
                        });
                        for &screen in screens {
                            if sidebar_nav_item(ui, screen.icon(), screen.label(), self.screen == screen).clicked() {
                                self.screen = screen;
                                self.ensure_loaded(ctx, screen);
                            }
                        }
                    }
                    ui.add_space(10.0);
                });
            });

        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(theme::BG_0).inner_margin(egui::Margin::symmetric(24, 20)))
            .show(ctx, |ui| {
            if let Some(msg) = self.action_message.clone() {
                egui::Frame::new()
                    .fill(theme::BG_1)
                    .stroke(egui::Stroke::new(1.0_f32, theme::BORDER))
                    .corner_radius(egui::CornerRadius::same(8))
                    .inner_margin(egui::Margin::symmetric(14, 10))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new(&msg).color(theme::TEXT_1));
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if ui.small_button("dismiss").clicked() {
                                    self.action_message = None;
                                }
                            });
                        });
                    });
                ui.add_space(14.0);
            }
            match self.screen {
                Screen::Dashboard => self.render_dashboard(ui, ctx),
                Screen::Positions => self.render_positions(ui, ctx),
                Screen::Accounts => self.render_accounts(ui, ctx),
                Screen::Dealing => self.render_dealing(ui, ctx),
                Screen::Groups => self.render_groups(ui, ctx),
                Screen::ClientKyc => self.render_client_kyc(ui, ctx),
                Screen::LiveAccountRequests => self.render_live_account_requests(ui, ctx),
                Screen::Notifications => self.render_notifications(ui, ctx),
                Screen::RiskRadar => self.render_risk_radar(ui, ctx),
                Screen::Settings => self.render_settings(ui, ctx),
                Screen::Reports => self.render_reports(ui, ctx),
                Screen::Symbols => self.render_symbols(ui, ctx),
                Screen::Team => self.render_team(ui, ctx),
                Screen::Transfers => self.render_transfers(ui, ctx),
                Screen::Wallets => self.render_wallets(ui, ctx),
                Screen::Ib => self.render_ib(ui, ctx),
                Screen::Leads => self.render_leads(ui, ctx),
                Screen::Deals => self.render_deals(ui, ctx),
                Screen::Audit => self.render_audit(ui, ctx),
                Screen::Security => self.render_security(ui),
                Screen::Funds => self.render_funds(ui, ctx),
                Screen::PaymentMethods => self.render_payment_methods(ui, ctx),
                Screen::Margin => self.render_margin(ui, ctx),
                Screen::Liquidity => self.render_liquidity(ui, ctx),
                Screen::LiquidityRouting => self.render_liquidity_routing(ui, ctx),
                Screen::FeedHealth => self.render_feed_health(ui, ctx),
                Screen::Emergency => self.render_emergency(ui, ctx),
            }
        });
    }

    fn render_dashboard(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Dashboard);
            }
            if self.dashboard_loading {
                ui.spinner();
                ui.label("Loading...");
            }
        });
        ui.add_space(10.0);

        if let Some(err) = &self.dashboard_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        let Some(data) = &self.dashboard else { return };

        // Explicit 4-column grid rather than horizontal_wrapped -- the
        // latter wrapped based on a max_rect wider than the window's
        // actual visible area inside CentralPanel (confirmed live: the
        // 7th card rendered clipped off the right edge instead of onto a
        // second row), so wrapping wasn't actually reliable here.
        let stats: [(&str, String); 7] = [
            ("Total clients", data.total_clients.to_string()),
            ("New clients (7d)", data.new_clients_7d.to_string()),
            ("Deposits (30d)", format!("${:.2}", data.deposits_sum_30d)),
            ("Active trades", data.active_trades.to_string()),
            ("Active trade accounts", data.active_trade_account_count.to_string()),
            ("Pending KYC", data.pending_kyc.to_string()),
            (
                "Pending withdrawals",
                format!("{} (${:.2})", data.pending_withdrawal_count, data.pending_withdrawal_sum),
            ),
        ];
        egui::Grid::new("dashboard-stats").num_columns(4).spacing([10.0, 10.0]).show(ui, |ui| {
            for (i, (label, value)) in stats.iter().enumerate() {
                stat_card(ui, label, value);
                if (i + 1) % 4 == 0 {
                    ui.end_row();
                }
            }
        });

        ui.add_space(20.0);
        ui.strong("Recent activity");
        ui.add_space(6.0);
        egui::ScrollArea::vertical().show(ui, |ui| {
            for row in &data.activity {
                ui.horizontal(|ui| {
                    ui.monospace(&row.created_at_label);
                    ui.label(&row.action_label);
                    ui.weak(&row.actor_email);
                });
            }
        });
    }

    // "Live Exposure" -- the exact native counterpart of
    // app/manage/(shell)/positions/PositionsManager.tsx + page.tsx's own
    // LiveActivityFeed mount (metadata title on the web is literally
    // "Live Exposure - Backoffice", confirmed by reading page.tsx). Three
    // stacked sections, same order as the web: filters, "Exposure by
    // symbol" (net exposure/VWAP/floating P&L aggregate), "Open
    // positions" (the flat per-position list with Close/Modify), then
    // the broker-wide live activity feed below.
    //
    // Not ported in this pass (disclosed, not silently dropped): the
    // web's maker-checker "pending approvals" queue for position actions,
    // column resize/visibility/virtualized scrolling, and a dedicated IB
    // filter dropdown (the data has no IB account label to show, only a
    // raw id) -- Group filter is included since group names are real and
    // meaningful.
    fn render_positions(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Positions);
            }
            if self.positions_loading {
                ui.spinner();
                ui.label("Loading...");
            }
            ui.weak(format!("{} open positions", self.positions.len()));
        });
        ui.add_space(8.0);

        if let Some(err) = &self.positions_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }

        // --- Filters ---
        let mut symbols: Vec<String> = self.positions.iter().map(|p| p.symbol_name.clone()).collect();
        symbols.sort();
        symbols.dedup();
        let mut accounts: Vec<(String, String)> = self
            .positions
            .iter()
            .map(|p| (p.account_id.clone(), format!("{}, {}", p.account_number, p.account_full_name)))
            .collect();
        accounts.sort_by(|a, b| a.1.cmp(&b.1));
        accounts.dedup_by(|a, b| a.0 == b.0);
        let mut groups: Vec<String> = self.positions.iter().filter_map(|p| p.group_name.clone()).collect();
        groups.sort();
        groups.dedup();

        theme::card(12).show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.label("Symbol:");
                egui::ComboBox::from_id_salt("exposure-symbol-filter")
                    .selected_text(if self.exposure_symbol_filter == "ALL" { "All".to_string() } else { self.exposure_symbol_filter.clone() })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.exposure_symbol_filter, "ALL".to_string(), "All");
                        for s in &symbols {
                            ui.selectable_value(&mut self.exposure_symbol_filter, s.clone(), s);
                        }
                    });
                ui.add_space(10.0);
                ui.label("Account:");
                let account_label = accounts
                    .iter()
                    .find(|(id, _)| id == &self.exposure_account_filter)
                    .map(|(_, l)| l.clone())
                    .unwrap_or_else(|| "All".to_string());
                egui::ComboBox::from_id_salt("exposure-account-filter")
                    .selected_text(account_label)
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.exposure_account_filter, "ALL".to_string(), "All");
                        for (id, label) in &accounts {
                            ui.selectable_value(&mut self.exposure_account_filter, id.clone(), label);
                        }
                    });
                ui.add_space(10.0);
                ui.label("Group:");
                egui::ComboBox::from_id_salt("exposure-group-filter")
                    .selected_text(if self.exposure_group_filter == "ALL" { "All".to_string() } else { self.exposure_group_filter.clone() })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.exposure_group_filter, "ALL".to_string(), "All");
                        ui.selectable_value(&mut self.exposure_group_filter, NO_GROUP.to_string(), "Ungrouped");
                        for g in &groups {
                            ui.selectable_value(&mut self.exposure_group_filter, g.clone(), g);
                        }
                    });
                ui.add_space(10.0);
                ui.label("Side:");
                egui::ComboBox::from_id_salt("exposure-side-filter")
                    .selected_text(match self.exposure_side_filter {
                        ExposureSideFilter::All => "All",
                        ExposureSideFilter::Buy => "Long (BUY)",
                        ExposureSideFilter::Sell => "Short (SELL)",
                    })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.exposure_side_filter, ExposureSideFilter::All, "All");
                        ui.selectable_value(&mut self.exposure_side_filter, ExposureSideFilter::Buy, "Long (BUY)");
                        ui.selectable_value(&mut self.exposure_side_filter, ExposureSideFilter::Sell, "Short (SELL)");
                    });
                ui.add_space(10.0);
                ui.label("P&L:");
                egui::ComboBox::from_id_salt("exposure-pl-filter")
                    .selected_text(match self.exposure_pl_filter {
                        ExposurePlFilter::All => "All",
                        ExposurePlFilter::Profit => "Profit",
                        ExposurePlFilter::Loss => "Loss",
                    })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.exposure_pl_filter, ExposurePlFilter::All, "All");
                        ui.selectable_value(&mut self.exposure_pl_filter, ExposurePlFilter::Profit, "Profit");
                        ui.selectable_value(&mut self.exposure_pl_filter, ExposurePlFilter::Loss, "Loss");
                    });
                if self.exposure_symbol_filter != "ALL"
                    || self.exposure_account_filter != "ALL"
                    || self.exposure_group_filter != "ALL"
                    || self.exposure_side_filter != ExposureSideFilter::All
                    || self.exposure_pl_filter != ExposurePlFilter::All
                {
                    ui.add_space(10.0);
                    if ui.button("Clear filters").clicked() {
                        self.exposure_symbol_filter = "ALL".to_string();
                        self.exposure_account_filter = "ALL".to_string();
                        self.exposure_group_filter = "ALL".to_string();
                        self.exposure_side_filter = ExposureSideFilter::All;
                        self.exposure_pl_filter = ExposurePlFilter::All;
                    }
                }
            });
        });
        ui.add_space(10.0);

        let filtered: Vec<&PositionRow> = self
            .positions
            .iter()
            .filter(|p| self.exposure_symbol_filter == "ALL" || p.symbol_name == self.exposure_symbol_filter)
            .filter(|p| self.exposure_account_filter == "ALL" || p.account_id == self.exposure_account_filter)
            .filter(|p| {
                if self.exposure_group_filter == "ALL" {
                    true
                } else if self.exposure_group_filter == NO_GROUP {
                    p.group_name.is_none()
                } else {
                    p.group_name.as_deref() == Some(self.exposure_group_filter.as_str())
                }
            })
            .filter(|p| match self.exposure_side_filter {
                ExposureSideFilter::All => true,
                ExposureSideFilter::Buy => p.side == "BUY",
                ExposureSideFilter::Sell => p.side == "SELL",
            })
            .filter(|p| {
                let pnl = p.floating_pnl.as_deref().and_then(|s| s.parse::<f64>().ok());
                match self.exposure_pl_filter {
                    ExposurePlFilter::All => true,
                    ExposurePlFilter::Profit => pnl.is_some_and(|v| v > 0.0),
                    ExposurePlFilter::Loss => pnl.is_some_and(|v| v < 0.0),
                }
            })
            .collect();

        // --- Exposure by symbol (net exposure / net-side VWAP / P&L) ---
        struct ExposureAcc {
            symbol: String,
            count: usize,
            buy_volume: f64,
            sell_volume: f64,
            buy_notional: f64,
            sell_notional: f64,
            current_price: Option<String>,
            floating_pnl: f64,
        }
        let mut by_symbol: HashMap<String, ExposureAcc> = HashMap::new();
        for p in &filtered {
            let entry = by_symbol.entry(p.symbol_name.clone()).or_insert(ExposureAcc {
                symbol: p.symbol_name.clone(),
                count: 0,
                buy_volume: 0.0,
                sell_volume: 0.0,
                buy_notional: 0.0,
                sell_notional: 0.0,
                current_price: p.current_price.clone(),
                floating_pnl: 0.0,
            });
            entry.count += 1;
            let volume: f64 = p.volume.parse().unwrap_or(0.0);
            let open_price: f64 = p.open_price.parse().unwrap_or(0.0);
            if p.side == "BUY" {
                entry.buy_volume += volume;
                entry.buy_notional += volume * open_price;
            } else {
                entry.sell_volume += volume;
                entry.sell_notional += volume * open_price;
            }
            if let Some(pnl) = p.floating_pnl.as_deref().and_then(|s| s.parse::<f64>().ok()) {
                entry.floating_pnl += pnl;
            }
        }
        let mut exposure_rows: Vec<(ExposureAcc, f64, Option<f64>)> = by_symbol
            .into_values()
            .map(|e| {
                let net = e.buy_volume - e.sell_volume;
                let buy_avg = if e.buy_volume > 0.0 { Some(e.buy_notional / e.buy_volume) } else { None };
                let sell_avg = if e.sell_volume > 0.0 { Some(e.sell_notional / e.sell_volume) } else { None };
                let net_avg = if net > 0.0 { buy_avg } else if net < 0.0 { sell_avg } else { None };
                (e, net, net_avg)
            })
            .collect();
        match self.exposure_sort_mode {
            ExposureSortMode::Symbol => exposure_rows.sort_by(|a, b| a.0.symbol.cmp(&b.0.symbol)),
            ExposureSortMode::Exposure => exposure_rows.sort_by(|a, b| b.1.abs().partial_cmp(&a.1.abs()).unwrap_or(std::cmp::Ordering::Equal)),
            ExposureSortMode::Risk => exposure_rows.sort_by(|a, b| b.0.floating_pnl.partial_cmp(&a.0.floating_pnl).unwrap_or(std::cmp::Ordering::Equal)),
        }
        let total_floating_pnl: f64 = filtered.iter().filter_map(|p| p.floating_pnl.as_deref().and_then(|s| s.parse::<f64>().ok())).sum();

        theme::card(12).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.strong(format!("Exposure by symbol -- {} position{} in view", filtered.len(), if filtered.len() == 1 { "" } else { "s" }));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let pnl_color = if total_floating_pnl > 0.0 {
                        theme::accent()
                    } else if total_floating_pnl < 0.0 {
                        theme::DANGER
                    } else {
                        ui.visuals().text_color()
                    };
                    ui.colored_label(pnl_color, egui::RichText::new(format!("{total_floating_pnl:.2}")).monospace().size(15.0));
                    ui.label("Total floating P&L:");
                    ui.add_space(14.0);
                    egui::ComboBox::from_id_salt("exposure-sort-mode")
                        .selected_text(match self.exposure_sort_mode {
                            ExposureSortMode::Symbol => "Symbol",
                            ExposureSortMode::Exposure => "Exposure",
                            ExposureSortMode::Risk => "Risk",
                        })
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut self.exposure_sort_mode, ExposureSortMode::Symbol, "Symbol");
                            ui.selectable_value(&mut self.exposure_sort_mode, ExposureSortMode::Exposure, "Exposure");
                            ui.selectable_value(&mut self.exposure_sort_mode, ExposureSortMode::Risk, "Risk");
                        });
                    ui.label("Sort by:");
                });
            });
            ui.add_space(6.0);
            TableBuilder::new(ui)
                .striped(true)
                .resizable(true)
                .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
                .column(Column::auto().at_least(80.0))
                .column(Column::auto().at_least(70.0))
                .column(Column::auto().at_least(90.0))
                .column(Column::auto().at_least(90.0))
                .column(Column::auto().at_least(100.0))
                .column(Column::auto().at_least(120.0))
                .column(Column::auto().at_least(110.0))
                .column(Column::remainder().at_least(100.0))
                .header(26.0, |mut header| {
                    for label in ["Symbol", "Positions", "Buy volume", "Sell volume", "Net exposure", "Avg open price (net)", "Client floating P&L", "Current price"] {
                        header.col(|ui| {
                            ui.label(egui::RichText::new(label.to_uppercase()).size(11.0).color(theme::TEXT_3));
                        });
                    }
                })
                .body(|body| {
                    body.rows(24.0, exposure_rows.len(), |mut row| {
                        let (e, net, net_avg) = &exposure_rows[row.index()];
                        row.col(|ui| {
                            ui.monospace(&e.symbol);
                        });
                        row.col(|ui| {
                            ui.label(e.count.to_string());
                        });
                        row.col(|ui| {
                            ui.monospace(format!("{:.2}", e.buy_volume));
                        });
                        row.col(|ui| {
                            ui.monospace(format!("{:.2}", e.sell_volume));
                        });
                        row.col(|ui| {
                            let color = if *net == 0.0 {
                                ui.visuals().text_color()
                            } else if *net > 0.0 {
                                theme::accent()
                            } else {
                                theme::DANGER
                            };
                            ui.colored_label(color, format!("{}{:.2}", if *net > 0.0 { "+" } else { "" }, net));
                        });
                        row.col(|ui| {
                            ui.monospace(net_avg.map(|v| format!("{v:.5}")).unwrap_or_else(|| "-".to_string()));
                        });
                        row.col(|ui| {
                            let color = if e.floating_pnl > 0.0 {
                                theme::accent()
                            } else if e.floating_pnl < 0.0 {
                                theme::DANGER
                            } else {
                                ui.visuals().text_color()
                            };
                            ui.colored_label(color, format!("{:.2}", e.floating_pnl));
                        });
                        row.col(|ui| {
                            ui.monospace(e.current_price.as_deref().unwrap_or("-"));
                        });
                    });
                });
        });
        ui.add_space(10.0);

        // --- Open positions (flat list, Close/Modify) ---
        theme::card(12).show(ui, |ui| {
            ui.strong(format!("Open positions -- {}", filtered.len()));
            ui.add_space(6.0);

            let mut modify_target: Option<PositionRow> = None;
            let mut close_target: Option<PositionRow> = None;

            TableBuilder::new(ui)
                .striped(true)
                .resizable(true)
                .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
                .column(Column::auto().at_least(100.0))
                .column(Column::remainder().at_least(140.0))
                .column(Column::auto().at_least(80.0))
                .column(Column::auto().at_least(50.0))
                .column(Column::auto().at_least(80.0))
                .column(Column::auto().at_least(80.0))
                .column(Column::auto().at_least(80.0))
                .column(Column::auto().at_least(70.0))
                .column(Column::auto().at_least(70.0))
                .column(Column::auto().at_least(90.0))
                .column(Column::auto().at_least(140.0))
                .column(Column::auto().at_least(140.0))
                .header(28.0, |mut header| {
                    for label in ["Account", "Client", "Symbol", "Side", "Volume", "Open", "Current", "S/L", "T/P", "Floating P/L", "Opened", "Action"] {
                        header.col(|ui| {
                            ui.label(egui::RichText::new(label.to_uppercase()).size(11.0).color(theme::TEXT_3));
                        });
                    }
                })
                .body(|body| {
                    body.rows(26.0, filtered.len(), |mut row| {
                        let p = filtered[row.index()];
                        row.col(|ui| {
                            ui.monospace(&p.account_number);
                        });
                        row.col(|ui| {
                            ui.label(&p.account_full_name);
                            if p.mirrored {
                                ui.weak("(mirrored)");
                            }
                        });
                        row.col(|ui| {
                            ui.monospace(&p.symbol_name);
                        });
                        row.col(|ui| {
                            let color = if p.side == "BUY" { theme::accent() } else { theme::DANGER };
                            ui.colored_label(color, &p.side);
                        });
                        row.col(|ui| {
                            ui.monospace(&p.volume);
                        });
                        row.col(|ui| {
                            ui.monospace(&p.open_price);
                        });
                        row.col(|ui| {
                            ui.monospace(p.current_price.as_deref().unwrap_or("-"));
                        });
                        row.col(|ui| {
                            ui.monospace(p.sl_price.as_deref().unwrap_or("-"));
                        });
                        row.col(|ui| {
                            ui.monospace(p.tp_price.as_deref().unwrap_or("-"));
                        });
                        row.col(|ui| {
                            let pnl_text = p.floating_pnl.as_deref().unwrap_or("-");
                            let color = match p.floating_pnl.as_deref().and_then(|s| s.parse::<f64>().ok()) {
                                Some(v) if v > 0.0 => theme::accent(),
                                Some(v) if v < 0.0 => theme::DANGER,
                                _ => ui.visuals().text_color(),
                            };
                            ui.colored_label(color, pnl_text);
                        });
                        row.col(|ui| {
                            ui.weak(&p.opened_at);
                        });
                        row.col(|ui| {
                            if ui.small_button("Modify").clicked() {
                                modify_target = Some(p.clone());
                            }
                            if ui.small_button("Close").clicked() {
                                close_target = Some(p.clone());
                            }
                        });
                    });
                });

            if let Some(p) = modify_target {
                self.position_modify = Some(PendingModify {
                    id: p.id.clone(),
                    account_number: p.account_number.clone(),
                    symbol: p.symbol_name.clone(),
                    sl: p.sl_price.clone().unwrap_or_default(),
                    tp: p.tp_price.clone().unwrap_or_default(),
                    reason: String::new(),
                    error: None,
                });
            }
            if let Some(p) = close_target {
                self.position_close_confirm = Some((p.id.clone(), format!("{} {} {} {}", p.account_number, p.symbol_name, p.side, p.volume)));
            }
        });

        // --- Modify SL/TP modal ---
        if let Some(mut modify) = self.position_modify.take() {
            let mut open = true;
            let mut submit = false;
            egui::Window::new(format!("Modify {} -- {}", modify.symbol, modify.account_number))
                .id(egui::Id::new("modify-position-window"))
                .collapsible(false)
                .resizable(false)
                .open(&mut open)
                .show(ctx, |ui| {
                    ui.label("S/L");
                    ui.text_edit_singleline(&mut modify.sl);
                    ui.label("T/P");
                    ui.text_edit_singleline(&mut modify.tp);
                    ui.label("Reason (required, logged in audit trail)");
                    ui.text_edit_singleline(&mut modify.reason);
                    if let Some(err) = &modify.error {
                        ui.colored_label(theme::DANGER, err);
                    }
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        if theme::accent_button(ui, "Save").clicked() {
                            submit = true;
                        }
                    });
                });
            if submit {
                if modify.reason.trim().is_empty() {
                    modify.error = Some("Reason is required for the audit trail".to_string());
                    self.position_modify = Some(modify);
                } else if let Some(api) = &self.api {
                    api.modify_position(
                        ctx.clone(),
                        self.tx.clone(),
                        modify.id.clone(),
                        Some(modify.sl.clone()),
                        Some(modify.tp.clone()),
                        modify.reason.clone(),
                    );
                }
            } else if open {
                self.position_modify = Some(modify);
            }
        }

        // --- Close confirm modal ---
        if let Some((id, description)) = self.position_close_confirm.clone() {
            let mut open = true;
            let mut confirm = false;
            egui::Window::new("Close position?")
                .id(egui::Id::new("close-position-window"))
                .collapsible(false)
                .resizable(false)
                .open(&mut open)
                .show(ctx, |ui| {
                    ui.label(format!("Close the full position: {description}?"));
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        if theme::danger_button_enabled(ui, true, "Close position").clicked() {
                            confirm = true;
                        }
                    });
                });
            if confirm {
                if let Some(api) = &self.api {
                    api.close_position(ctx.clone(), self.tx.clone(), id, None);
                }
                self.position_close_confirm = None;
            } else if !open {
                self.position_close_confirm = None;
            }
        }

        ui.add_space(10.0);

        // --- Live activity (broker-wide, every account -- not just
        // DEALING-group; the Dealing page's own feed below is scoped to
        // DEALING-group only, matching LiveActivityFeed.tsx vs.
        // DealingDeskPanel.tsx on the web) ---
        theme::card(12).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.strong("Live activity");
                ui.weak("All live trading activity.");
                if self.live_activity_loading {
                    ui.spinner();
                }
            });
            ui.add_space(6.0);
            if let Some(err) = &self.live_activity_error {
                ui.colored_label(theme::DANGER, err);
            } else if self.live_activity.is_empty() {
                ui.weak("No activity yet.");
            } else {
                egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| {
                    render_activity_feed_rows(ui, &self.live_activity, true);
                });
            }
        });
    }

    fn render_accounts(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Accounts);
            }
            if ui.button(if self.show_new_account_form { "Cancel" } else { "+ New account" }).clicked() {
                self.show_new_account_form = !self.show_new_account_form;
            }
            ui.add(egui::TextEdit::singleline(&mut self.accounts_filter).hint_text("Search by name, email, or account #..."));
            if self.accounts_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if self.show_new_account_form {
            theme::card(14).show(ui, |ui| {
                ui.label("Full name");
                ui.text_edit_singleline(&mut self.new_account.full_name);
                ui.label("Email");
                ui.text_edit_singleline(&mut self.new_account.email);
                ui.label("Password");
                ui.add(egui::TextEdit::singleline(&mut self.new_account.password).password(true));
                ui.checkbox(&mut self.new_account.is_live, "Live account (unchecked = Demo)");
                ui.add_space(8.0);
                let valid = !self.new_account.full_name.trim().is_empty()
                    && self.new_account.email.contains('@')
                    && self.new_account.password.len() >= 8;
                if theme::accent_button_enabled(ui, valid, "Create").clicked() {
                    if let Some(api) = &self.api {
                        api.create_account(
                            ctx.clone(),
                            self.tx.clone(),
                            NewAccountBody {
                                full_name: self.new_account.full_name.trim().to_string(),
                                email: self.new_account.email.trim().to_string(),
                                password: self.new_account.password.clone(),
                                account_mode: if self.new_account.is_live { "LIVE".into() } else { "DEMO".into() },
                            },
                        );
                    }
                }
                if !valid {
                    ui.weak("Password must be at least 8 characters.");
                }
            });
            ui.add_space(10.0);
        }

        if let Some(err) = &self.accounts_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }

        let filter = self.accounts_filter.to_lowercase();
        let visible_indices: Vec<usize> = self
            .accounts
            .iter()
            .enumerate()
            .filter(|(_, a)| {
                filter.is_empty()
                    || a.full_name.to_lowercase().contains(&filter)
                    || a.email.to_lowercase().contains(&filter)
                    || a.account_number.to_lowercase().contains(&filter)
            })
            .map(|(i, _)| i)
            .collect();

        let mut pending_status_change: Option<(String, String)> = None;

        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(90.0))
            .column(Column::remainder().at_least(160.0))
            .column(Column::auto().at_least(180.0))
            .column(Column::auto().at_least(60.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(70.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(120.0))
            .header(28.0, |mut header| {
                for label in ["Account", "Client", "Email", "Mode", "Balance", "Lev.", "Group", "Status", "Action"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, visible_indices.len(), |mut row| {
                    let a = &self.accounts[visible_indices[row.index()]];
                    row.col(|ui| {
                        ui.monospace(&a.account_number);
                    });
                    row.col(|ui| {
                        ui.label(&a.full_name);
                    });
                    row.col(|ui| {
                        ui.weak(&a.email);
                    });
                    row.col(|ui| {
                        ui.label(&a.account_mode);
                    });
                    row.col(|ui| {
                        ui.monospace(format!("{} {}", a.currency, a.balance));
                    });
                    row.col(|ui| {
                        ui.monospace(format!("1:{}", a.leverage));
                    });
                    row.col(|ui| {
                        ui.weak(a.group_name.as_deref().unwrap_or("-"));
                    });
                    row.col(|ui| {
                        let color = match a.status.as_str() {
                            "ACTIVE" => theme::accent(),
                            "SUSPENDED" => theme::WARNING,
                            _ => theme::TEXT_3,
                        };
                        ui.colored_label(color, &a.status);
                    });
                    row.col(|ui| {
                        let next_status = if a.status == "ACTIVE" { "SUSPENDED" } else { "ACTIVE" };
                        let action_label = if a.status == "ACTIVE" { "Suspend" } else { "Reactivate" };
                        if a.status != "CLOSED" && ui.small_button(action_label).clicked() {
                            pending_status_change = Some((a.id.clone(), next_status.to_string()));
                        }
                    });
                });
            });

        if let Some((account_id, status)) = pending_status_change {
            if let Some(api) = &self.api {
                api.set_account_status(ctx.clone(), self.tx.clone(), account_id, status);
            }
        }
    }

    // Direct native port of the web's Dealing page: DealerDeskToggle at
    // the top, then DealingTabs' "queue" tab content stacked exactly as
    // page.tsx composes it -- DealingQueueManager (queue table +
    // "Awaiting client confirmation" requoted table) followed directly by
    // DealingDeskPanel (resting orders + the DEALING-group-scoped
    // activity feed, filterable by account). The web's separate "Mirror"
    // tab (MirrorRulesManager) isn't ported in this pass.
    fn render_dealing(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Dealing);
            }
            if self.dealing_loading || self.dealing_desk_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        // --- Dealer ON/OFF toggle ---
        if let Some(state) = &self.dealer_toggle {
            let dealer_on = state.dealer_on;
            let bg = if dealer_on { theme::BG_1 } else { theme::WARNING.gamma_multiply(0.12) };
            egui::Frame::new()
                .fill(bg)
                .stroke(egui::Stroke::new(1.0_f32, if dealer_on { theme::BORDER } else { theme::WARNING }))
                .corner_radius(egui::CornerRadius::same(10))
                .inner_margin(egui::Margin::symmetric(16, 12))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let switch_color = if dealer_on { theme::accent() } else { theme::TEXT_3 };
                        let (rect, resp) = ui.allocate_exact_size(egui::vec2(48.0, 26.0), egui::Sense::click());
                        ui.painter().rect_filled(rect, egui::CornerRadius::same(13), switch_color);
                        let knob_x = if dealer_on { rect.right() - 15.0 } else { rect.left() + 15.0 };
                        ui.painter().circle_filled(egui::pos2(knob_x, rect.center().y), 9.0, egui::Color32::WHITE);
                        if resp.clicked() && !self.dealer_toggle_busy {
                            if dealer_on {
                                self.dealer_toggle_confirm_off = true;
                            } else if let Some(api) = &self.api {
                                self.dealer_toggle_busy = true;
                                api.set_dealer_toggle(ctx.clone(), self.tx.clone(), true);
                            }
                        }
                        ui.add_space(10.0);
                        ui.vertical(|ui| {
                            ui.strong(if dealer_on { "Dealer ON" } else { "Dealer OFF" });
                            ui.weak(if dealer_on {
                                "Orders from dealing-group accounts require manual review."
                            } else {
                                "Orders from dealing-group accounts auto-fill at market."
                            });
                        });
                    });
                });

            if self.dealer_toggle_confirm_off {
                let mut open = true;
                let mut confirm = false;
                egui::Window::new("Turn dealer off?")
                    .id(egui::Id::new("dealer-off-confirm"))
                    .collapsible(false)
                    .resizable(false)
                    .open(&mut open)
                    .show(ctx, |ui| {
                        ui.label("Dealing-group orders will auto-fill at market instead of waiting for review. Anything currently sitting in the queue will be filled at market right now too, unless it fails a risk check, in which case it stays queued.");
                        ui.add_space(6.0);
                        ui.horizontal(|ui| {
                            if theme::danger_button_enabled(ui, true, "Turn dealer off").clicked() {
                                confirm = true;
                            }
                        });
                    });
                if confirm {
                    self.dealer_toggle_confirm_off = false;
                    if let Some(api) = &self.api {
                        self.dealer_toggle_busy = true;
                        api.set_dealer_toggle(ctx.clone(), self.tx.clone(), false);
                    }
                } else if !open {
                    self.dealer_toggle_confirm_off = false;
                }
            }
            ui.add_space(10.0);
        }

        if let Some(err) = &self.dealing_error {
            ui.colored_label(theme::DANGER, err);
        }

        let mut accept_id: Option<String> = None;
        let mut confirm_reject: Option<(String, String)> = None;
        let mut confirm_requote: Option<(String, f64)> = None;

        theme::card(12).show(ui, |ui| {
            ui.label(format!(
                "{} order{} awaiting manual review, {} awaiting the client's answer to a requote. Only populated while dealing mode is on.",
                self.dealing_queue.len(),
                if self.dealing_queue.len() == 1 { "" } else { "s" },
                self.dealing_requoted.len()
            ));
            ui.add_space(6.0);

            for order in self.dealing_queue.clone() {
                theme::card(10).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let side_color = if order.side == "BUY" { theme::accent() } else { theme::DANGER };
                        ui.monospace(&order.account_number);
                        ui.label(&order.account_full_name);
                        ui.separator();
                        ui.strong(&order.symbol);
                        ui.colored_label(side_color, &order.side);
                        ui.label(format!("{} lots", order.volume));
                        if let Some(req) = &order.requested_price {
                            ui.weak(format!("requested @ {req}"));
                        }
                        if let (Some(bid), Some(ask)) = (&order.live_bid, &order.live_ask) {
                            ui.weak(format!("live {bid} / {ask}"));
                        }
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Reject").clicked() {
                                self.dealing_reject = Some(PendingReject { id: order.id.clone(), reason: String::new() });
                            }
                            if ui.button("Requote").clicked() {
                                let live = if order.side == "BUY" { &order.live_ask } else { &order.live_bid };
                                let price = live.clone().or_else(|| order.requested_price.clone()).unwrap_or_default();
                                self.dealing_requote = Some(PendingRequote { id: order.id.clone(), price, error: None });
                            }
                            if theme::accent_button(ui, "Accept").clicked() {
                                accept_id = Some(order.id.clone());
                            }
                        });
                    });

                    if self.dealing_reject.as_ref().is_some_and(|p| p.id == order.id) {
                        let mut pending = self.dealing_reject.take().unwrap();
                        let mut cancelled = false;
                        ui.horizontal(|ui| {
                            ui.label("Reason (required, logged in audit trail):");
                            ui.text_edit_singleline(&mut pending.reason);
                            if theme::danger_button_enabled(ui, !pending.reason.trim().is_empty(), "Confirm reject").clicked() {
                                confirm_reject = Some((pending.id.clone(), pending.reason.clone()));
                            }
                            if ui.button("Cancel").clicked() {
                                cancelled = true;
                            }
                        });
                        if !cancelled && confirm_reject.is_none() {
                            self.dealing_reject = Some(pending);
                        }
                    }

                    if self.dealing_requote.as_ref().is_some_and(|p| p.id == order.id) {
                        let mut pending = self.dealing_requote.take().unwrap();
                        let mut cancelled = false;
                        ui.horizontal(|ui| {
                            ui.label("Requote price:");
                            ui.text_edit_singleline(&mut pending.price);
                            if theme::accent_button(ui, "Send requote").clicked() {
                                match pending.price.trim().parse::<f64>() {
                                    Ok(p) if p > 0.0 => confirm_requote = Some((pending.id.clone(), p)),
                                    _ => pending.error = Some("Enter a valid price".to_string()),
                                }
                            }
                            if ui.button("Cancel").clicked() {
                                cancelled = true;
                            }
                        });
                        if let Some(err) = &pending.error {
                            ui.colored_label(theme::DANGER, err);
                        }
                        if !cancelled && confirm_requote.is_none() {
                            self.dealing_requote = Some(pending);
                        }
                    }
                });
            }
            if self.dealing_queue.is_empty() {
                ui.weak("No orders awaiting review.");
            }
        });

        ui.add_space(10.0);
        theme::card(12).show(ui, |ui| {
            ui.strong("Awaiting client confirmation");
            ui.add_space(6.0);
            if self.dealing_requoted.is_empty() {
                ui.weak("No requotes awaiting a client response.");
            }
            let mut withdraw_id: Option<String> = None;
            for row in &self.dealing_requoted {
                ui.horizontal(|ui| {
                    let side_color = if row.side == "BUY" { theme::accent() } else { theme::DANGER };
                    ui.monospace(&row.account_number);
                    ui.label(&row.account_full_name);
                    ui.separator();
                    ui.strong(&row.symbol);
                    ui.colored_label(side_color, &row.side);
                    ui.label(format!("{} lots", row.volume));
                    ui.weak(format!("requested {}", row.requested_price.as_deref().unwrap_or("-")));
                    ui.weak(format!("requoted to {} at {}", row.requoted_price.as_deref().unwrap_or("-"), row.created_at));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("Withdraw").clicked() {
                            withdraw_id = Some(row.id.clone());
                        }
                    });
                });
                ui.separator();
            }
            if let Some(id) = withdraw_id {
                if let Some(api) = &self.api {
                    api.dealing_action(ctx.clone(), self.tx.clone(), id, "REJECT".to_string(), Some("Withdrawn by dealer".to_string()), None);
                }
            }
        });

        if let Some(id) = accept_id {
            if let Some(api) = &self.api {
                api.dealing_action(ctx.clone(), self.tx.clone(), id, "ACCEPT".to_string(), None, None);
            }
        }
        if let Some((id, reason)) = confirm_reject {
            if let Some(api) = &self.api {
                api.dealing_action(ctx.clone(), self.tx.clone(), id, "REJECT".to_string(), Some(reason), None);
            }
        }
        if let Some((id, price)) = confirm_requote {
            if let Some(api) = &self.api {
                api.dealing_action(ctx.clone(), self.tx.clone(), id, "REQUOTE".to_string(), None, Some(price));
            }
        }

        ui.add_space(10.0);

        // --- Resting orders (DEALING-group LIMIT/STOP, persistent) ---
        theme::card(12).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.strong("Resting orders");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let label = self
                        .dealing_desk_accounts
                        .iter()
                        .find(|a| a.id == self.dealing_desk_account_filter)
                        .map(|a| format!("{}, {}", a.account_number, a.full_name))
                        .unwrap_or_else(|| "All dealing-group accounts".to_string());
                    egui::ComboBox::from_id_salt("dealing-desk-account-filter").selected_text(label).show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.dealing_desk_account_filter, "ALL".to_string(), "All dealing-group accounts");
                        for a in &self.dealing_desk_accounts {
                            ui.selectable_value(&mut self.dealing_desk_account_filter, a.id.clone(), format!("{}, {}", a.account_number, a.full_name));
                        }
                    });
                });
            });
            ui.add_space(6.0);
            let filter = |accid: &str| self.dealing_desk_account_filter == "ALL" || self.dealing_desk_account_filter == accid;
            let resting: Vec<&RestingOrderRow> = self.dealing_desk_resting.iter().filter(|r| filter(&r.account_id)).collect();
            if let Some(err) = &self.dealing_desk_error {
                ui.colored_label(theme::DANGER, err);
            } else if resting.is_empty() {
                ui.weak("No resting orders on dealing-group accounts right now.");
            } else {
                TableBuilder::new(ui)
                    .striped(true)
                    .resizable(true)
                    .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
                    .column(Column::auto().at_least(100.0))
                    .column(Column::remainder().at_least(120.0))
                    .column(Column::auto().at_least(70.0))
                    .column(Column::auto().at_least(70.0))
                    .column(Column::auto().at_least(50.0))
                    .column(Column::auto().at_least(80.0))
                    .column(Column::auto().at_least(80.0))
                    .column(Column::auto().at_least(70.0))
                    .column(Column::auto().at_least(70.0))
                    .column(Column::auto().at_least(140.0))
                    .header(26.0, |mut header| {
                        for label in ["Account", "Client", "Symbol", "Type", "Side", "Volume", "Price", "S/L", "T/P", "Placed"] {
                            header.col(|ui| {
                                ui.label(egui::RichText::new(label.to_uppercase()).size(11.0).color(theme::TEXT_3));
                            });
                        }
                    })
                    .body(|body| {
                        body.rows(24.0, resting.len(), |mut row| {
                            let r = resting[row.index()];
                            row.col(|ui| {
                                ui.monospace(&r.account_number);
                            });
                            row.col(|ui| {
                                ui.label(&r.account_full_name);
                            });
                            row.col(|ui| {
                                ui.monospace(&r.symbol);
                            });
                            row.col(|ui| {
                                ui.label(&r.order_type);
                            });
                            row.col(|ui| {
                                let color = if r.side == "BUY" { theme::accent() } else { theme::DANGER };
                                ui.colored_label(color, &r.side);
                            });
                            row.col(|ui| {
                                ui.monospace(&r.volume);
                            });
                            row.col(|ui| {
                                ui.monospace(r.requested_price.as_deref().unwrap_or("-"));
                            });
                            row.col(|ui| {
                                ui.monospace(r.sl_price.as_deref().unwrap_or("-"));
                            });
                            row.col(|ui| {
                                ui.monospace(r.tp_price.as_deref().unwrap_or("-"));
                            });
                            row.col(|ui| {
                                ui.weak(&r.created_at);
                            });
                        });
                    });
            }
        });

        ui.add_space(10.0);

        // --- Dealing-group activity feed (DEALING-only, unlike Live
        // Exposure's broker-wide one) ---
        theme::card(12).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.strong("Dealing-group activity feed");
                ui.weak("Every action on a DEALING-group account, live.");
            });
            ui.add_space(6.0);
            let filter = |accid: &str| self.dealing_desk_account_filter == "ALL" || self.dealing_desk_account_filter == accid;
            let feed: Vec<ActivityFeedRow> = self.dealing_desk_feed.iter().filter(|r| filter(&r.account_id)).cloned().collect();
            if feed.is_empty() {
                ui.weak("No activity yet.");
            } else {
                egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| {
                    render_activity_feed_rows(ui, &feed, false);
                });
            }
        });
    }

    fn render_groups(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if let Some(group) = self.selected_group.clone() {
            ui.horizontal(|ui| {
                if ui.button("< Back to groups").clicked() {
                    self.selected_group = None;
                    self.group_pricing.clear();
                }
                ui.heading(format!("{} -- per-symbol pricing", group.name));
                if self.group_pricing_loading {
                    ui.spinner();
                }
            });
            ui.weak("Editing Spread markup and Commission per lot only in this pass -- swap rates and target-spread mode aren't wired here yet.");
            ui.add_space(8.0);

            if let Some(err) = &self.group_pricing_error {
                ui.colored_label(theme::DANGER, err);
                return;
            }

            let mut save_target: Option<(String, String, String)> = None;

            TableBuilder::new(ui)
                .striped(true)
                .resizable(true)
                .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
                .column(Column::exact(100.0))
                .column(Column::exact(160.0))
                .column(Column::exact(160.0))
                .column(Column::exact(110.0))
                .column(Column::remainder().at_least(90.0))
                .header(28.0, |mut header| {
                    for label in ["Symbol", "Spread markup (pips)", "Commission / lot", "Override?", "Action"] {
                        header.col(|ui| {
                            ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                        });
                    }
                })
                .body(|body| {
                    body.rows(28.0, self.group_pricing.len(), |mut row| {
                        let p = &self.group_pricing[row.index()];
                        let (spread_input, commission_input) =
                            self.pricing_edit_buffer.entry(p.symbol_id.clone()).or_insert_with(|| {
                                (p.spread_markup.clone().unwrap_or_default(), p.commission_per_lot.clone().unwrap_or_default())
                            });
                        row.col(|ui| {
                            ui.monospace(&p.symbol_name);
                        });
                        row.col(|ui| {
                            ui.add(
                                egui::TextEdit::singleline(spread_input)
                                    .hint_text(format!("inherit ({})", p.default_spread_markup)),
                            );
                        });
                        row.col(|ui| {
                            ui.add(
                                egui::TextEdit::singleline(commission_input)
                                    .hint_text(format!("inherit ({})", p.default_commission_per_lot)),
                            );
                        });
                        row.col(|ui| {
                            if p.has_override {
                                ui.colored_label(theme::accent(), "custom");
                            } else {
                                ui.weak("broker default");
                            }
                        });
                        row.col(|ui| {
                            if theme::accent_button(ui, "Save").clicked() {
                                save_target = Some((p.symbol_id.clone(), spread_input.clone(), commission_input.clone()));
                            }
                        });
                    });
                });

            if let Some((symbol_id, spread, commission)) = save_target {
                if let Some(api) = &self.api {
                    api.update_group_pricing(ctx.clone(), self.tx.clone(), group.id.clone(), symbol_id, spread, commission);
                }
            }
            return;
        }

        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Groups);
            }
            if self.groups_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.groups_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }

        let mut open_group: Option<GroupRow> = None;
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::remainder().at_least(160.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(140.0))
            .header(28.0, |mut header| {
                for label in ["Name", "Type", "Tier", "Leverage", "Action"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.groups.len(), |mut row| {
                    let g = &self.groups[row.index()];
                    row.col(|ui| {
                        ui.label(&g.name);
                        if g.is_default {
                            ui.weak("(default)");
                        }
                    });
                    row.col(|ui| {
                        ui.monospace(&g.group_type);
                    });
                    row.col(|ui| {
                        ui.label(&g.tier);
                    });
                    row.col(|ui| {
                        ui.monospace(format!("1:{}", g.leverage));
                    });
                    row.col(|ui| {
                        if ui.small_button("Manage pricing").clicked() {
                            open_group = Some(g.clone());
                        }
                    });
                });
            });

        if let Some(group) = open_group {
            let group_id = group.id.clone();
            self.selected_group = Some(group);
            self.pricing_edit_buffer.clear();
            self.fetch_group_pricing(ctx, group_id);
        }
    }

    fn render_client_kyc(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::ClientKyc);
            }
            if self.client_kyc_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.client_kyc_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }

        let mut approve_id: Option<String> = None;
        let mut confirm_reject: Option<(String, String)> = None;

        for record in self.client_kyc.clone() {
            theme::card(10).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(&record.client_full_name);
                    ui.weak(&record.client_email);
                    ui.weak(record.client_country.as_deref().unwrap_or("-"));
                    ui.monospace(&record.document_type);
                    ui.weak(record.created_at.get(0..10).unwrap_or(&record.created_at));
                    let status_color = match record.status.as_str() {
                        "APPROVED" => theme::accent(),
                        "REJECTED" => theme::DANGER,
                        _ => theme::WARNING,
                    };
                    ui.colored_label(status_color, &record.status);
                    if record.status == "PENDING" {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if theme::accent_button(ui, "Approve").clicked() {
                                approve_id = Some(record.id.clone());
                            }
                            if ui.button("Reject").clicked() {
                                self.kyc_reject = Some(PendingReject { id: record.id.clone(), reason: String::new() });
                            }
                        });
                    }
                });
                if self.kyc_reject.as_ref().is_some_and(|p| p.id == record.id) {
                    let mut pending = self.kyc_reject.take().unwrap();
                    let mut cancelled = false;
                    ui.horizontal(|ui| {
                        ui.label("Rejection reason (required):");
                        ui.text_edit_singleline(&mut pending.reason);
                        if theme::danger_button_enabled(ui, !pending.reason.trim().is_empty(), "Confirm reject").clicked() {
                            confirm_reject = Some((pending.id.clone(), pending.reason.clone()));
                        }
                        if ui.button("Cancel").clicked() {
                            cancelled = true;
                        }
                    });
                    if !cancelled && confirm_reject.is_none() {
                        self.kyc_reject = Some(pending);
                    }
                }
            });
        }

        if let Some(id) = approve_id {
            if let Some(api) = &self.api {
                api.client_kyc_action(ctx.clone(), self.tx.clone(), id, "APPROVE".to_string(), None);
            }
        }
        if let Some((id, reason)) = confirm_reject {
            if let Some(api) = &self.api {
                api.client_kyc_action(ctx.clone(), self.tx.clone(), id, "REJECT".to_string(), Some(reason));
            }
        }
    }

    fn render_live_account_requests(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::LiveAccountRequests);
            }
            if self.live_account_requests_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.live_account_requests_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }

        let mut approve_id: Option<String> = None;
        let mut confirm_reject: Option<(String, String)> = None;

        for req in self.live_account_requests.clone() {
            theme::card(10).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(&req.client_full_name);
                    ui.weak(&req.client_email);
                    ui.monospace(req.account_type_name.as_deref().unwrap_or("-"));
                    ui.weak(req.created_at.get(0..10).unwrap_or(&req.created_at));
                    let status_color = match req.status.as_str() {
                        "APPROVED" => theme::accent(),
                        "REJECTED" => theme::DANGER,
                        _ => theme::WARNING,
                    };
                    ui.colored_label(status_color, &req.status);
                    if req.status == "PENDING" {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if theme::accent_button(ui, "Approve").clicked() {
                                approve_id = Some(req.id.clone());
                            }
                            if ui.button("Reject").clicked() {
                                self.live_account_reject = Some(PendingReject { id: req.id.clone(), reason: String::new() });
                            }
                        });
                    }
                });
                if self.live_account_reject.as_ref().is_some_and(|p| p.id == req.id) {
                    let mut pending = self.live_account_reject.take().unwrap();
                    let mut cancelled = false;
                    ui.horizontal(|ui| {
                        ui.label("Rejection reason (required):");
                        ui.text_edit_singleline(&mut pending.reason);
                        if theme::danger_button_enabled(ui, !pending.reason.trim().is_empty(), "Confirm reject").clicked() {
                            confirm_reject = Some((pending.id.clone(), pending.reason.clone()));
                        }
                        if ui.button("Cancel").clicked() {
                            cancelled = true;
                        }
                    });
                    if !cancelled && confirm_reject.is_none() {
                        self.live_account_reject = Some(pending);
                    }
                }
            });
        }

        if let Some(id) = approve_id {
            if let Some(api) = &self.api {
                api.live_account_request_action(ctx.clone(), self.tx.clone(), id, "APPROVE".to_string(), None);
            }
        }
        if let Some((id, reason)) = confirm_reject {
            if let Some(api) = &self.api {
                api.live_account_request_action(ctx.clone(), self.tx.clone(), id, "REJECT".to_string(), Some(reason));
            }
        }
    }

    fn render_notifications(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Notifications);
            }
            if ui.button("Mark all read").clicked() {
                if let Some(api) = &self.api {
                    api.mark_all_notifications_read(ctx.clone(), self.tx.clone());
                }
            }
            if self.notifications_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.notifications_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }

        egui::ScrollArea::vertical().show(ui, |ui| {
            for n in &self.notifications {
                ui.horizontal(|ui| {
                    if !n.read {
                        ui.colored_label(theme::accent(), "*");
                    } else {
                        ui.weak(" ");
                    }
                    ui.monospace(&n.created_at);
                    ui.weak(&n.notif_type);
                    ui.strong(&n.title);
                    ui.label(&n.body);
                });
            }
        });
    }

    fn render_risk_radar(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::RiskRadar);
            }
            if self.risk_radar_loading {
                ui.spinner();
            }
            ui.weak("Behavioral risk flags over the last 30 days, computed server-side (up to 5 min stale).");
        });
        ui.add_space(8.0);

        if let Some(err) = &self.risk_radar_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }

        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(120.0))
            .column(Column::remainder().at_least(160.0))
            .header(28.0, |mut header| {
                for label in ["Account", "Trades (30d)", "Win rate", "Avg lot", "Profit/day", "Flags"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.risk_radar.len(), |mut row| {
                    let r = &self.risk_radar[row.index()];
                    row.col(|ui| {
                        ui.monospace(&r.account_number);
                    });
                    row.col(|ui| {
                        ui.label(r.trades_30d.to_string());
                    });
                    row.col(|ui| {
                        ui.label(r.win_rate_pct.map(|v| format!("{v:.1}%")).unwrap_or_else(|| "-".to_string()));
                    });
                    row.col(|ui| {
                        ui.label(r.avg_lot.map(|v| format!("{v:.2}")).unwrap_or_else(|| "-".to_string()));
                    });
                    row.col(|ui| {
                        let color = if r.profit_velocity_per_day > 0.0 {
                            theme::accent()
                        } else if r.profit_velocity_per_day < 0.0 {
                            theme::DANGER
                        } else {
                            ui.visuals().text_color()
                        };
                        ui.colored_label(color, format!("${:.2}", r.profit_velocity_per_day));
                    });
                    row.col(|ui| {
                        ui.horizontal(|ui| {
                            if r.scalp_flag {
                                ui.colored_label(theme::WARNING, "SCALP");
                            }
                            if r.martingale_flag {
                                ui.colored_label(theme::DANGER, "MARTINGALE");
                            }
                            if !r.scalp_flag && !r.martingale_flag {
                                ui.weak("-");
                            }
                        });
                    });
                });
            });
    }

    fn render_settings(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Settings);
            }
            if self.settings_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.settings_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        let Some(settings) = self.settings.clone() else { return };

        theme::card(16).show(ui, |ui| {
            ui.set_width(360.0);
            ui.label(format!("Broker: {}", settings.name));
            ui.label(format!("Default currency: {} (USD only, no conversion yet)", settings.default_account_currency));
            ui.add_space(10.0);
            ui.label("Default account leverage");
            ui.add(egui::TextEdit::singleline(&mut self.settings_leverage_input));
            ui.add_space(10.0);
            let parsed = self.settings_leverage_input.trim().parse::<i64>().ok();
            if theme::accent_button_enabled(ui, matches!(parsed, Some(n) if n > 0), "Save").clicked() {
                if let (Some(api), Some(n)) = (&self.api, parsed) {
                    api.update_default_leverage(ctx.clone(), self.tx.clone(), n);
                }
            }
        });
        ui.add_space(10.0);
        ui.weak("This screen covers broker-wide defaults (app/api/manage/settings) -- symbol/spread pricing lives on the Groups screen's per-symbol editor, not here.");
    }

    fn render_reports(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Reports);
            }
            if self.reports_loading {
                ui.spinner();
            }
            ui.weak("Last 30 days, live accounts only.");
        });
        ui.add_space(10.0);
        if let Some(err) = &self.reports_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        let Some(r) = &self.reports else { return };
        egui::Grid::new("reports-stats").num_columns(4).spacing([10.0, 10.0]).show(ui, |ui| {
            stat_card(ui, "Trading volume (lots)", &format!("{:.2}", r.trading_volume));
            stat_card(ui, "Commission revenue", &format!("${:.2}", r.commission_revenue));
            stat_card(ui, "Net deposits", &format!("${:.2}", r.net_deposits));
            stat_card(ui, "New clients", &r.new_clients.to_string());
        });
    }

    fn render_symbols(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Symbols);
            }
            if self.symbols_loading {
                ui.spinner();
            }
            ui.weak("Read-only in this pass -- per-symbol spread/commission editing lives on the Groups pricing screen.");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.symbols_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::remainder().at_least(140.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(120.0))
            .column(Column::auto().at_least(120.0))
            .header(28.0, |mut header| {
                for label in ["Symbol", "Category", "Enabled", "Spread markup", "Commission / lot"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.symbols.len(), |mut row| {
                    let s = &self.symbols[row.index()];
                    row.col(|ui| {
                        ui.monospace(&s.symbol_name);
                    });
                    row.col(|ui| {
                        ui.label(&s.category);
                    });
                    row.col(|ui| {
                        if s.enabled {
                            ui.colored_label(theme::accent(), "yes");
                        } else {
                            ui.weak("no");
                        }
                    });
                    row.col(|ui| {
                        ui.monospace(&s.spread_markup);
                    });
                    row.col(|ui| {
                        ui.monospace(&s.commission_per_lot);
                    });
                });
            });
    }

    fn render_team(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Team);
            }
            if self.admins_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.admins_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        let mut pending_status: Option<(String, String)> = None;
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::remainder().at_least(180.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(140.0))
            .column(Column::auto().at_least(110.0))
            .header(28.0, |mut header| {
                for label in ["Email", "Role", "Status", "Last login", "Action"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.admins.len(), |mut row| {
                    let a = &self.admins[row.index()];
                    row.col(|ui| {
                        ui.label(&a.email);
                    });
                    row.col(|ui| {
                        ui.monospace(&a.role);
                    });
                    row.col(|ui| {
                        let color = if a.status == "ACTIVE" { theme::accent() } else { theme::TEXT_3 };
                        ui.colored_label(color, &a.status);
                    });
                    row.col(|ui| {
                        ui.weak(a.last_login_at.as_deref().unwrap_or("never"));
                    });
                    row.col(|ui| {
                        let next = if a.status == "ACTIVE" { "DISABLED" } else { "ACTIVE" };
                        let label = if a.status == "ACTIVE" { "Disable" } else { "Activate" };
                        if ui.small_button(label).clicked() {
                            pending_status = Some((a.id.clone(), next.to_string()));
                        }
                    });
                });
            });
        if let Some((id, status)) = pending_status {
            if let Some(api) = &self.api {
                api.set_admin_status(ctx.clone(), self.tx.clone(), id, status);
            }
        }
    }

    fn render_transfers(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Transfers);
            }
            if self.transfers_loading {
                ui.spinner();
            }
            ui.weak("Read-only in this pass -- creating a transfer needs two account pickers, deferred.");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.transfers_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::remainder().at_least(160.0))
            .column(Column::auto().at_least(140.0))
            .header(28.0, |mut header| {
                for label in ["Account", "Type", "Amount", "Note", "Date"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.transfers.len(), |mut row| {
                    let t = &self.transfers[row.index()];
                    row.col(|ui| {
                        ui.monospace(&t.account_number);
                    });
                    row.col(|ui| {
                        ui.label(&t.transfer_type);
                    });
                    row.col(|ui| {
                        ui.monospace(&t.amount);
                    });
                    row.col(|ui| {
                        ui.weak(t.note.as_deref().unwrap_or("-"));
                    });
                    row.col(|ui| {
                        ui.weak(t.created_at.get(0..10).unwrap_or(&t.created_at));
                    });
                });
            });
    }

    // Reuses self.accounts (the Accounts screen's own data, see fetch()'s
    // own comment) -- no separate endpoint exists; the real web page does
    // the same (WalletsManager.tsx fetches /api/manage/accounts too).
    fn render_wallets(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Wallets);
            }
            if self.accounts_loading {
                ui.spinner();
            }
            ui.weak("Balance and credit per account (same data as Clients / Accounts).");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.accounts_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(100.0))
            .column(Column::remainder().at_least(160.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(80.0))
            .header(28.0, |mut header| {
                for label in ["Account", "Client", "Balance", "Credit", "Currency"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.accounts.len(), |mut row| {
                    let a = &self.accounts[row.index()];
                    row.col(|ui| {
                        ui.monospace(&a.account_number);
                    });
                    row.col(|ui| {
                        ui.label(&a.full_name);
                    });
                    row.col(|ui| {
                        ui.monospace(&a.balance);
                    });
                    row.col(|ui| {
                        ui.monospace(&a.credit);
                    });
                    row.col(|ui| {
                        ui.weak(&a.currency);
                    });
                });
            });
    }

    fn render_ib(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Ib);
            }
            if self.ib_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.ib_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(100.0))
            .column(Column::remainder().at_least(150.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::remainder().at_least(150.0))
            .column(Column::auto().at_least(120.0))
            .header(28.0, |mut header| {
                for label in ["IB Account", "IB Name", "Client Account", "Client Name", "Commission"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.ib_relationships.len(), |mut row| {
                    let r = &self.ib_relationships[row.index()];
                    row.col(|ui| {
                        ui.monospace(&r.ib_account_number);
                    });
                    row.col(|ui| {
                        ui.label(&r.ib_account_full_name);
                    });
                    row.col(|ui| {
                        ui.monospace(&r.client_account_number);
                    });
                    row.col(|ui| {
                        ui.label(&r.client_account_full_name);
                    });
                    row.col(|ui| {
                        ui.weak(&r.commission_type);
                    });
                });
            });
    }

    fn render_leads(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Leads);
            }
            if self.leads_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.leads_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::remainder().at_least(150.0))
            .column(Column::auto().at_least(160.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(100.0))
            .header(28.0, |mut header| {
                for label in ["Name", "Email", "Phone", "Source", "Status"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.leads.len(), |mut row| {
                    let l = &self.leads[row.index()];
                    row.col(|ui| {
                        ui.label(&l.full_name);
                    });
                    row.col(|ui| {
                        ui.weak(l.email.as_deref().unwrap_or("-"));
                    });
                    row.col(|ui| {
                        ui.weak(l.phone.as_deref().unwrap_or("-"));
                    });
                    row.col(|ui| {
                        ui.weak(l.source.as_deref().unwrap_or("-"));
                    });
                    row.col(|ui| {
                        ui.label(&l.status);
                    });
                });
            });
    }

    fn render_deals(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Deals);
            }
            if self.deals_loading {
                ui.spinner();
            }
            ui.weak("Closed and voided positions.");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.deals_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(70.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::remainder().at_least(140.0))
            .header(28.0, |mut header| {
                for label in ["Account", "Symbol", "Side", "Status", "Volume", "Close", "P/L", "Closed"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.deals.len(), |mut row| {
                    let d = &self.deals[row.index()];
                    row.col(|ui| {
                        ui.monospace(&d.account_number);
                    });
                    row.col(|ui| {
                        ui.monospace(&d.symbol);
                    });
                    row.col(|ui| {
                        let color = if d.side == "BUY" { theme::accent() } else { theme::DANGER };
                        ui.colored_label(color, &d.side);
                    });
                    row.col(|ui| {
                        let color = if d.status == "VOIDED" { theme::WARNING } else { theme::TEXT_2 };
                        ui.colored_label(color, &d.status);
                    });
                    row.col(|ui| {
                        ui.monospace(&d.volume);
                    });
                    row.col(|ui| {
                        ui.monospace(&d.close_price);
                    });
                    row.col(|ui| {
                        let color = match d.realized_pnl.parse::<f64>() {
                            Ok(v) if v > 0.0 => theme::accent(),
                            Ok(v) if v < 0.0 => theme::DANGER,
                            _ => theme::TEXT_2,
                        };
                        ui.colored_label(color, &d.realized_pnl);
                    });
                    row.col(|ui| {
                        ui.weak(&d.closed_at);
                    });
                });
            });
    }

    fn render_audit(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Audit);
            }
            if self.audit_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.audit_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        egui::ScrollArea::vertical().show(ui, |ui| {
            for log in &self.audit_log {
                ui.horizontal(|ui| {
                    ui.monospace(&log.created_at_label);
                    ui.weak(&log.entity_type);
                    ui.label(&log.action_label);
                    ui.weak(&log.actor_email);
                });
            }
        });
    }

    // No dedicated endpoint for this native pass (2FA setup is a QR-code/
    // TOTP flow -- real complexity, deferred) -- shows the signed-in
    // admin's own identity, which is genuinely all this app can offer
    // without a proper enrollment UI. Full 2FA management stays on the
    // web backoffice for now.
    fn render_security(&mut self, ui: &mut egui::Ui) {
        theme::card(16).show(ui, |ui| {
            ui.set_width(360.0);
            ui.label(egui::RichText::new("Signed in as").size(11.0).color(theme::TEXT_3));
            ui.label(egui::RichText::new(&self.logged_in_email).size(16.0).color(theme::TEXT_1));
            ui.add_space(10.0);
            ui.weak("Two-factor setup and device management aren't implemented in this native pass yet -- use the web backoffice's Security page for those.");
        });
    }

    fn render_funds(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Funds);
            }
            if self.funds_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.funds_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        let mut action: Option<(String, String)> = None;
        for f in self.funds_requests.clone() {
            theme::card(10).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.monospace(&f.account_number);
                    ui.label(&f.account_full_name);
                    ui.separator();
                    ui.label(&f.request_type);
                    ui.monospace(&f.amount);
                    let status_color = match f.status.as_str() {
                        "APPROVED" | "COMPLETED" => theme::accent(),
                        "REJECTED" => theme::DANGER,
                        _ => theme::WARNING,
                    };
                    ui.colored_label(status_color, &f.status);
                    if f.status == "PENDING" {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Reject").clicked() {
                                action = Some((f.id.clone(), "REJECT".to_string()));
                            }
                            if theme::accent_button(ui, "Approve").clicked() {
                                action = Some((f.id.clone(), "APPROVE".to_string()));
                            }
                        });
                    }
                });
            });
        }
        if let Some((id, act)) = action {
            if let Some(api) = &self.api {
                api.funds_request_action(ctx.clone(), self.tx.clone(), id, act);
            }
        }
    }

    fn render_payment_methods(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::PaymentMethods);
            }
            if self.payment_methods_loading {
                ui.spinner();
            }
            ui.weak("Read-only in this pass -- editing fees/limits deferred.");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.payment_methods_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        for m in &self.payment_methods {
            ui.horizontal(|ui| {
                ui.monospace(&m.method_type);
                if m.enabled {
                    ui.colored_label(theme::accent(), "enabled");
                } else {
                    ui.weak("disabled");
                }
                ui.weak(format!("min {}, fee {}%", m.min_amount, m.fee_percent));
            });
        }
    }

    fn render_margin(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Margin);
            }
            if self.margin_loading {
                ui.spinner();
            }
            ui.weak("Sorted by lowest margin level first.");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.margin_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::remainder().at_least(120.0))
            .header(28.0, |mut header| {
                for label in ["Account", "Positions", "Exposure", "Floating P/L", "Margin level"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.margin.len(), |mut row| {
                    let m = &self.margin[row.index()];
                    row.col(|ui| {
                        ui.monospace(&m.account_number);
                    });
                    row.col(|ui| {
                        ui.label(m.position_count.to_string());
                    });
                    row.col(|ui| {
                        ui.monospace(&m.exposure);
                    });
                    row.col(|ui| {
                        ui.monospace(&m.floating_pnl);
                    });
                    row.col(|ui| {
                        let text = m.margin_level.map(|v| format!("{v:.1}%")).unwrap_or_else(|| "-".to_string());
                        let color = match m.margin_level {
                            Some(v) if v < 100.0 => theme::DANGER,
                            Some(v) if v < 200.0 => theme::WARNING,
                            _ => theme::TEXT_2,
                        };
                        ui.colored_label(color, text);
                    });
                });
            });
    }

    fn render_liquidity(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Liquidity);
            }
            if self.liquidity_loading {
                ui.spinner();
            }
            ui.weak("Open-position book exposure per symbol.");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.liquidity_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::remainder().at_least(100.0))
            .column(Column::auto().at_least(120.0))
            .column(Column::auto().at_least(120.0))
            .header(28.0, |mut header| {
                for label in ["Symbol", "A-Book volume", "B-Book volume"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.liquidity.len(), |mut row| {
                    let l = &self.liquidity[row.index()];
                    row.col(|ui| {
                        ui.monospace(&l.symbol);
                    });
                    row.col(|ui| {
                        ui.monospace(&l.a_book_volume);
                    });
                    row.col(|ui| {
                        ui.monospace(&l.b_book_volume);
                    });
                });
            });
    }

    fn render_liquidity_routing(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::LiquidityRouting);
            }
            if self.lp_routing_loading {
                ui.spinner();
            }
            ui.weak("Intended routing, not live routing -- no execution path reads this yet (matches the web page's own note).");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.lp_routing_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::remainder().at_least(150.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(70.0))
            .header(28.0, |mut header| {
                for label in ["Liquidity provider", "LP Status", "Symbol", "Priority"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::TEXT_3));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.lp_routing.len(), |mut row| {
                    let l = &self.lp_routing[row.index()];
                    row.col(|ui| {
                        ui.label(&l.liquidity_provider_name);
                    });
                    row.col(|ui| {
                        ui.weak(&l.liquidity_provider_status);
                    });
                    row.col(|ui| {
                        ui.monospace(l.symbol_name.as_deref().unwrap_or("all"));
                    });
                    row.col(|ui| {
                        ui.label(l.priority.to_string());
                    });
                });
            });
    }

    fn render_feed_health(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::FeedHealth);
            }
            if self.feed_health_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.feed_health_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        let Some(data) = &self.feed_health else { return };
        ui.horizontal(|ui| {
            ui.label("Trading core feed:");
            if data.feed_stats.is_some() {
                ui.colored_label(theme::accent(), "connected");
            } else {
                ui.colored_label(theme::TEXT_3, "not reachable");
            }
        });
        ui.horizontal(|ui| {
            ui.label("Gateway:");
            if data.gateway_stats.is_some() {
                ui.colored_label(theme::accent(), "connected");
            } else {
                ui.colored_label(theme::TEXT_3, "not reachable");
            }
        });
        ui.add_space(10.0);
        ui.weak("The Rust trading core/gateway are separate always-on processes (see engine/'s own Phase-1-scaffold status) -- \"not reachable\" here usually means neither is deployed yet, not a bug.");
        if let Some(stats) = &data.feed_stats {
            ui.add_space(10.0);
            ui.monospace(stats.to_string());
        }
    }

    fn render_emergency(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Emergency);
            }
            if self.risk_loading {
                ui.spinner();
            }
        });
        ui.add_space(10.0);
        ui.weak("The broker-wide kill switch. Existing open positions are never touched by this -- it only blocks new orders.");
        ui.add_space(10.0);
        if let Some(err) = &self.risk_error {
            ui.colored_label(theme::DANGER, err);
            return;
        }
        let Some(risk) = &self.risk else { return };
        theme::card(16).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label("Status:");
                if risk.trading_halted {
                    ui.colored_label(theme::DANGER, "TRADING HALTED");
                } else {
                    ui.colored_label(theme::accent(), "Normal");
                }
            });
            ui.add_space(10.0);
            if risk.trading_halted {
                if theme::accent_button(ui, "Resume trading").clicked() {
                    if let Some(api) = &self.api {
                        api.set_trading_halted(ctx.clone(), self.tx.clone(), false);
                    }
                }
            } else if theme::danger_button_enabled(ui, true, "Halt all new trading").clicked() {
                if let Some(api) = &self.api {
                    api.set_trading_halted(ctx.clone(), self.tx.clone(), true);
                }
            }
        });
    }
}

// Broker.primaryColor's own stored format (see BrokersManager.tsx's own
// "#f4551c"-style placeholder) -- "#rrggbb" or bare "rrggbb", both seen
// in real broker rows this session.
fn parse_hex_color(hex: &str) -> Option<egui::Color32> {
    let hex = hex.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    Some(egui::Color32::from_rgb(r, g, b))
}

fn stat_card(ui: &mut egui::Ui, label: &str, value: &str) {
    egui::Frame::new()
        .fill(theme::BG_1)
        .stroke(egui::Stroke::new(1.0_f32, theme::BORDER))
        .corner_radius(egui::CornerRadius::same(10))
        .inner_margin(egui::Margin::symmetric(16, 14))
        .show(ui, |ui| {
            ui.set_min_width(180.0);
            ui.vertical(|ui| {
                ui.label(egui::RichText::new(label.to_uppercase()).size(11.0).color(theme::TEXT_3));
                ui.add_space(6.0);
                ui.label(egui::RichText::new(value).size(24.0).color(theme::TEXT_1));
            });
        });
}

// Shared row renderer for both activity-feed surfaces (Live Exposure's
// broker-wide feed and the Dealing page's DEALING-group-scoped feed) --
// direct native port of components/admin/ActivityFeedRows.tsx, including
// its action label/tone map and its per-action describeActivityValues
// logic (read off the row's raw `values` JSON blob, same field names the
// web reads).
fn activity_action_label(action: &str) -> String {
    match action {
        "ORDER_PLACED" => "Order placed",
        "ORDER_MODIFIED" => "SL/TP modified",
        "ORDER_CANCELLED" => "Order cancelled",
        "ORDER_TRIGGERED" => "Pending order triggered",
        "POSITION_OPENED" => "Position opened",
        "POSITION_CLOSED" => "Position closed",
        other => return other.to_string(),
    }
    .to_string()
}

fn activity_action_color(action: &str) -> egui::Color32 {
    match action {
        "ORDER_PLACED" => theme::accent(),
        "ORDER_MODIFIED" | "ORDER_TRIGGERED" => theme::WARNING,
        "ORDER_CANCELLED" => theme::DANGER,
        "POSITION_OPENED" => theme::accent(),
        _ => theme::TEXT_3,
    }
}

fn jstr(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| {
        if x.is_null() {
            None
        } else if let Some(s) = x.as_str() {
            Some(s.to_string())
        } else {
            Some(x.to_string())
        }
    })
}

fn describe_activity_values(action: &str, values: &serde_json::Value) -> String {
    match action {
        "ORDER_PLACED" => {
            let mut parts = Vec::new();
            if let Some(p) = jstr(values, "triggerPrice").or_else(|| jstr(values, "requestedPrice")) {
                parts.push(format!("@ {p}"));
            }
            if let Some(sl) = jstr(values, "slPrice") {
                parts.push(format!("SL {sl}"));
            }
            if let Some(tp) = jstr(values, "tpPrice") {
                parts.push(format!("TP {tp}"));
            }
            parts.join(" ")
        }
        "ORDER_MODIFIED" => {
            let mut parts = Vec::new();
            let old_sl = jstr(values, "oldSlPrice");
            let new_sl = jstr(values, "newSlPrice");
            if old_sl != new_sl && (old_sl.is_some() || new_sl.is_some()) {
                parts.push(format!("SL {} -> {}", old_sl.as_deref().unwrap_or("-"), new_sl.as_deref().unwrap_or("-")));
            }
            let old_tp = jstr(values, "oldTpPrice");
            let new_tp = jstr(values, "newTpPrice");
            if old_tp != new_tp && (old_tp.is_some() || new_tp.is_some()) {
                parts.push(format!("TP {} -> {}", old_tp.as_deref().unwrap_or("-"), new_tp.as_deref().unwrap_or("-")));
            }
            parts.join(", ")
        }
        "ORDER_CANCELLED" => jstr(values, "requestedPrice").map(|p| format!("@ {p}")).unwrap_or_default(),
        "ORDER_TRIGGERED" => format!("triggered @ {}, now in approval queue", jstr(values, "triggerPrice").unwrap_or_else(|| "-".to_string())),
        "POSITION_OPENED" => format!("@ {}", jstr(values, "openPrice").or_else(|| jstr(values, "filledPrice")).unwrap_or_else(|| "-".to_string())),
        "POSITION_CLOSED" => {
            let mut parts = vec![format!("@ {}", jstr(values, "closePrice").unwrap_or_else(|| "-".to_string()))];
            if values.get("partial").and_then(|v| v.as_bool()).unwrap_or(false) {
                parts.push("(partial)".to_string());
            }
            if let Some(pnl) = jstr(values, "realizedPnl") {
                parts.push(format!("P&L {pnl}"));
            }
            parts.join(" ")
        }
        _ => String::new(),
    }
}

fn render_activity_feed_rows(ui: &mut egui::Ui, rows: &[ActivityFeedRow], show_dealing_chip: bool) {
    for row in rows {
        ui.horizontal(|ui| {
            ui.set_min_height(22.0);
            ui.label(egui::RichText::new(&row.at).size(11.0).color(theme::TEXT_3));
            ui.add_space(6.0);
            ui.monospace(egui::RichText::new(&row.account_number).size(12.0));
            if show_dealing_chip && row.is_dealing_group {
                ui.label(egui::RichText::new("DEALING").size(9.0).color(theme::TEXT_3));
            }
            ui.add_space(6.0);
            ui.colored_label(activity_action_color(&row.action), activity_action_label(&row.action));
            if let Some(symbol) = &row.symbol {
                ui.add_space(6.0);
                ui.monospace(symbol);
            }
            if let Some(side) = &row.side {
                let color = if side == "BUY" { theme::accent() } else { theme::DANGER };
                ui.colored_label(color, side);
            }
            if let Some(volume) = &row.volume {
                ui.monospace(volume);
            }
            ui.add_space(6.0);
            ui.weak(describe_activity_values(&row.action, &row.values));
        });
        ui.separator();
    }
}

// Custom-painted (not egui::Button::selectable) so the active item gets a
// left accent bar + tinted background, matching a real product sidebar's
// selection state rather than a plain highlighted-text list.
fn sidebar_nav_item(ui: &mut egui::Ui, icon: &str, label: &str, selected: bool) -> egui::Response {
    let desired_size = egui::vec2(ui.available_width(), 40.0);
    let (rect, response) = ui.allocate_exact_size(desired_size, egui::Sense::click());

    if ui.is_rect_visible(rect) {
        if selected {
            ui.painter().rect_filled(rect, 0.0, theme::accent().linear_multiply(0.14));
            let bar = egui::Rect::from_min_size(rect.min, egui::vec2(3.0, rect.height()));
            ui.painter().rect_filled(bar, 0.0, theme::accent());
        } else if response.hovered() {
            ui.painter().rect_filled(rect, 0.0, theme::BG_2);
        }
        let text_color = if selected { theme::accent() } else { theme::TEXT_2 };
        let icon_pos = rect.min + egui::vec2(20.0, rect.height() / 2.0);
        ui.painter().text(icon_pos, egui::Align2::LEFT_CENTER, icon, egui::FontId::proportional(14.0), text_color);
        let label_pos = rect.min + egui::vec2(46.0, rect.height() / 2.0);
        ui.painter().text(
            label_pos,
            egui::Align2::LEFT_CENTER,
            label,
            egui::FontId::proportional(13.5),
            if selected { theme::TEXT_1 } else { theme::TEXT_2 },
        );
    }
    response.on_hover_cursor(egui::CursorIcon::PointingHand)
}

impl BackofficeApp {
    // Verification-only convenience, not a real end-user feature: lets
    // this app be launched and driven to a logged-in state from a script
    // (env vars, not the GUI) instead of clicking through the login form
    // by hand -- specifically so screenshotting the authenticated screens
    // never requires simulated mouse/keyboard input on a real desktop,
    // which risks landing on whatever window actually has focus. Only
    // fires when all three vars are explicitly set.
    fn maybe_autologin(&mut self, ctx: &egui::Context) {
        let host = std::env::var("VYX_AUTOLOGIN_HOST").ok();
        let email = std::env::var("VYX_AUTOLOGIN_EMAIL").ok();
        let password = std::env::var("VYX_AUTOLOGIN_PASSWORD").ok();
        if let (Some(host), Some(email), Some(password)) = (host, email, password) {
            self.host_input = host;
            self.email_input = email.clone();
            self.login_busy = true;
            let api = ApiClient::new(self.host_input.trim());
            self.api = Some(api.clone());
            api.login(ctx.clone(), self.tx.clone(), email, password);
        }
    }

    // Same verification-only reasoning as maybe_autologin -- lets a
    // screenshot script pick which screen to land on after auto-login
    // without ever clicking the sidebar.
    fn maybe_autonav(&mut self, ctx: &egui::Context) {
        let target = match std::env::var("VYX_AUTOLOGIN_SCREEN").ok().as_deref() {
            Some("positions") => Some(Screen::Positions),
            Some("accounts") => Some(Screen::Accounts),
            Some("dashboard") => Some(Screen::Dashboard),
            Some("dealing") => Some(Screen::Dealing),
            Some("groups") => Some(Screen::Groups),
            Some("kyc") => Some(Screen::ClientKyc),
            Some("live-accounts") => Some(Screen::LiveAccountRequests),
            Some("notifications") => Some(Screen::Notifications),
            Some("risk") => Some(Screen::RiskRadar),
            Some("settings") => Some(Screen::Settings),
            Some("reports") => Some(Screen::Reports),
            Some("symbols") => Some(Screen::Symbols),
            Some("team") => Some(Screen::Team),
            Some("transfers") => Some(Screen::Transfers),
            Some("wallets") => Some(Screen::Wallets),
            Some("ib") => Some(Screen::Ib),
            Some("leads") => Some(Screen::Leads),
            Some("deals") => Some(Screen::Deals),
            Some("audit") => Some(Screen::Audit),
            Some("security") => Some(Screen::Security),
            Some("funds") => Some(Screen::Funds),
            Some("payment-methods") => Some(Screen::PaymentMethods),
            Some("margin") => Some(Screen::Margin),
            Some("liquidity") => Some(Screen::Liquidity),
            Some("liquidity-routing") => Some(Screen::LiquidityRouting),
            Some("feed-health") => Some(Screen::FeedHealth),
            Some("emergency") => Some(Screen::Emergency),
            _ => None,
        };
        if let Some(screen) = target {
            self.screen = screen;
            self.ensure_loaded(ctx, screen);
        }
    }
}

// Custom-drawn since decorations(false) means there's no OS-drawn title
// bar at all -- this is that bar's full replacement: drag-to-move, and
// minimize/maximize/close wired to the same ViewportCommands the OS
// chrome would otherwise send. Rendered once per frame regardless of
// login state, above whatever render_login/render_shell draws below it.
fn render_titlebar(ctx: &egui::Context) {
    egui::TopBottomPanel::top("titlebar")
        .exact_height(34.0)
        .frame(egui::Frame::new().fill(theme::SIDEBAR_BG).inner_margin(egui::Margin::symmetric(10, 0)))
        .show(ctx, |ui| {
            let bar_rect = ui.max_rect();
            let maximized = ctx.input(|i| i.viewport().maximized.unwrap_or(false));

            // Drag/double-click-to-maximize sensed over the WHOLE bar
            // first (drawn/allocated before anything else, so it sits
            // "underneath" in z-order) -- the icon/title/buttons drawn
            // afterward each get their own narrower interactive rect on
            // top of it, which egui resolves to the topmost (later-drawn)
            // widget for clicks/hover, same as eframe's own documented
            // custom-title-bar pattern.
            let bar_response = ui.interact(bar_rect, ui.id().with("titlebar-drag"), egui::Sense::click_and_drag());
            if bar_response.drag_started() {
                ctx.send_viewport_cmd(egui::ViewportCommand::StartDrag);
            }
            if bar_response.double_clicked() {
                ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(!maximized));
            }

            ui.horizontal_centered(|ui| {
                ui.label(egui::RichText::new("●").size(12.0).color(theme::accent()));
                ui.add_space(2.0);
                ui.label(egui::RichText::new("VyXTrader Backoffice").size(12.5).color(theme::TEXT_2));

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let btn = |ui: &mut egui::Ui, symbol: &str, hover: egui::Color32| {
                        let (rect, response) = ui.allocate_exact_size(egui::vec2(38.0, 34.0), egui::Sense::click());
                        if ui.is_rect_visible(rect) {
                            if response.hovered() {
                                ui.painter().rect_filled(rect, 0.0, hover);
                            }
                            ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, symbol, egui::FontId::proportional(13.0), theme::TEXT_1);
                        }
                        response
                    };
                    if btn(ui, "✕", theme::DANGER).clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                    if btn(ui, "▢", theme::BG_2).clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(!maximized));
                    }
                    if btn(ui, "—", theme::BG_2).clicked() {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(true));
                    }
                });
            });
        });
}

impl eframe::App for BackofficeApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_events(ctx);
        render_titlebar(ctx);
        if self.logged_in {
            self.render_shell(ctx);
        } else {
            self.render_login(ctx);
        }
    }
}

fn main() -> eframe::Result<()> {
    // Same icon.ico brand mark the Tauri apps already ship (manager-tauri/
    // src-tauri/icons/icon.ico), decoded to raw RGBA here since eframe's
    // window icon needs pixel data, not a file reference -- see
    // build.rs's own comment for the OTHER half of this fix (the static
    // .exe file icon Explorer/the taskbar's pinned entry read, which is a
    // completely separate mechanism from this runtime one).
    let icon = eframe::icon_data::from_png_bytes(include_bytes!("../assets/icon.png")).expect("assets/icon.png must be a valid PNG");

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("VyXTrader Backoffice")
            .with_inner_size([1360.0, 840.0])
            .with_min_inner_size([1024.0, 600.0])
            .with_icon(icon)
            // Frameless -- the OS's own title bar renders white/light
            // regardless of ctx.set_theme (DWM chrome and egui's own
            // dark visuals are two separate systems on Windows; the
            // former doesn't follow the latter). titlebar() below draws
            // a custom one instead, matching the rest of the app exactly
            // rather than fighting Windows for a dark native one.
            .with_decorations(false),
        ..Default::default()
    };

    eframe::run_native(
        "VyXTrader Backoffice (Native POC)",
        options,
        Box::new(|cc| {
            theme::apply(&cc.egui_ctx);
            let mut app = BackofficeApp::default();
            app.maybe_autologin(&cc.egui_ctx);
            Ok(Box::new(app))
        }),
    )
}
