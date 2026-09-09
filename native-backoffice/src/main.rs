// True-native (zero-webview) backoffice -- real native window via
// eframe/winit, no webview, no browser, no HTML/CSS/JS anywhere in this
// binary. See api.rs's own top comment for why this talks to the live
// /api/manage/* HTTP endpoints rather than "a Rust DB layer" -- no such
// layer exists yet (engine/ is a Phase 1, no-I/O scaffold).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;

use api::{
    AccountRow, AccountTypeOption, ActivityFeedRow, ActivityRow, AdminRow, ApiClient, ApiEvent, AuditLogRow, ClientKycRow,
    DashboardData, DayBucket, DealRow, DealerToggleState, DealingDeskAccount, DealingOrderRow, FeedHealthData,
    FundsRequestRow, GroupPricingRow, GroupRow, IbRelationshipRow, KycRow, LeadRow, LiquidityExposureRow,
    LiveAccountRequestRow, LpRoutingRow, MarginRow, NewAccountBody, NotificationRow, PaymentMethodRow,
    PendingAdjustment, PositionRow, ReportsSummary, RequotedOrderRow, RestingOrderRow, RiskData, RiskRadarRow,
    SettingsData, SymbolConfigRow, TransferRow,
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
    Kyc,
    ClientKyc,
    LiveAccountRequests,
    Notifications,
    RiskRadar,
    Risk,
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
            Screen::Positions => "Live exposure",
            // Redesign IA (PROMPT-backoffice-15-pages.md Part 2): this
            // screen is the client-centric list Part 3.8 describes
            // (client name/email + nested accounts), not a bare
            // trading-account grid -- "Trading Accounts" undersold what
            // it already shows.
            Screen::Accounts => "Clients & accounts",
            Screen::Dealing => "Dealing",
            Screen::Groups => "Groups",
            Screen::Kyc => "KYC review",
            Screen::ClientKyc => "Client KYC",
            Screen::LiveAccountRequests => "Live account requests",
            Screen::Notifications => "Notifications",
            Screen::RiskRadar => "Risk radar",
            Screen::Risk => "Risk",
            Screen::Settings => "Settings",
            Screen::Reports => "Reports",
            Screen::Symbols => "Symbols",
            Screen::Team => "Users & roles",
            Screen::Transfers => "Internal transfers",
            Screen::Wallets => "Wallets",
            Screen::Ib => "IB partners",
            Screen::Leads => "Leads",
            Screen::Deals => "Deals",
            Screen::Audit => "Audit log",
            Screen::Security => "Security",
            Screen::Funds => "Deposits & withdrawals",
            Screen::PaymentMethods => "Payment methods",
            Screen::Margin => "Margin monitoring",
            Screen::Liquidity => "Liquidity providers",
            Screen::LiquidityRouting => "Routing",
            Screen::FeedHealth => "Feed health",
            Screen::Emergency => "Emergency",
        }
    }

    // Sidebar SECTION this screen lives under in the redesign IA
    // (PROMPT-backoffice-15-pages.md Part 2) -- drives both which group
    // renders it in the sidebar and the header breadcrumb ("Trading ›
    // Live exposure"). Client KYC/Liquidity Routing/Margin keep their
    // group here (so a stray reference elsewhere still resolves to
    // something sane) even though Part B hides their own separate nav
    // row -- see render_sidebar's own comment on why the row is hidden
    // without deleting the screen.
    fn group_label(self) -> &'static str {
        match self {
            Screen::Dashboard | Screen::Reports | Screen::Notifications => "Overview",
            Screen::Positions | Screen::Dealing | Screen::Deals | Screen::Symbols | Screen::Groups => "Trading",
            Screen::Risk | Screen::Margin | Screen::RiskRadar | Screen::Emergency => "Risk",
            Screen::Liquidity | Screen::LiquidityRouting | Screen::FeedHealth => "Liquidity",
            Screen::Accounts | Screen::Leads | Screen::Ib | Screen::Kyc | Screen::ClientKyc | Screen::LiveAccountRequests => "Clients",
            Screen::Funds | Screen::PaymentMethods | Screen::Transfers | Screen::Wallets => "Finance",
            Screen::Team | Screen::Audit | Screen::Security | Screen::Settings => "System",
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
            Screen::Kyc => "◑",
            Screen::ClientKyc => "✓",
            Screen::LiveAccountRequests => "☑",
            Screen::Notifications => "◔",
            Screen::RiskRadar => "⚠",
            Screen::Risk => "◈",
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

// Per-row edit buffer for the Payment Methods table -- IS_CRYPTO in
// PaymentMethodsManager.tsx decides whether walletAddress or a plain
// bank-details hint shows, kept here as a plain fn on the type string.
#[derive(Default, Clone)]
struct PaymentMethodEdit {
    enabled: bool,
    min_amount: String,
    max_amount: String,
    fee_percent: String,
    fee_fixed: String,
    wallet_address: String,
    instructions: String,
}

fn payment_method_label(t: &str) -> &'static str {
    match t {
        "USDT_TRC20" => "USDT (TRC20)",
        "USDT_BEP20" => "USDT (BEP20)",
        "BTC" => "Bitcoin",
        "ETH" => "Ethereum",
        "BANK_TRANSFER" => "Bank transfer",
        _ => "Unknown",
    }
}

fn payment_method_is_crypto(t: &str) -> bool {
    t != "BANK_TRANSFER"
}

// Per-row edit buffer for the Group pricing tab -- mirrors
// SymbolPricingEditor.tsx's own EditRow: spreadMarkup and
// targetTotalSpreadPips are mutually exclusive, expressed here as a mode
// toggle rather than two simultaneously-editable fields.
#[derive(Default, Clone)]
struct PricingEditRow {
    is_target_mode: bool,
    spread_markup: String,
    target_total_spread_pips: String,
    commission_per_lot: String,
    swap_long: String,
    swap_short: String,
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
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

    // Light/dark mode -- the exact two palettes from app/admin-theme.css's
    // [data-surface] (dark) and [data-surface][data-mode="light"] (light)
    // blocks, manager-surface accent variant. The web defaults to light
    // and persists a toggle to AdminUser.theme (PATCH /api/manage/theme);
    // this app keeps its own established dark-by-default first launch
    // (matches this app's existing native-only branding pass) but the
    // toggle itself, both full palettes, and the same persistence call are
    // real, not cosmetic -- see render_titlebar's sun/moon button and
    // BackofficeApp::toggle_theme.
    static DARK_MODE: AtomicBool = AtomicBool::new(true);

    pub fn is_dark() -> bool {
        DARK_MODE.load(Ordering::Relaxed)
    }
    pub fn set_dark(dark: bool) {
        DARK_MODE.store(dark, Ordering::Relaxed);
    }

    pub fn bg_0() -> Color32 {
        if is_dark() { Color32::from_rgb(0x07, 0x09, 0x0c) } else { Color32::from_rgb(0xf8, 0xf9, 0xfb) }
    }
    pub fn bg_1() -> Color32 {
        if is_dark() { Color32::from_rgb(0x0b, 0x0f, 0x14) } else { Color32::from_rgb(0xff, 0xff, 0xff) }
    }
    pub fn bg_2() -> Color32 {
        if is_dark() { Color32::from_rgb(0x0e, 0x13, 0x19) } else { Color32::from_rgb(0xf1, 0xf3, 0xf6) }
    }
    // Real web markup uses --bg-1 for the sidebar <aside> too (no separate
    // darker rail shade) -- kept as its own function so call sites read
    // "sidebar background" rather than an unexplained bg_1() reuse.
    pub fn sidebar_bg() -> Color32 {
        bg_1()
    }
    pub fn border() -> Color32 {
        if is_dark() { Color32::from_rgb(0x1e, 0x24, 0x2c) } else { Color32::from_rgb(0xe2, 0xe5, 0xea) }
    }
    pub fn text_1() -> Color32 {
        if is_dark() { Color32::from_rgb(0xed, 0xef, 0xf2) } else { Color32::from_rgb(0x14, 0x18, 0x1f) }
    }
    pub fn text_2() -> Color32 {
        if is_dark() { Color32::from_rgb(0x8b, 0x93, 0xa1) } else { Color32::from_rgb(0x4b, 0x55, 0x63) }
    }
    pub fn text_3() -> Color32 {
        if is_dark() { Color32::from_rgb(0x5a, 0x64, 0x72) } else { Color32::from_rgb(0x6b, 0x72, 0x80) }
    }
    pub fn danger() -> Color32 {
        Color32::from_rgb(0xea, 0x39, 0x43) // --sell, identical in both themes
    }
    pub fn warning() -> Color32 {
        if is_dark() { Color32::from_rgb(0xf0, 0xb9, 0x0b) } else { Color32::from_rgb(0x8a, 0x5a, 0x05) }
    }

    // Redesign pass -- fixed semantic status colors, deliberately
    // independent of the per-tenant accent() above. "Status colors are
    // semantic only... the orange accent is never used for status text"
    // (master prompt token spec) -- profit/loss, up/down, and info chips
    // must read the same regardless of which broker's branding is
    // active, the same way `danger()`/`warning()` already don't move
    // with the tenant. A few existing call sites (e.g. the Live Exposure
    // floating-P&L total) used accent() for "profit" before this existed,
    // which is exactly the bug this fixes -- for a tenant whose brand
    // color isn't green, profit rendered in their own accent color
    // instead of a real status green.
    pub fn up() -> Color32 {
        Color32::from_rgb(0x3c, 0xc9, 0x8a)
    }
    pub fn down() -> Color32 {
        Color32::from_rgb(0xf0, 0x50, 0x6e)
    }
    pub fn up_soft() -> Color32 {
        up().gamma_multiply(0.16)
    }
    pub fn down_soft() -> Color32 {
        down().gamma_multiply(0.16)
    }
    pub fn blue() -> Color32 {
        Color32::from_rgb(0x5b, 0x9c, 0xff)
    }
    pub fn violet() -> Color32 {
        Color32::from_rgb(0xa7, 0x8b, 0xfa)
    }

    const DEFAULT_ACCENT_DARK: (u8, u8, u8) = (0x16, 0xc7, 0x84); // manager dark accent (matches --buy)
    const DEFAULT_ACCENT_LIGHT: (u8, u8, u8) = (0x0a, 0x7a, 0x4d); // manager light accent
    const DEFAULT_ACCENT: (u8, u8, u8) = DEFAULT_ACCENT_DARK; // generic VyXTrader green, shown pre-login and if a broker has no primaryColor set

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
        let (r, g, b) = if is_dark() { DEFAULT_ACCENT_DARK } else { DEFAULT_ACCENT_LIGHT };
        ACCENT_R.store(r, Ordering::Relaxed);
        ACCENT_G.store(g, Ordering::Relaxed);
        ACCENT_B.store(b, Ordering::Relaxed);
    }

    // Flips DARK_MODE and, if the accent is still at its unbranded
    // default for the OLD mode, swaps it to the new mode's own default
    // too -- a broker's real primaryColor (once branded) is mode-
    // independent and left untouched either way, same as the real web
    // (var(--accent) doesn't re-derive per theme mode there either).
    pub fn toggle_mode() {
        let was_dark = is_dark();
        let old_default = if was_dark { DEFAULT_ACCENT_DARK } else { DEFAULT_ACCENT_LIGHT };
        let current = (ACCENT_R.load(Ordering::Relaxed), ACCENT_G.load(Ordering::Relaxed), ACCENT_B.load(Ordering::Relaxed));
        let was_unbranded = current == old_default;
        set_dark(!was_dark);
        if was_unbranded {
            reset_accent();
        }
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
        let dark = is_dark();
        let (bg_0, bg_1, bg_2, border, text_1, text_2) = (bg_0(), bg_1(), bg_2(), border(), text_1(), text_2());

        let mut visuals = if dark { egui::Visuals::dark() } else { egui::Visuals::light() };
        visuals.panel_fill = bg_0;
        visuals.window_fill = bg_1;
        visuals.extreme_bg_color = bg_2;
        visuals.faint_bg_color = bg_2;
        visuals.code_bg_color = bg_2;
        visuals.override_text_color = Some(text_1);
        visuals.hyperlink_color = accent;
        visuals.selection.bg_fill = accent.linear_multiply(0.35);
        visuals.selection.stroke = egui::Stroke::new(1.0_f32, accent);
        visuals.window_stroke = egui::Stroke::new(1.0_f32, border);

        let radius = egui::CornerRadius::same(8);
        visuals.window_corner_radius = radius;
        visuals.menu_corner_radius = radius;

        // Widget states: inactive (resting), hovered, active (pressed/
        // held) -- these three drive the look of every button, text
        // field, and selectable item in the app, so this is most of what
        // separates "styled" from "egui's raw default."
        visuals.widgets.noninteractive.bg_fill = bg_1;
        visuals.widgets.noninteractive.weak_bg_fill = bg_1;
        visuals.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0_f32, border);
        visuals.widgets.noninteractive.fg_stroke = egui::Stroke::new(1.0_f32, text_1);
        visuals.widgets.noninteractive.corner_radius = radius;

        visuals.widgets.inactive.bg_fill = bg_2;
        visuals.widgets.inactive.weak_bg_fill = bg_2;
        visuals.widgets.inactive.bg_stroke = egui::Stroke::new(1.0_f32, border);
        visuals.widgets.inactive.fg_stroke = egui::Stroke::new(1.0_f32, text_2);
        visuals.widgets.inactive.corner_radius = radius;

        let hover_bg = if dark { bg_2.gamma_multiply(1.35) } else { bg_2.gamma_multiply(0.96) };
        visuals.widgets.hovered.bg_fill = hover_bg;
        visuals.widgets.hovered.weak_bg_fill = hover_bg;
        visuals.widgets.hovered.bg_stroke = egui::Stroke::new(1.0_f32, accent_dim);
        visuals.widgets.hovered.fg_stroke = egui::Stroke::new(1.0_f32, text_1);
        visuals.widgets.hovered.corner_radius = radius;
        visuals.widgets.hovered.expansion = 0.5;

        visuals.widgets.active.bg_fill = accent.linear_multiply(0.28);
        visuals.widgets.active.weak_bg_fill = accent.linear_multiply(0.28);
        visuals.widgets.active.bg_stroke = egui::Stroke::new(1.0_f32, accent);
        visuals.widgets.active.fg_stroke = egui::Stroke::new(1.0_f32, text_1);
        visuals.widgets.active.corner_radius = radius;

        visuals.widgets.open.bg_fill = bg_2;
        visuals.widgets.open.weak_bg_fill = bg_2;
        visuals.widgets.open.bg_stroke = egui::Stroke::new(1.0_f32, accent_dim);
        visuals.widgets.open.corner_radius = radius;

        // set_visuals alone follows the OS theme preference -- on a
        // light-mode system this got silently reset back to light on the
        // real first frame regardless of which mode this app itself
        // wanted. set_theme locks the preference so the OS can't override
        // it, and set_visuals_of targets the Dark/Light slot explicitly
        // (whichever this app's own toggle currently has selected)
        // rather than "whatever ctx.theme() happens to resolve to."
        let theme_pref = if dark { egui::ThemePreference::Dark } else { egui::ThemePreference::Light };
        let theme_slot = if dark { egui::Theme::Dark } else { egui::Theme::Light };
        ctx.set_theme(theme_pref);
        ctx.set_visuals_of(theme_slot, visuals);

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
    // Space Grotesk (also OFL-licensed, github.com/floriankarsten/
    // space-grotesk) registered as its own named family alongside Inter
    // -- the redesign spec calls for Space Grotesk on headings/KPI
    // numbers/tabular data, Inter everywhere else. Same rasterization
    // ceiling as Inter above (ab_glyph renders only the file's default
    // Regular instance, no true 500/600/700 weight cuts without
    // separate static-weight font files this app doesn't have) -- this
    // app leans on size/color for hierarchy within each family, exactly
    // the same accepted tradeoff Inter already uses, just extended to
    // the second typeface rather than pretending true bold works here.
    pub fn heading_font(size: f32) -> egui::FontId {
        egui::FontId::new(size, egui::FontFamily::Name("spacegrotesk".into()))
    }

    fn load_fonts(ctx: &egui::Context) {
        let mut fonts = egui::FontDefinitions::default();
        fonts.font_data.insert(
            "inter".to_owned(),
            std::sync::Arc::new(egui::FontData::from_static(include_bytes!("../assets/Inter.ttf"))),
        );
        fonts.font_data.insert(
            "spacegrotesk".to_owned(),
            std::sync::Arc::new(egui::FontData::from_static(include_bytes!("../assets/SpaceGrotesk.ttf"))),
        );
        fonts.families.get_mut(&egui::FontFamily::Proportional).unwrap().insert(0, "inter".to_owned());
        fonts.families.insert(egui::FontFamily::Name("spacegrotesk".into()), vec!["spacegrotesk".to_owned(), "inter".to_owned()]);
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
            egui::Button::new(egui::RichText::new(text).color(text_1()))
                .fill(danger().linear_multiply(0.25))
                .stroke(egui::Stroke::new(1.0_f32, danger())),
        )
    }

    // Shared card look (form panels, per-row list items) -- same
    // fill/border/rounding as stat_card, parameterized on padding since
    // a dense list row and a spacious form need different amounts.
    pub fn card(margin: i8) -> egui::Frame {
        egui::Frame::new()
            .fill(bg_1())
            .stroke(egui::Stroke::new(1.0_f32, border()))
            .corner_radius(egui::CornerRadius::same(10))
            .inner_margin(egui::Margin::same(margin))
    }
}

// Shared building blocks (PROMPT-backoffice-15-pages.md Part 1) --
// "build once," adopted page-by-page as Part 3 touches each screen.
// egui is immediate-mode (no persistent widget tree, no component
// instances to hold state across frames), so these are plain builders
// over a Ui/Context each render call re-runs -- any state that needs to
// survive a frame (dirty cells, which drawer tab is open, a confirm
// dialog's typed-reason text) still lives on BackofficeApp itself, same
// as every other piece of this app's state; these just standardize how
// that state is *drawn*, not where it's *stored*.
mod components {
    use super::theme;
    use eframe::egui;
    use egui_extras::TableBuilder;

    pub struct Column {
        pub label: &'static str,
        pub min_width: f32,
        pub right_align: bool,
    }

    impl Column {
        pub fn new(label: &'static str, min_width: f32) -> Self {
            Self { label, min_width, right_align: false }
        }
        // Numeric/currency/lot columns -- tabular-nums right alignment per
        // the token spec ("numeric columns right-aligned with
        // tabular-nums; text left").
        pub fn right(mut self) -> Self {
            self.right_align = true;
            self
        }
    }

    enum State<'a> {
        Loading,
        // cached_rows: whether rows from a previous successful load are
        // still on screen below the banner (0.2: "Rows below stay if
        // cached" -- an error must never blank out data the user already
        // had, only warn that it's stale).
        Error { message: &'a str, cached_rows: bool, last_good: Option<&'a str> },
        Empty { title: &'a str, subtitle: &'a str },
        Ready,
    }

    // The one thing 0.2 exists to prevent: error and empty are mutually
    // exclusive by construction here (an enum, not two separate bools a
    // caller could both set), so a page using DataTable literally cannot
    // reproduce the "0 KYC submissions" + "forbidden" bug fixed in Part 0
    // -- picking Error forecloses Empty at the type level.
    pub struct DataTable<'a> {
        columns: Vec<Column>,
        row_height: f32,
        state: State<'a>,
    }

    pub struct DataTableResponse {
        pub retry_clicked: bool,
    }

    impl<'a> DataTable<'a> {
        pub fn new(columns: Vec<Column>) -> Self {
            Self { columns, row_height: 28.0, state: State::Ready }
        }
        pub fn row_height(mut self, h: f32) -> Self {
            self.row_height = h;
            self
        }
        pub fn loading(mut self) -> Self {
            self.state = State::Loading;
            self
        }
        pub fn error(mut self, message: &'a str, cached_rows: bool, last_good: Option<&'a str>) -> Self {
            self.state = State::Error { message, cached_rows, last_good };
            self
        }
        pub fn empty(mut self, title: &'a str, subtitle: &'a str) -> Self {
            self.state = State::Empty { title, subtitle };
            self
        }

        // Last column stretches to fill leftover row width (egui_extras'
        // `remainder`); every other column sizes to content with a floor
        // (`auto().at_least(...)`) -- same split the hand-written tables
        // this component replaces already used, just centralized so every
        // adopting page gets a full-width last column for free instead of
        // reproducing `Column::remainder()` itself.
        fn column_spec(&self, i: usize) -> egui_extras::Column {
            if i + 1 == self.columns.len() {
                egui_extras::Column::remainder().at_least(self.columns[i].min_width)
            } else {
                egui_extras::Column::auto().at_least(self.columns[i].min_width)
            }
        }

        fn header(&self, ui: &mut egui::Ui) {
            let mut builder = TableBuilder::new(ui).striped(false).resizable(true).cell_layout(egui::Layout::left_to_right(egui::Align::Center));
            for i in 0..self.columns.len() {
                builder = builder.column(self.column_spec(i));
            }
            builder.header(24.0, |mut header| {
                for col in &self.columns {
                    header.col(|ui| {
                        if col.right_align {
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                ui.label(egui::RichText::new(col.label.to_uppercase()).size(11.5).color(theme::text_3()));
                            });
                        } else {
                            ui.label(egui::RichText::new(col.label.to_uppercase()).size(11.5).color(theme::text_3()));
                        }
                    });
                }
            });
        }

        // `row_count` and `add_row` describe the READY-state body only --
        // callers still pass them even in Loading/Error/Empty states
        // (Error with cached_rows renders the real rows below its banner)
        // but a Loading/Empty table ignores add_row and draws its own
        // placeholder rows instead.
        pub fn show(self, ui: &mut egui::Ui, row_count: usize, mut add_row: impl FnMut(&mut egui_extras::TableRow, usize)) -> DataTableResponse {
            let mut retry_clicked = false;
            match &self.state {
                State::Loading => {
                    self.header(ui);
                    for i in 0..6 {
                        let frac = 1.0 - (i as f32 * 0.08);
                        ui.add_space(2.0);
                        let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width() * 0.7_f32.max(0.3).min(frac.max(0.35)), 14.0), egui::Sense::hover());
                        ui.painter().rect_filled(rect, egui::CornerRadius::same(4), theme::border().gamma_multiply(0.6));
                    }
                }
                State::Error { message, cached_rows, last_good } => {
                    egui::Frame::new()
                        .fill(theme::danger().gamma_multiply(0.12))
                        .stroke(egui::Stroke::new(1.0_f32, theme::danger()))
                        .corner_radius(egui::CornerRadius::same(8))
                        .inner_margin(egui::Margin::symmetric(14, 10))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.vertical(|ui| {
                                    ui.label(egui::RichText::new("Couldn't load this").strong().color(theme::text_1()));
                                    ui.label(egui::RichText::new(*message).color(theme::text_2()).size(12.0));
                                    if let Some(last_good) = last_good {
                                        ui.label(egui::RichText::new(format!("Showing last known state from {last_good}")).color(theme::text_3()).size(11.0));
                                    }
                                });
                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    if ui.button("Retry").clicked() {
                                        retry_clicked = true;
                                    }
                                });
                            });
                        });
                    ui.add_space(8.0);
                    if *cached_rows && row_count > 0 {
                        self.header(ui);
                        let mut builder = TableBuilder::new(ui).striped(true).cell_layout(egui::Layout::left_to_right(egui::Align::Center));
                        for i in 0..self.columns.len() {
                            builder = builder.column(self.column_spec(i));
                        }
                        builder.body(|body| {
                                body.rows(self.row_height, row_count, |mut row| {
                                    let idx = row.index();
                                    add_row(&mut row, idx);
                                });
                            });
                    }
                }
                State::Empty { title, subtitle } => {
                    self.header(ui);
                    ui.add_space(24.0);
                    ui.vertical_centered(|ui| {
                        ui.label(egui::RichText::new(*title).strong().color(theme::text_1()));
                        ui.label(egui::RichText::new(*subtitle).color(theme::text_3()).size(12.0));
                    });
                    ui.add_space(24.0);
                }
                State::Ready => {
                    let mut builder = TableBuilder::new(ui).striped(true).resizable(true).cell_layout(egui::Layout::left_to_right(egui::Align::Center));
                    for i in 0..self.columns.len() {
                        builder = builder.column(self.column_spec(i));
                    }
                    builder
                        .header(24.0, |mut header| {
                            for col in &self.columns {
                                header.col(|ui| {
                                    ui.label(egui::RichText::new(col.label.to_uppercase()).size(11.5).color(theme::text_3()));
                                });
                            }
                        })
                        .body(|body| {
                            body.rows(self.row_height, row_count, |mut row| {
                                let idx = row.index();
                                add_row(&mut row, idx);
                            });
                        });
                }
            }
            DataTableResponse { retry_clicked }
        }
    }

    // "Showing 1-50 of N * sorted by X" footer strip (Part 1.1). `sorted_by`
    // is optional since not every table has a meaningful default sort.
    pub fn table_footer(ui: &mut egui::Ui, showing: usize, total: usize, sorted_by: Option<&str>) {
        ui.horizontal(|ui| {
            let text = match sorted_by {
                Some(s) => format!("Showing 1-{showing} of {total} \u{b7} sorted by {s}"),
                None => format!("Showing 1-{showing} of {total}"),
            };
            ui.label(egui::RichText::new(text).size(11.0).color(theme::text_3()));
        });
    }

    // Part 1.2 -- decomposed into small helpers rather than one monolithic
    // builder: every page's filter set is a different shape (Deals has
    // Account/Group/Symbol/Side/Type/P&L, Leads has Status/Source/Owner),
    // so there's no single closure signature that fits all of them. These
    // three give every page the same look (280px search, `Label: Value v`
    // chips, right-aligned count/bulk-action/Columns) without forcing a
    // shared shape onto filters that don't share one.
    pub fn search_field(ui: &mut egui::Ui, value: &mut String, hint: &str) -> egui::Response {
        ui.add_sized([280.0, 0.0], egui::TextEdit::singleline(value).hint_text(hint))
    }

    // `options` is (display label, value); returns true when the
    // selection changed this frame so the caller can re-fetch/re-filter.
    pub fn filter_chip<T: Copy + PartialEq>(ui: &mut egui::Ui, name: &str, options: &[(&str, T)], selected: &mut T) -> bool {
        let mut changed = false;
        let current_label = options.iter().find(|(_, v)| v == selected).map(|(l, _)| *l).unwrap_or("All");
        egui::Frame::new()
            .fill(theme::bg_2())
            .stroke(egui::Stroke::new(1.0_f32, theme::border()))
            .corner_radius(egui::CornerRadius::same(6))
            .inner_margin(egui::Margin::symmetric(8, 3))
            .show(ui, |ui| {
                egui::ComboBox::from_id_salt(("filter_chip", name))
                    .selected_text(format!("{name}: {current_label}"))
                    .show_ui(ui, |ui| {
                        for (label, value) in options {
                            if ui.selectable_label(*selected == *value, *label).clicked() && *selected != *value {
                                *selected = *value;
                                changed = true;
                            }
                        }
                    });
            });
        changed
    }

    pub struct ToolbarRightResponse {
        pub bulk_clicked: bool,
        pub columns_clicked: bool,
    }

    // Right cluster: selection count, the bulk-action button (spec: enabled
    // only when selection > 0), Columns picker. `bulk_label` is None when
    // the page has no bulk action (Columns/count still render).
    pub fn toolbar_right(ui: &mut egui::Ui, selected_count: usize, bulk_label: Option<&str>) -> ToolbarRightResponse {
        let mut bulk_clicked = false;
        let mut columns_clicked = false;
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if ui.button("Columns \u{25be}").clicked() {
                columns_clicked = true;
            }
            if let Some(label) = bulk_label {
                if theme::accent_button_enabled(ui, selected_count > 0, label).clicked() {
                    bulk_clicked = true;
                }
            }
            if selected_count > 0 {
                ui.label(egui::RichText::new(format!("{selected_count} selected")).color(theme::text_2()).size(12.0));
            }
        });
        ToolbarRightResponse { bulk_clicked, columns_clicked }
    }

    // Part 1.5 -- generalizes the ad-hoc "Window + open/confirm bools"
    // pattern already repeated across most of this file's delete/reject/
    // halt confirmations into one call. `reason` is caller-owned (lives on
    // BackofficeApp, same as before) since the dialog itself has no frame-
    // to-frame memory of its own.
    pub struct ConfirmDialog<'a> {
        id: &'static str,
        title: &'a str,
        consequence: &'a str,
        require_reason: bool,
        require_typed: Option<&'a str>,
        danger: bool,
        confirm_label: &'a str,
    }

    pub struct ConfirmDialogResponse {
        pub confirmed: bool,
        pub still_open: bool,
    }

    impl<'a> ConfirmDialog<'a> {
        pub fn new(id: &'static str, title: &'a str, consequence: &'a str) -> Self {
            Self { id, title, consequence, require_reason: false, require_typed: None, danger: true, confirm_label: "Confirm" }
        }
        pub fn require_reason(mut self, v: bool) -> Self {
            self.require_reason = v;
            self
        }
        // Destructive actions (Suspend, Halt trading, Close all) can ask
        // the operator to type e.g. the account number back -- a
        // deliberate speed bump the spec calls out by name, not just a
        // reason text box.
        pub fn require_typed_confirmation(mut self, expected: &'a str) -> Self {
            self.require_typed = Some(expected);
            self
        }
        pub fn danger(mut self, v: bool) -> Self {
            self.danger = v;
            self
        }
        pub fn confirm_label(mut self, label: &'a str) -> Self {
            self.confirm_label = label;
            self
        }

        pub fn show(self, ctx: &egui::Context, reason: &mut String, typed: &mut String) -> ConfirmDialogResponse {
            let mut confirmed = false;
            let mut cancelled = false;
            let can_confirm = (!self.require_reason || !reason.trim().is_empty()) && self.require_typed.is_none_or(|expected| typed.trim() == expected);
            egui::Window::new(self.title)
                .id(egui::Id::new(self.id))
                .collapsible(false)
                .resizable(false)
                .show(ctx, |ui| {
                    ui.label(self.consequence);
                    ui.add_space(6.0);
                    if self.require_reason {
                        ui.label("Reason (required, shown to the client):");
                        ui.text_edit_singleline(reason);
                    }
                    if let Some(expected) = self.require_typed {
                        ui.label(format!("Type \"{expected}\" to confirm:"));
                        ui.text_edit_singleline(typed);
                    }
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        let resp = if self.danger {
                            theme::danger_button_enabled(ui, can_confirm, self.confirm_label)
                        } else {
                            theme::accent_button_enabled(ui, can_confirm, self.confirm_label)
                        };
                        if resp.clicked() {
                            confirmed = true;
                        }
                        if ui.button("Cancel").clicked() {
                            cancelled = true;
                        }
                    });
                });
            ConfirmDialogResponse { confirmed, still_open: !confirmed && !cancelled }
        }
    }

    // Part 1.3 -- right-side sticky panel. Native desktop app, no <1100px
    // breakpoint to speak of (the window itself is the viewport), so this
    // is always the fixed-width SidePanel form the spec describes for
    // >=1100px; the slide-over variant is a browser responsive concern
    // this app doesn't have.
    pub struct DetailDrawer<'a> {
        title: &'a str,
        subtitle: Option<&'a str>,
        status_pill: Option<(&'a str, egui::Color32)>,
        tabs: &'a [&'a str],
    }

    impl<'a> DetailDrawer<'a> {
        pub fn new(title: &'a str, tabs: &'a [&'a str]) -> Self {
            Self { title, subtitle: None, status_pill: None, tabs }
        }
        pub fn subtitle(mut self, s: &'a str) -> Self {
            self.subtitle = Some(s);
            self
        }
        pub fn status_pill(mut self, label: &'a str, color: egui::Color32) -> Self {
            self.status_pill = Some((label, color));
            self
        }

        // `selected_tab` is caller-owned index state; `body` is called once
        // per frame for whichever tab is currently selected. Returns
        // whether the drawer's own close (x) was clicked.
        pub fn show(self, ctx: &egui::Context, selected_tab: &mut usize, mut body: impl FnMut(&mut egui::Ui, usize)) -> bool {
            let mut close_clicked = false;
            egui::SidePanel::right("detail_drawer")
                .exact_width(420.0)
                .resizable(false)
                .frame(egui::Frame::new().fill(theme::bg_1()).stroke(egui::Stroke::new(1.0_f32, theme::border())).inner_margin(egui::Margin::same(16)))
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new(self.title).font(theme::heading_font(16.0)).color(theme::text_1()));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("\u{2715}").clicked() {
                                close_clicked = true;
                            }
                        });
                    });
                    ui.horizontal(|ui| {
                        if let Some((label, color)) = self.status_pill {
                            egui::Frame::new()
                                .fill(color.gamma_multiply(0.16))
                                .corner_radius(egui::CornerRadius::same(20))
                                .inner_margin(egui::Margin::symmetric(8, 2))
                                .show(ui, |ui| {
                                    ui.label(egui::RichText::new(label).size(11.0).color(color));
                                });
                        }
                    });
                    if let Some(sub) = self.subtitle {
                        ui.label(egui::RichText::new(sub).color(theme::text_3()).size(12.0));
                    }
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        for (i, tab) in self.tabs.iter().enumerate() {
                            let selected = *selected_tab == i;
                            let text = if selected {
                                egui::RichText::new(*tab).color(theme::accent()).strong()
                            } else {
                                egui::RichText::new(*tab).color(theme::text_3())
                            };
                            if ui.selectable_label(selected, text).clicked() {
                                *selected_tab = i;
                            }
                        }
                    });
                    ui.separator();
                    egui::ScrollArea::vertical().show(ui, |ui| {
                        body(ui, *selected_tab);
                    });
                });
            close_clicked
        }
    }

    // Part 1.4 -- the dirty-tracking + sticky save bar half of EditableGrid.
    // Deliberately doesn't try to own cell rendering too: Symbols' and
    // Groups-pricing's grids have very different column shapes, so the
    // reusable part is "track which cells changed and show one save bar,"
    // not a generic spreadsheet widget. A page using this calls `mark_dirty`
    // from its own per-cell input handling and reads `is_dirty` to decide
    // whether to draw a cell with the accent dirty-border.
    #[derive(Default)]
    pub struct EditableGridState {
        dirty: std::collections::HashSet<(String, &'static str)>,
        first_change_summary: Option<String>,
    }

    impl EditableGridState {
        pub fn mark_dirty(&mut self, row_id: &str, field: &'static str, summary: impl FnOnce() -> String) {
            let key = (row_id.to_string(), field);
            if !self.dirty.contains(&key) {
                if self.first_change_summary.is_none() {
                    self.first_change_summary = Some(summary());
                }
                self.dirty.insert(key);
            }
        }
        pub fn is_dirty(&self, row_id: &str, field: &'static str) -> bool {
            self.dirty.contains(&(row_id.to_string(), field))
        }
        pub fn count(&self) -> usize {
            self.dirty.len()
        }
        pub fn clear(&mut self) {
            self.dirty.clear();
            self.first_change_summary = None;
        }

        // Renders the sticky bottom bar when there are unsaved changes.
        // Returns (discard_clicked, save_clicked); Ctrl+S also triggers
        // save_clicked (spec: "Ctrl+S saves").
        pub fn save_bar(&self, ui: &mut egui::Ui, saving: bool) -> (bool, bool) {
            if self.dirty.is_empty() {
                return (false, false);
            }
            let ctrl_s = ui.ctx().input(|i| i.key_pressed(egui::Key::S) && i.modifiers.ctrl);
            let mut discard = false;
            let mut save = ctrl_s;
            egui::Frame::new()
                .fill(theme::bg_2())
                .stroke(egui::Stroke::new(1.0_f32, theme::accent()))
                .corner_radius(egui::CornerRadius::same(8))
                .inner_margin(egui::Margin::symmetric(14, 10))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let n = self.dirty.len();
                        let summary = self.first_change_summary.as_deref().unwrap_or("");
                        ui.label(egui::RichText::new(format!("{n} unsaved change{} \u{b7} {summary}", if n == 1 { "" } else { "s" })).color(theme::text_1()));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if theme::accent_button_enabled(ui, !saving, "Save changes").clicked() {
                                save = true;
                            }
                            if ui.add_enabled(!saving, egui::Button::new("Discard")).clicked() {
                                discard = true;
                            }
                        });
                    });
                });
            (discard, save)
        }
    }
}

#[derive(Default)]
struct NewAccountForm {
    full_name: String,
    email: String,
    password: String,
    is_live: bool,
    account_type_id: String,
    currency: String,
    group_id: String,
    leverage: String,
    initial_balance: String,
    country: String,
    phone: String,
    date_of_birth: String,
}

// Balance-adjust modal state -- separate from PendingModify (Live
// Exposure's own SL/TP modal) since the fields/target/endpoint differ.
#[derive(Default)]
struct AdjustBalance {
    account_id: String,
    account_number: String,
    is_credit: bool,
    amount: String,
    note: String,
    error: Option<String>,
}

struct BackofficeApp {
    tx: Sender<ApiEvent>,
    rx: Receiver<ApiEvent>,
    api: Option<ApiClient>,
    // Auto-refresh replaces the old per-screen manual "Refresh" button
    // (matches the web, which has none -- it stays current off a real
    // SSE stream this native app has no equivalent of; polling every 5s
    // is the closest honest substitute, not a cosmetic button removal
    // that would otherwise leave a screen stale forever after first
    // load, since ensure_loaded() only ever fetches a screen once).
    last_auto_refresh: std::time::Instant,

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
    // Header global search input (Part A item 6) -- the text field is
    // real and typeable; wiring it to an actual cross-entity query/
    // command-palette result list is real, substantial new work with no
    // spec of its own in any of the provided prompt files (no palette
    // behavior/results shape is described anywhere), so it's left as a
    // disclosed visual-only stub for this pass rather than faked with
    // made-up results.
    global_search: String,
    // Feed pill's real measured round-trip -- elapsed time between the
    // auto-refresh timer calling fetch() and the FIRST ApiEvent that
    // arrives afterward (drain_events' own timing hook). An
    // approximation (the first event to land isn't necessarily the one
    // that fetch() itself just started, if a background task from a
    // moment earlier is still in flight), but a real, measured number
    // from this app's own traffic -- not the design reference's
    // placeholder "42ms", which nothing in this codebase actually
    // computes.
    last_refresh_started: Option<std::time::Instant>,
    last_refresh_rtt_ms: Option<u64>,

    // --- dashboard ---
    dashboard: Option<DashboardData>,
    dashboard_loading: bool,
    dashboard_error: Option<String>,
    dashboard_activity_tab: usize,

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
    wallets_filter: String,
    show_new_account_form: bool,
    new_account: NewAccountForm,
    account_types: Vec<AccountTypeOption>,
    can_manage_finance: bool,
    created_account: Option<(String, String)>,
    adjust_target: Option<AdjustBalance>,
    pending_adjustments: Vec<PendingAdjustment>,
    pending_adjustment_errors: HashMap<String, String>,
    reviewing_adjustment_id: Option<String>,

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
    // Deliberately separate from dealing_error: the dealer on/off switch
    // is RISK_SETTINGS-gated (app/api/manage/dealing-desk-toggle/route.ts),
    // narrower than what Screen::Dealing itself needs -- a MANAGER without
    // that one permission still sees a working dealing queue, just no
    // switch. Sharing dealing_error used to paint the whole page red
    // ("forbidden") over a single missing permission on an unrelated card.
    dealer_toggle_error: Option<String>,
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
    pricing_edit_buffer: HashMap<String, PricingEditRow>,

    // --- KYC (identity document review, separate screen from Client KYC) ---
    kyc: Vec<KycRow>,
    kyc_loading: bool,
    kyc_error: Option<String>,
    kyc_docs_reject: Option<PendingReject>,
    kyc_document: Option<egui::TextureHandle>,
    kyc_document_error: Option<String>,
    kyc_document_loading: bool,

    // --- client KYC ---
    client_kyc: Vec<ClientKycRow>,
    client_kyc_loading: bool,
    client_kyc_error: Option<String>,
    kyc_reject: Option<PendingReject>,
    client_kyc_expanded: HashSet<String>,

    // --- live account requests ---
    live_account_requests: Vec<LiveAccountRequestRow>,
    live_account_requests_loading: bool,
    live_account_requests_error: Option<String>,
    live_account_reject: Option<PendingReject>,

    // --- notifications ---
    notifications: Vec<NotificationRow>,
    notifications_loading: bool,
    notifications_error: Option<String>,
    reset_password_target: Option<NotificationRow>,
    reset_password_result: Option<String>,
    reset_password_error: Option<String>,
    reset_password_busy: bool,

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
    symbol_edit: HashMap<String, api::SymbolConfigEdit>,
    symbol_sessions_for: Option<SymbolConfigRow>,
    symbol_sessions: Option<Vec<api::SymbolSessionRow>>,
    symbol_sessions_loading: bool,
    symbol_sessions_error: Option<String>,
    symbol_session_new_day: i64,
    symbol_session_new_open: String,
    symbol_session_new_close: String,

    // --- team ---
    admins: Vec<AdminRow>,
    admins_loading: bool,
    admins_error: Option<String>,
    new_admin_email: String,
    new_admin_password: String,
    new_admin_role: String,
    new_admin_error: Option<String>,

    // --- transfers ---
    transfers: Vec<TransferRow>,
    transfers_loading: bool,
    transfers_error: Option<String>,
    transfer_from_id: String,
    transfer_to_id: String,
    transfer_amount: String,
    transfer_note: String,

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
    deals_filter: String,
    deal_delete_confirm: Option<(DealRow, String, Option<String>)>,

    // --- audit ---
    audit_log: Vec<AuditLogRow>,
    audit_loading: bool,
    audit_error: Option<String>,
    audit_query: String,
    audit_expanded: Option<String>,

    // --- funds ---
    funds_requests: Vec<FundsRequestRow>,
    funds_loading: bool,
    funds_error: Option<String>,
    current_admin_id: String,
    funds_confirm: Option<(FundsRequestRow, &'static str)>,

    // --- payment methods ---
    payment_methods: Vec<PaymentMethodRow>,
    payment_methods_loading: bool,
    payment_methods_error: Option<String>,
    payment_method_edit: HashMap<String, PaymentMethodEdit>,

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

    // --- risk rules (Broker-wide dealing mode, exposure/position limits,
    // Smart Dealer -- separate screen from Emergency, same /api/manage/
    // risk endpoint) ---
    risk_settings: Option<RiskData>,
    risk_settings_loading: bool,
    risk_settings_error: Option<String>,
    risk_settings_confirm_dealing: bool,
    risk_settings_dealing_busy: bool,
    risk_exposure_limit_input: String,
    risk_max_positions_input: String,
    risk_limits_saved: bool,
    risk_smart_accept_input: String,
    risk_smart_reject_input: String,
    risk_smart_saved: bool,
}

impl Default for BackofficeApp {
    fn default() -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            tx,
            rx,
            api: None,
            last_auto_refresh: std::time::Instant::now(),
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
            global_search: String::new(),
            last_refresh_started: None,
            last_refresh_rtt_ms: None,
            dashboard: None,
            dashboard_loading: false,
            dashboard_error: None,
            dashboard_activity_tab: 0,
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
            wallets_filter: String::new(),
            show_new_account_form: false,
            new_account: NewAccountForm::default(),
            account_types: Vec::new(),
            can_manage_finance: false,
            created_account: None,
            adjust_target: None,
            pending_adjustments: Vec::new(),
            pending_adjustment_errors: HashMap::new(),
            reviewing_adjustment_id: None,
            dealing_queue: Vec::new(),
            dealing_requoted: Vec::new(),
            dealing_loading: false,
            dealing_error: None,
            dealing_reject: None,
            dealing_requote: None,
            dealer_toggle: None,
            dealer_toggle_busy: false,
            dealer_toggle_confirm_off: false,
            dealer_toggle_error: None,
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
            kyc: Vec::new(),
            kyc_loading: false,
            kyc_error: None,
            kyc_docs_reject: None,
            kyc_document: None,
            kyc_document_error: None,
            kyc_document_loading: false,
            client_kyc: Vec::new(),
            client_kyc_loading: false,
            client_kyc_error: None,
            kyc_reject: None,
            client_kyc_expanded: HashSet::new(),
            live_account_requests: Vec::new(),
            live_account_requests_loading: false,
            live_account_requests_error: None,
            live_account_reject: None,
            notifications: Vec::new(),
            notifications_loading: false,
            notifications_error: None,
            reset_password_target: None,
            reset_password_result: None,
            reset_password_error: None,
            reset_password_busy: false,
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
            symbol_edit: HashMap::new(),
            symbol_sessions_for: None,
            symbol_sessions: None,
            symbol_sessions_loading: false,
            symbol_sessions_error: None,
            symbol_session_new_day: 1,
            symbol_session_new_open: "00:00".to_string(),
            symbol_session_new_close: "23:59".to_string(),
            admins: Vec::new(),
            admins_loading: false,
            admins_error: None,
            new_admin_email: String::new(),
            new_admin_password: String::new(),
            new_admin_role: String::new(),
            new_admin_error: None,
            transfers: Vec::new(),
            transfers_loading: false,
            transfers_error: None,
            transfer_from_id: String::new(),
            transfer_to_id: String::new(),
            transfer_amount: String::new(),
            transfer_note: String::new(),
            ib_relationships: Vec::new(),
            ib_loading: false,
            ib_error: None,
            leads: Vec::new(),
            leads_loading: false,
            leads_error: None,
            deals: Vec::new(),
            deals_loading: false,
            deals_error: None,
            deals_filter: String::new(),
            deal_delete_confirm: None,
            audit_log: Vec::new(),
            audit_loading: false,
            audit_error: None,
            audit_query: String::new(),
            audit_expanded: None,
            funds_requests: Vec::new(),
            funds_loading: false,
            funds_error: None,
            current_admin_id: String::new(),
            funds_confirm: None,
            payment_methods: Vec::new(),
            payment_methods_loading: false,
            payment_methods_error: None,
            payment_method_edit: HashMap::new(),
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
            risk_settings: None,
            risk_settings_loading: false,
            risk_settings_error: None,
            risk_settings_confirm_dealing: false,
            risk_settings_dealing_busy: false,
            risk_exposure_limit_input: String::new(),
            risk_max_positions_input: String::new(),
            risk_limits_saved: false,
            risk_smart_accept_input: String::new(),
            risk_smart_reject_input: String::new(),
            risk_smart_saved: false,
        }
    }
}

impl BackofficeApp {
    fn drain_events(&mut self, ctx: &egui::Context) {
        while let Ok(event) = self.rx.try_recv() {
            // Feed pill's real RTT measurement -- see last_refresh_rtt_ms's
            // own field comment. Consumes the pending start time on the
            // FIRST event seen after it was set, regardless of which
            // event that is.
            if let Some(started) = self.last_refresh_started.take() {
                self.last_refresh_rtt_ms = Some(started.elapsed().as_millis() as u64);
            }
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
                    // Eager, silent load so the sidebar's unread-count
                    // badge (matches AdminShell.tsx's own
                    // initialUnreadNotifications) is accurate shortly
                    // after login, not just after the user first opens
                    // Notifications themselves. Same reasoning extended
                    // (redesign Part B item 4) to the other three "pending
                    // work" badges -- KYC review, Live account requests,
                    // Deposits & withdrawals -- so all four are correct
                    // the moment the sidebar first renders, not only
                    // after each screen has been visited once.
                    self.ensure_loaded(ctx, Screen::Notifications);
                    self.ensure_loaded(ctx, Screen::Kyc);
                    self.ensure_loaded(ctx, Screen::LiveAccountRequests);
                    self.ensure_loaded(ctx, Screen::Funds);
                }
                ApiEvent::ShellInfo(Ok(info)) => {
                    self.broker_name = Some(info.broker_name);
                    self.can_manage_finance = info.can_manage_finance;
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
                ApiEvent::PasswordReset(result) => {
                    self.reset_password_busy = false;
                    match result {
                        Ok(password) => self.reset_password_result = Some(password),
                        Err(e) => self.reset_password_error = Some(e),
                    }
                }
                ApiEvent::DealDeleted(result) => match result {
                    Ok(pending) => {
                        self.deal_delete_confirm = None;
                        self.action_message = Some(if pending {
                            "Delete submitted for approval. A different admin needs to review it (Live Exposure page).".to_string()
                        } else {
                            "deal deleted".to_string()
                        });
                        self.fetch(ctx, Screen::Deals);
                    }
                    Err(e) => {
                        if let Some((_, _, err)) = &mut self.deal_delete_confirm {
                            *err = Some(e);
                        }
                    }
                },
                ApiEvent::AccountTypes(result) => {
                    if let Ok(rows) = result {
                        self.account_types = rows;
                    }
                }
                ApiEvent::AccountCreated(result) => match result {
                    Ok((account_number, password)) => {
                        self.created_account = Some((account_number, password));
                        self.fetch(ctx, Screen::Accounts);
                    }
                    Err(e) => self.action_message = Some(format!("failed: {e}")),
                },
                ApiEvent::AdjustBalance(result) => match result {
                    Ok(pending) => {
                        self.adjust_target = None;
                        self.action_message = Some(if pending {
                            "Balance adjustment submitted for approval. A different admin needs to review it before it takes effect.".to_string()
                        } else {
                            "balance adjusted".to_string()
                        });
                        self.fetch(ctx, Screen::Accounts);
                        if let Some(api) = &self.api {
                            api.fetch_pending_adjustments(ctx.clone(), self.tx.clone());
                        }
                    }
                    Err(e) => {
                        if let Some(target) = &mut self.adjust_target {
                            target.error = Some(e);
                        }
                    }
                },
                ApiEvent::PendingAdjustments(result) => {
                    if let Ok(rows) = result {
                        self.pending_adjustments = rows;
                    }
                    self.reviewing_adjustment_id = None;
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
                        Err(e) => self.dealer_toggle_error = Some(e),
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
                                        PricingEditRow {
                                            is_target_mode: r.target_total_spread_pips.is_some(),
                                            spread_markup: r.spread_markup.clone().unwrap_or_default(),
                                            target_total_spread_pips: r.target_total_spread_pips.clone().unwrap_or_default(),
                                            commission_per_lot: r.commission_per_lot.clone().unwrap_or_default(),
                                            swap_long: r.swap_long.clone().unwrap_or_default(),
                                            swap_short: r.swap_short.clone().unwrap_or_default(),
                                        },
                                    )
                                })
                                .collect();
                            self.group_pricing = rows;
                        }
                        Err(e) => self.group_pricing_error = Some(e),
                    }
                }
                ApiEvent::Kyc(result) => {
                    self.kyc_loading = false;
                    match result {
                        Ok(rows) => self.kyc = rows,
                        Err(e) => self.kyc_error = Some(e),
                    }
                }
                ApiEvent::KycDocument(result) => {
                    self.kyc_document_loading = false;
                    match result {
                        Ok((pixels, [w, h])) => {
                            let color_image = egui::ColorImage::from_rgba_unmultiplied([w, h], &pixels);
                            self.kyc_document = Some(ctx.load_texture("kyc-document", color_image, egui::TextureOptions::default()));
                            self.kyc_document_error = None;
                        }
                        Err(e) => self.kyc_document_error = Some(e),
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
                ApiEvent::SymbolSessions(result) => {
                    self.symbol_sessions_loading = false;
                    match result {
                        Ok(rows) => self.symbol_sessions = Some(rows),
                        Err(e) => self.symbol_sessions_error = Some(e),
                    }
                }
                ApiEvent::Admins(result) => {
                    self.admins_loading = false;
                    match result {
                        Ok((admin_id, rows)) => {
                            self.current_admin_id = admin_id;
                            self.admins = rows;
                        }
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
                        Ok((admin_id, rows)) => {
                            self.current_admin_id = admin_id;
                            self.funds_requests = rows;
                        }
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
                ApiEvent::RiskSettings(result) => {
                    self.risk_settings_loading = false;
                    self.risk_settings_dealing_busy = false;
                    match result {
                        Ok(data) => {
                            self.risk_exposure_limit_input = data.total_exposure_limit.clone().unwrap_or_default();
                            self.risk_max_positions_input =
                                data.max_open_positions_per_account.map(|n| n.to_string()).unwrap_or_default();
                            self.risk_smart_accept_input = data.smart_dealer_accept_pct.clone().unwrap_or_default();
                            self.risk_smart_reject_input = data.smart_dealer_reject_pct.clone().unwrap_or_default();
                            self.risk_settings = Some(data);
                        }
                        Err(e) => self.risk_settings_error = Some(e),
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
                        self.transfer_amount.clear();
                        self.transfer_note.clear();
                        self.kyc_docs_reject = None;
                        self.funds_confirm = None;
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
                // Dashboard's Exposure-by-symbol and Risk-watch cards
                // (futurix-dashboard-design.html) reuse Live Exposure's and
                // Margin's own already-loaded data client-side rather than
                // duplicating those aggregations in a new endpoint --
                // refetched here on every Dashboard cycle so the cards stay
                // live even if the admin never actually visits those two
                // screens directly this session.
                self.positions_loading = true;
                self.positions_error = None;
                api.fetch_positions(ctx.clone(), self.tx.clone());
                self.margin_loading = true;
                self.margin_error = None;
                api.fetch_margin(ctx.clone(), self.tx.clone());
                // "Volume (7d)" KPI reads closed trades' closedAt/volume
                // client-side from the same Deals list the Deals screen
                // itself uses -- real numbers, no new endpoint. Capped at
                // "most recent 500" (Deals' own known limit, see
                // fetch_deals' comment): if a broker closes >500 trades in
                // 7 days this undercounts, same honest caveat Deals itself
                // already carries.
                self.deals_loading = true;
                self.deals_error = None;
                api.fetch_deals(ctx.clone(), self.tx.clone());
                // Accounts backs "Client equity (now)" (sum of live-account
                // balances) -- ensure_loaded, not a hard refetch every
                // cycle: heavier than positions/margin and the KPI doesn't
                // need second-by-second freshness the way exposure/risk do.
                self.ensure_loaded(ctx, Screen::Accounts);
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
                api.fetch_account_types(ctx.clone(), self.tx.clone());
                api.fetch_pending_adjustments(ctx.clone(), self.tx.clone());
            }
            Screen::Dealing => {
                self.dealing_loading = true;
                self.dealing_error = None;
                api.fetch_dealing_queue(ctx.clone(), self.tx.clone());
                self.dealer_toggle_error = None;
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
            Screen::Kyc => {
                self.kyc_loading = true;
                self.kyc_error = None;
                api.fetch_kyc(ctx.clone(), self.tx.clone());
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
            Screen::Risk => {
                self.risk_settings_loading = true;
                self.risk_settings_error = None;
                api.fetch_risk_settings(ctx.clone(), self.tx.clone());
                api.fetch_margin(ctx.clone(), self.tx.clone());
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
                api.fetch_accounts(ctx.clone(), self.tx.clone());
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
                api.fetch_audit_log(ctx.clone(), self.tx.clone(), self.audit_query.clone());
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
        egui::CentralPanel::default().frame(egui::Frame::new().fill(theme::bg_0())).show(ctx, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space(110.0);
                ui.label(egui::RichText::new("●").size(28.0).color(theme::accent()));
                ui.add_space(6.0);
                ui.label(egui::RichText::new("VyXTrader").size(26.0).color(theme::text_1()));
                ui.label(egui::RichText::new("BACKOFFICE").size(12.0).color(theme::text_3()));
                ui.add_space(28.0);

                egui::Frame::new()
                    .fill(theme::bg_1())
                    .stroke(egui::Stroke::new(1.0_f32, theme::border()))
                    .corner_radius(egui::CornerRadius::same(12))
                    .inner_margin(egui::Margin::same(24))
                    .show(ui, |ui| {
                        ui.set_width(360.0);
                        ui.label(egui::RichText::new("BROKER HOST").size(11.0).color(theme::text_3()));
                        ui.add_space(4.0);
                        ui.add(egui::TextEdit::singleline(&mut self.host_input).hint_text("brokername.vyxtrader.com").desired_width(f32::INFINITY));
                        ui.add_space(12.0);
                        ui.label(egui::RichText::new("EMAIL").size(11.0).color(theme::text_3()));
                        ui.add_space(4.0);
                        ui.add(egui::TextEdit::singleline(&mut self.email_input).hint_text("admin@broker.com").desired_width(f32::INFINITY));
                        ui.add_space(12.0);
                        ui.label(egui::RichText::new("PASSWORD").size(11.0).color(theme::text_3()));
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
                            ui.colored_label(theme::danger(), err);
                        }
                    });

                ui.add_space(16.0);
                ui.label(egui::RichText::new("2FA-enabled admin accounts aren't supported here yet -- use the web backoffice for those.").weak().small());
            });
        });
    }

    fn render_shell(&mut self, ctx: &egui::Context) {
        egui::SidePanel::left("sidebar")
            .resizable(false)
            .exact_width(232.0)
            .frame(egui::Frame::new().fill(theme::sidebar_bg()).inner_margin(egui::Margin::symmetric(0, 12)).stroke(egui::Stroke { width: 1.0, color: theme::border() }))
            .show(ctx, |ui| {
                // Brand no longer duplicated here (Part A item 1: "Brand
                // cell belongs to the header row... Sidebar starts below
                // the header" -- render_titlebar's own 232px-wide brand
                // cell is the only place it renders now, matching the
                // reference exactly instead of the old two-baseline
                // brand-in-both-places bug). Width matches the header's
                // own brand cell (232px) so the border-right up there
                // lines up with this panel's own left edge.
                ui.add_space(4.0);

                egui::ScrollArea::vertical()
                    .scroll_bar_visibility(egui::scroll_area::ScrollBarVisibility::VisibleWhenNeeded)
                    .show(ui, |ui| {
                    // Redesign IA (PROMPT-backoffice-15-pages.md Part 2) --
                    // exact section membership/order from the spec. Three
                    // screens that the OLD IA showed as separate nav rows
                    // are deliberately left OUT of these slices without
                    // deleting the Screen variant or its render fn: Part 2
                    // lists only the merged name for each ("Risk", not
                    // "Risk rules" + "Margin monitoring" as two rows;
                    // "Liquidity providers", not it + "Routing" as two
                    // rows; "KYC review", not it + "Client KYC" as two
                    // rows). The real page-level merge (Part 3.4/3.7/3.11)
                    // is later work -- for this IA-only pass, hiding the
                    // duplicate row is the minimal change that satisfies
                    // Part 2 without discarding the still-functional
                    // screen underneath it. Old routes need no redirect
                    // layer: this is a native sidebar-driven app with no
                    // deep-linkable URLs, so "nothing points at the old
                    // separate row anymore" already is the redirect.
                    let groups: [(&str, &[Screen]); 7] = [
                        ("OVERVIEW", &[Screen::Dashboard, Screen::Reports, Screen::Notifications]),
                        (
                            "TRADING",
                            &[Screen::Positions, Screen::Dealing, Screen::Deals, Screen::Symbols, Screen::Groups],
                        ),
                        ("RISK", &[Screen::Risk, Screen::RiskRadar, Screen::Emergency]),
                        ("LIQUIDITY", &[Screen::Liquidity, Screen::FeedHealth]),
                        (
                            "CLIENTS",
                            &[Screen::Accounts, Screen::Leads, Screen::Ib, Screen::Kyc, Screen::LiveAccountRequests],
                        ),
                        (
                            "FINANCE",
                            &[Screen::Funds, Screen::PaymentMethods, Screen::Transfers, Screen::Wallets],
                        ),
                        ("SYSTEM", &[Screen::Team, Screen::Audit, Screen::Security, Screen::Settings]),
                    ];
                    for (label, screens) in groups {
                        ui.add_space(6.0);
                        ui.horizontal(|ui| {
                            ui.add_space(20.0);
                            ui.label(egui::RichText::new(label).size(10.0).color(theme::text_3()).strong());
                        });
                        for &screen in screens {
                            // Part B item 4 -- count badges on items with
                            // pending work. Each count is the same real
                            // row list that screen's own page already
                            // renders (eager-loaded on login above), never
                            // a separate/fabricated number; a badge only
                            // shows once its data has actually loaded
                            // (avoids a misleading "0" flash before the
                            // first fetch resolves).
                            let badge = match screen {
                                Screen::Notifications => Some(self.notifications.iter().filter(|n| !n.read).count()),
                                Screen::Kyc if !self.kyc.is_empty() || self.loaded_once.contains(&Screen::Kyc) => Some(self.kyc.len()),
                                Screen::LiveAccountRequests
                                    if !self.live_account_requests.is_empty() || self.loaded_once.contains(&Screen::LiveAccountRequests) =>
                                {
                                    Some(self.live_account_requests.iter().filter(|r| r.status == "PENDING").count())
                                }
                                Screen::Funds if !self.funds_requests.is_empty() || self.loaded_once.contains(&Screen::Funds) => {
                                    Some(self.funds_requests.iter().filter(|r| r.status == "PENDING").count())
                                }
                                _ => None,
                            };
                            let badge = badge.filter(|&n| n > 0);
                            if sidebar_nav_item(ui, screen.icon(), screen.label(), self.screen == screen, badge).clicked() {
                                self.screen = screen;
                                self.ensure_loaded(ctx, screen);
                            }
                        }
                    }
                    ui.add_space(10.0);
                });
            });

        egui::CentralPanel::default()
            .frame(egui::Frame::new().fill(theme::bg_0()).inner_margin(egui::Margin::symmetric(24, 20)))
            .show(ctx, |ui| {
            if let Some(msg) = self.action_message.clone() {
                egui::Frame::new()
                    .fill(theme::bg_1())
                    .stroke(egui::Stroke::new(1.0_f32, theme::border()))
                    .corner_radius(egui::CornerRadius::same(8))
                    .inner_margin(egui::Margin::symmetric(14, 10))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new(&msg).color(theme::text_1()));
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
                Screen::Kyc => self.render_kyc(ui, ctx),
                Screen::ClientKyc => self.render_client_kyc(ui, ctx),
                Screen::LiveAccountRequests => self.render_live_account_requests(ui, ctx),
                Screen::Notifications => self.render_notifications(ui, ctx),
                Screen::RiskRadar => self.render_risk_radar(ui, ctx),
                Screen::Risk => self.render_risk_settings(ui, ctx),
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

    // Direct native port of DashboardManager.tsx -- the same 5 stat
    // cards (with the web's own delta annotations, not 7 separate
    // cards), evenly spanning the full available width instead of a
    // fixed-width grid with leftover space, and "Recent activity" in its
    // own card with row separators/hover, matching the stat cards'
    // container style. No Refresh button -- the web has none either;
    // this screen re-fetches whenever it's (re)opened.
    // Redesign pass (futurix-dashboard-design.html; README.md: "layout
    // described in the design; follow shell rules" -- no dedicated prompt
    // file for this page). Reuses Live Exposure's and Margin's own
    // already-fetched data for the Exposure-by-symbol and Risk-watch
    // cards (see fetch()'s Screen::Dashboard arm) rather than a new
    // endpoint duplicating those aggregations; Deals' already-fetched
    // list (capped at 500, same as the Deals page itself) backs the
    // Volume(7d) KPI. Net deposits/deposits-vs-withdrawals are the one
    // genuinely new piece of server data (dashboard route.ts). The design
    // mockup's Risk-watch pill claims "Stop-out level enforced by engine:
    // Yes * 50%" -- per Part 0.4's verified finding this is FALSE for the
    // Rust engine (dormant scaffold, no I/O) though TRUE for the real
    // Node/Cron enforcement (lib/risk-monitor.ts, every 1 min); this page
    // states that correctly instead of reproducing the mockup's claim.
    fn render_dashboard(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if self.dashboard_loading && self.dashboard.is_none() {
            ui.horizontal(|ui| {
                ui.spinner();
                ui.label("Loading...");
            });
            ui.add_space(8.0);
        }

        if let Some(err) = &self.dashboard_error {
            ui.colored_label(theme::danger(), err);
            return;
        }
        let Some(data) = self.dashboard.clone() else { return };

        // --- Greeting ---
        let utc_hour = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() / 3600) % 24;
        let greeting = if utc_hour < 12 { "Good morning" } else if utc_hour < 18 { "Good afternoon" } else { "Good evening" };
        let broker_name = self.broker_name.clone().unwrap_or_else(|| "your broker".to_string());
        ui.label(egui::RichText::new(greeting).font(theme::heading_font(22.0)).color(theme::text_1()));
        ui.label(egui::RichText::new(format!("Here's what needs your attention on {broker_name} today.")).color(theme::text_3()));
        ui.add_space(14.0);

        // --- Attention row ---
        let margin_call_count = self.margin.iter().filter(|m| m.margin_level.is_some_and(|lvl| lvl <= m.margin_call_level)).count();
        // "near stop-out": a margin-call account whose level has also
        // dropped within 1.5x the stop-out level -- a judgment call (the
        // mockup shows this as a sub-detail with no formula behind it).
        let near_stop_out_count = self
            .margin
            .iter()
            .filter(|m| m.margin_level.is_some_and(|lvl| lvl <= m.margin_call_level && lvl <= m.stop_out_level * 1.5))
            .count();
        let live_request_count = self.live_account_requests.iter().filter(|r| r.status == "PENDING").count();

        let mut nav_target: Option<Screen> = None;
        ui.columns(4, |cols| {
            let margin_sub = if near_stop_out_count > 0 { format!("Below call level \u{b7} {near_stop_out_count} near stop-out") } else { "Below call level".to_string() };
            if dashboard_attention_card(&mut cols[0], &margin_call_count.to_string(), "Margin calls", &margin_sub, "Review", margin_call_count > 0) {
                nav_target = Some(Screen::Risk);
            }
            if dashboard_attention_card(
                &mut cols[1],
                &data.pending_withdrawal_count.to_string(),
                "Withdrawals to approve",
                &format!("${:.2} requested", data.pending_withdrawal_sum),
                "Approve",
                data.pending_withdrawal_count > 0,
            ) {
                nav_target = Some(Screen::Funds);
            }
            if dashboard_attention_card(&mut cols[2], &data.pending_kyc.to_string(), "KYC pending", "Awaiting review", "Verify", data.pending_kyc > 0) {
                nav_target = Some(Screen::Kyc);
            }
            if dashboard_attention_card(&mut cols[3], &live_request_count.to_string(), "Live account requests", "Awaiting approval", "Open", live_request_count > 0) {
                nav_target = Some(Screen::LiveAccountRequests);
            }
        });
        if let Some(screen) = nav_target {
            self.screen = screen;
            self.ensure_loaded(ctx, screen);
        }
        ui.add_space(14.0);

        // --- KPI row ---
        let net_deposits_pct =
            (data.net_deposits_prior_7d.abs() > 0.01).then(|| ((data.net_deposits_7d - data.net_deposits_prior_7d) / data.net_deposits_prior_7d.abs()) * 100.0);
        // clamp_zero: currency-rounding drift on a near-empty sum (e.g. one
        // stray "-0.00" account balance) otherwise displays as the
        // confusing "$-0.00" rather than "$0.00".
        let clamp_zero = |v: f64| if v.abs() < 0.005 { 0.0 } else { v };
        let live_balances: f64 = clamp_zero(self.accounts.iter().filter(|a| a.account_mode == "LIVE").filter_map(|a| a.balance.parse::<f64>().ok()).sum());
        let live_credit: f64 = clamp_zero(self.accounts.iter().filter(|a| a.account_mode == "LIVE").filter_map(|a| a.credit.parse::<f64>().ok()).sum());
        let total_floating: f64 = self.positions.iter().filter_map(|p| p.floating_pnl.as_deref().and_then(|s| s.parse::<f64>().ok())).sum();
        let client_equity = live_balances + live_credit + total_floating;
        // Broker's own book P&L is the inverse of clients' floating P&L --
        // exactly what the design mockup itself shows ("Book P&L +$26.56"
        // next to "Clients -$26.56"). A simplification: this doesn't net
        // out any A-book/hedged exposure the broker has passed to an LP,
        // since no LP-hedge-share data is loaded on this screen.
        let book_pnl = -total_floating;

        let today = date_days_ago(0);
        let seven_days_ago = date_days_ago(7);
        let fourteen_days_ago = date_days_ago(14);
        let (volume_7d, trades_7d) = self
            .deals
            .iter()
            .filter(|d| d.closed_at.as_str() >= seven_days_ago.as_str())
            .fold((0.0_f64, 0_usize), |(vol, n), d| (vol + d.volume.parse::<f64>().unwrap_or(0.0), n + 1));
        let volume_prior_7d: f64 = self
            .deals
            .iter()
            .filter(|d| d.closed_at.as_str() >= fourteen_days_ago.as_str() && d.closed_at.as_str() < seven_days_ago.as_str())
            .filter_map(|d| d.volume.parse::<f64>().ok())
            .sum();
        let volume_pct = (volume_prior_7d > 0.01).then(|| ((volume_7d - volume_prior_7d) / volume_prior_7d) * 100.0);

        let kpis: [(&str, String, Option<(String, egui::Color32)>); 4] = [
            (
                "Net deposits (7d)",
                format!("${:.2}", data.net_deposits_7d),
                net_deposits_pct.map(|p| (format!("{}{:.0}% vs prior 7d", if p >= 0.0 { "+" } else { "" }, p), if p >= 0.0 { theme::up() } else { theme::down() })),
            ),
            (
                "Client equity (now)",
                format!("${client_equity:.2}"),
                Some((format!("Balance ${live_balances:.2} \u{b7} Credit ${live_credit:.2}"), theme::text_3())),
            ),
            (
                "Book P&L (floating)",
                format!("{}${:.2}", if book_pnl >= 0.0 { "+" } else { "-" }, book_pnl.abs()),
                Some((
                    format!(
                        "Clients {}${:.2} \u{b7} {} position{}",
                        if total_floating >= 0.0 { "+" } else { "-" },
                        total_floating.abs(),
                        self.positions.len(),
                        if self.positions.len() == 1 { "" } else { "s" }
                    ),
                    theme::text_3(),
                )),
            ),
            (
                "Volume (7d)",
                format!("{volume_7d:.1} lots"),
                Some(
                    volume_pct
                        .map(|p| (format!("{}{:.0}% \u{b7} {trades_7d} trades", if p >= 0.0 { "+" } else { "" }, p), if p >= 0.0 { theme::up() } else { theme::down() }))
                        .unwrap_or_else(|| (format!("{trades_7d} trades"), theme::text_3())),
                ),
            ),
        ];
        responsive_stat_row(ui, &kpis);
        ui.add_space(18.0);

        // --- Exposure by symbol + Risk watch ---
        let avail = ui.available_width();
        let gap = 14.0;
        let left_w = (avail - gap) * 0.65;
        let right_w = avail - gap - left_w;
        ui.horizontal_top(|ui| {
            ui.allocate_ui_with_layout(egui::vec2(left_w, 0.0), egui::Layout::top_down(egui::Align::Min), |ui| {
                self.render_dashboard_exposure_card(ui);
            });
            ui.add_space(gap);
            ui.allocate_ui_with_layout(egui::vec2(right_w, 0.0), egui::Layout::top_down(egui::Align::Min), |ui| {
                self.render_dashboard_risk_watch_card(ui);
            });
        });
        ui.add_space(14.0);

        // --- Deposits vs withdrawals + Activity ---
        ui.horizontal_top(|ui| {
            ui.allocate_ui_with_layout(egui::vec2(left_w, 0.0), egui::Layout::top_down(egui::Align::Min), |ui| {
                theme::card(14).show(ui, |ui| {
                    ui.strong("Deposits vs withdrawals");
                    ui.add_space(10.0);
                    dashboard_bar_chart(ui, &data.deposits_withdrawals_by_day);
                });
            });
            ui.add_space(gap);
            ui.allocate_ui_with_layout(egui::vec2(right_w, 0.0), egui::Layout::top_down(egui::Align::Min), |ui| {
                self.render_dashboard_activity_card(ui, &data.activity, &today);
            });
        });
    }

    fn render_dashboard_exposure_card(&mut self, ui: &mut egui::Ui) {
        struct ExposureAcc {
            symbol: String,
            buy_volume: f64,
            sell_volume: f64,
            buy_notional: f64,
            current_price: Option<String>,
            floating_pnl: f64,
        }
        let mut by_symbol: HashMap<String, ExposureAcc> = HashMap::new();
        let mut net_exposure_total = 0.0_f64;
        let mut largest: Option<&PositionRow> = None;
        for p in &self.positions {
            let volume: f64 = p.volume.parse().unwrap_or(0.0);
            net_exposure_total += if p.side == "BUY" { volume } else { -volume };
            if largest.is_none_or(|l| volume > l.volume.parse().unwrap_or(0.0)) {
                largest = Some(p);
            }
            let entry = by_symbol.entry(p.symbol_name.clone()).or_insert(ExposureAcc {
                symbol: p.symbol_name.clone(),
                buy_volume: 0.0,
                sell_volume: 0.0,
                buy_notional: 0.0,
                current_price: p.current_price.clone(),
                floating_pnl: 0.0,
            });
            let open_price: f64 = p.open_price.parse().unwrap_or(0.0);
            if p.side == "BUY" {
                entry.buy_volume += volume;
                entry.buy_notional += volume * open_price;
            } else {
                entry.sell_volume += volume;
            }
            if let Some(pnl) = p.floating_pnl.as_deref().and_then(|s| s.parse::<f64>().ok()) {
                entry.floating_pnl += pnl;
            }
        }
        let mut rows: Vec<ExposureAcc> = by_symbol.into_values().collect();
        rows.sort_by(|a, b| (b.buy_volume + b.sell_volume).partial_cmp(&(a.buy_volume + a.sell_volume)).unwrap_or(std::cmp::Ordering::Equal));
        let largest_label = largest.map(|l| format!("{} \u{b7} {}", l.volume, l.symbol_name)).unwrap_or_else(|| "-".to_string());
        let position_count = self.positions.len();
        let mut nav_to_positions = false;

        theme::card(14).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.strong("Exposure by symbol");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.link("Open live exposure \u{2192}").clicked() {
                        nav_to_positions = true;
                    }
                });
            });
            ui.add_space(10.0);
            ui.columns(3, |cols| {
                dashboard_mini_stat(&mut cols[0], "Net exposure", &format!("{:+.2} lots", net_exposure_total));
                dashboard_mini_stat(&mut cols[1], "Open positions", &position_count.to_string());
                dashboard_mini_stat(&mut cols[2], "Largest single position", &largest_label);
            });
            ui.add_space(10.0);
            if rows.is_empty() {
                ui.weak("No open positions.");
                return;
            }
            ui.horizontal(|ui| {
                for (label, w) in [("Symbol", 70.0), ("Net", 70.0), ("Buy", 60.0), ("Sell", 60.0), ("Price", 80.0)] {
                    ui.add_sized([w, 0.0], egui::Label::new(egui::RichText::new(label.to_uppercase()).size(10.5).color(theme::text_3())));
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(egui::RichText::new("CLIENT P&L").size(10.5).color(theme::text_3()));
                });
            });
            ui.add_space(4.0);
            for r in rows.iter().take(8) {
                ui.horizontal(|ui| {
                    ui.add_sized([70.0, 0.0], egui::Label::new(egui::RichText::new(&r.symbol).monospace()));
                    let net = r.buy_volume - r.sell_volume;
                    ui.add_sized([70.0, 0.0], egui::Label::new(egui::RichText::new(format!("{net:+.2}")).color(if net >= 0.0 { theme::up() } else { theme::down() })));
                    ui.add_sized([60.0, 0.0], egui::Label::new(egui::RichText::new(format!("{:.2}", r.buy_volume)).color(theme::text_3())));
                    ui.add_sized([60.0, 0.0], egui::Label::new(egui::RichText::new(format!("{:.2}", r.sell_volume)).color(theme::text_3())));
                    ui.add_sized([80.0, 0.0], egui::Label::new(egui::RichText::new(r.current_price.as_deref().unwrap_or("-")).monospace()));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.colored_label(if r.floating_pnl >= 0.0 { theme::up() } else { theme::down() }, format!("{:+.2}", r.floating_pnl));
                    });
                });
                ui.add_space(4.0);
            }
        });
        if nav_to_positions {
            self.screen = Screen::Positions;
            self.ensure_loaded(ui.ctx(), Screen::Positions);
        }
    }

    fn render_dashboard_risk_watch_card(&mut self, ui: &mut egui::Ui) {
        let watch: Vec<&MarginRow> = self.margin.iter().filter(|m| m.margin_level.is_some()).take(4).collect();
        let stop_out_levels: Vec<f64> = self.margin.iter().map(|m| m.stop_out_level).collect();
        let mut nav_to_risk = false;
        theme::card(14).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.strong("Risk watch");
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.link("All accounts \u{2192}").clicked() {
                        nav_to_risk = true;
                    }
                });
            });
            ui.add_space(10.0);
            if watch.is_empty() {
                ui.weak("No accounts with open positions.");
            } else {
                for m in &watch {
                    let level = m.margin_level.unwrap_or(0.0);
                    let (status, color) = if level <= m.margin_call_level {
                        ("Margin call", theme::danger())
                    } else if level <= m.margin_call_level * 1.5 {
                        ("Watch", theme::warning())
                    } else {
                        ("OK", theme::up())
                    };
                    ui.horizontal(|ui| {
                        ui.label(egui::RichText::new(format!("{} \u{b7} {}", m.account_full_name, m.account_number)).strong());
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.vertical(|ui| {
                                ui.colored_label(color, format!("{level:.0}%"));
                                ui.label(egui::RichText::new("margin level").size(10.0).color(theme::text_3()));
                            });
                        });
                    });
                    ui.label(egui::RichText::new(format!("Equity ${} \u{b7} Margin ${}", m.equity, m.used_margin)).size(11.0).color(theme::text_3()));
                    let frac = (level / 300.0).clamp(0.02, 1.0) as f32;
                    let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 6.0), egui::Sense::hover());
                    ui.painter().rect_filled(rect, egui::CornerRadius::same(3), theme::border());
                    let filled = egui::Rect::from_min_size(rect.min, egui::vec2(rect.width() * frac, rect.height()));
                    ui.painter().rect_filled(filled, egui::CornerRadius::same(3), color);
                    if status != "OK" {
                        ui.add_space(2.0);
                        ui.colored_label(color, status);
                    }
                    ui.add_space(10.0);
                }
            }
            ui.separator();
            // Honest replacement for the design mockup's "Stop-out level
            // enforced by engine: Yes * 50%" pill -- see this fn's own
            // doc comment for the Part 0.4 finding this corrects.
            let uniform_stop_out = stop_out_levels.first().filter(|first| stop_out_levels.iter().all(|v| v == *first));
            let stop_out_text = match uniform_stop_out {
                Some(level) => format!("Stop-out auto-enforced at {level:.0}% \u{b7} checked every 1 min"),
                None => "Stop-out auto-enforced per group's configured level \u{b7} checked every 1 min".to_string(),
            };
            ui.label(egui::RichText::new(stop_out_text).size(11.0).color(theme::up()));
        });
        if nav_to_risk {
            self.screen = Screen::Risk;
            self.ensure_loaded(ui.ctx(), Screen::Risk);
        }
    }

    fn render_dashboard_activity_card(&mut self, ui: &mut egui::Ui, activity: &[ActivityRow], today: &str) {
        theme::card(14).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.strong("Activity");
            });
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                for (i, label) in ["All", "Trades", "Money", "Admin", "System"].iter().enumerate() {
                    let selected = self.dashboard_activity_tab == i;
                    let text = if selected { egui::RichText::new(*label).color(theme::accent()).strong() } else { egui::RichText::new(*label).color(theme::text_3()) };
                    if ui.selectable_label(selected, text).clicked() {
                        self.dashboard_activity_tab = i;
                    }
                }
            });
            ui.add_space(8.0);
            let filtered: Vec<&ActivityRow> = activity
                .iter()
                .filter(|a| match self.dashboard_activity_tab {
                    1 => dashboard_activity_category(a) == "Trades",
                    2 => dashboard_activity_category(a) == "Money",
                    3 => dashboard_activity_category(a) == "Admin",
                    4 => dashboard_activity_category(a) == "System",
                    _ => true,
                })
                .collect();
            if filtered.is_empty() {
                ui.weak("No activity in this category.");
                return;
            }
            let mut last_date: Option<&str> = None;
            let yesterday = date_days_ago(1);
            for row in &filtered {
                let date = row.created_at_label.get(0..10).unwrap_or("");
                if last_date != Some(date) {
                    last_date = Some(date);
                    ui.add_space(6.0);
                    let label = if date == today {
                        "Today".to_string()
                    } else if date == yesterday {
                        "Yesterday".to_string()
                    } else {
                        date.to_string()
                    };
                    ui.label(egui::RichText::new(label.to_uppercase()).size(10.5).color(theme::text_3()));
                    ui.add_space(3.0);
                }
                ui.horizontal(|ui| {
                    let dot_color = match dashboard_activity_category(row) {
                        "Trades" => theme::up(),
                        "Money" => theme::warning(),
                        "System" => theme::text_3(),
                        _ => theme::blue(),
                    };
                    let (rect, _) = ui.allocate_exact_size(egui::vec2(6.0, 6.0), egui::Sense::hover());
                    ui.painter().circle_filled(rect.center(), 3.0, dot_color);
                    ui.vertical(|ui| {
                        ui.label(egui::RichText::new(&row.action_label).color(theme::text_1()).strong());
                        ui.label(egui::RichText::new(&row.actor_email).size(11.0).color(theme::text_3()));
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.label(egui::RichText::new(row.created_at_label.get(11..16).unwrap_or("")).size(11.0).color(theme::text_3()));
                    });
                });
                ui.add_space(6.0);
            }
            ui.separator();
            if ui.link("View full audit log \u{2192}").clicked() {
                self.screen = Screen::Audit;
                self.ensure_loaded(ui.ctx(), Screen::Audit);
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
            if self.positions_loading {
                ui.spinner();
                ui.label("Loading...");
            }
            ui.weak(format!("{} open positions", self.positions.len()));
        });
        ui.add_space(8.0);

        if let Some(err) = &self.positions_error {
            ui.colored_label(theme::danger(), err);
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
                        theme::up()
                    } else if total_floating_pnl < 0.0 {
                        theme::down()
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
                            ui.label(egui::RichText::new(label.to_uppercase()).size(11.0).color(theme::text_3()));
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
                                theme::danger()
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
                                theme::danger()
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
                            ui.label(egui::RichText::new(label.to_uppercase()).size(11.0).color(theme::text_3()));
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
                            let color = if p.side == "BUY" { theme::accent() } else { theme::danger() };
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
                                Some(v) if v < 0.0 => theme::danger(),
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
                        ui.colored_label(theme::danger(), err);
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
                ui.colored_label(theme::danger(), err);
            } else if self.live_activity.is_empty() {
                ui.weak("No activity yet.");
            } else {
                egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| {
                    render_activity_feed_rows(ui, &self.live_activity, true);
                });
            }
        });
    }

    // Direct native port of app/manage/(shell)/accounts/AccountsManager.tsx
    // -- search, "Add account" (full form, not just name/email/password/
    // mode), a maker-checker "Pending balance adjustments" queue, the
    // full 13-column table (Account [+mirrored/custom-pricing badges],
    // Mode, Type, Country, KYC, Group, Leverage, Balance, Credit, Status,
    // Max daily loss, Swap-free, Action), and the Adjust-balance modal.
    // Not ported: the per-account drill-down detail page
    // (accounts/[id]/ClientActivityView.tsx) -- this screen is the list
    // only, same as every other native screen's own disclosed table-
    // chrome gaps (resize/virtualize/column-visibility/bulk-select).
    fn render_accounts(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button(if self.show_new_account_form { "Cancel" } else { "+ New account" }).clicked() {
                self.show_new_account_form = !self.show_new_account_form;
                if self.show_new_account_form {
                    self.new_account = NewAccountForm { currency: "USD".to_string(), initial_balance: "0".to_string(), ..Default::default() };
                    self.created_account = None;
                }
            }
            ui.add(egui::TextEdit::singleline(&mut self.accounts_filter).hint_text("Search by name, email, or account #..."));
            if self.accounts_loading {
                ui.spinner();
            }
        });
        ui.label(
            egui::RichText::new(format!(
                "{} account{}.{}",
                self.accounts.len(),
                if self.accounts.len() == 1 { "" } else { "s" },
                if !self.can_manage_finance {
                    " Leverage/status/balance changes, including a starting balance on a new account, require Broker Admin or the Account Finance permission."
                } else {
                    ""
                }
            ))
            .size(11.5)
            .color(theme::text_3()),
        );
        ui.add_space(8.0);

        if self.show_new_account_form {
            theme::card(14).show(ui, |ui| {
                if let Some((account_number, password)) = self.created_account.clone() {
                    ui.label("Account created. This password is shown once, copy it now, it can't be retrieved again afterward.");
                    ui.add_space(6.0);
                    theme::card(10).show(ui, |ui| {
                        ui.monospace(format!("Account: {account_number}"));
                        ui.monospace(format!("Password: {password}"));
                    });
                    ui.add_space(8.0);
                    if ui.button("Done").clicked() {
                        self.show_new_account_form = false;
                        self.created_account = None;
                    }
                } else {
                    ui.label("Full name");
                    ui.text_edit_singleline(&mut self.new_account.full_name);
                    ui.label("Email");
                    ui.text_edit_singleline(&mut self.new_account.email);
                    ui.label("Password");
                    ui.add(egui::TextEdit::singleline(&mut self.new_account.password).password(true));
                    ui.horizontal(|ui| {
                        ui.selectable_value(&mut self.new_account.is_live, false, "Demo");
                        ui.selectable_value(&mut self.new_account.is_live, true, "Live");
                    });
                    if !self.account_types.is_empty() {
                        ui.label("Account type");
                        egui::ComboBox::from_id_salt("new-account-type")
                            .selected_text(
                                self.account_types
                                    .iter()
                                    .find(|t| t.id == self.new_account.account_type_id)
                                    .map(|t| t.name.clone())
                                    .unwrap_or_else(|| "Select...".to_string()),
                            )
                            .show_ui(ui, |ui| {
                                for t in self.account_types.iter().filter(|t| t.enabled) {
                                    ui.selectable_value(&mut self.new_account.account_type_id, t.id.clone(), &t.name);
                                }
                            });
                    }
                    ui.label("Currency");
                    ui.text_edit_singleline(&mut self.new_account.currency);
                    ui.label("Group (blank = ungrouped)");
                    egui::ComboBox::from_id_salt("new-account-group")
                        .selected_text(
                            self.groups
                                .iter()
                                .find(|g| g.id == self.new_account.group_id)
                                .map(|g| g.name.clone())
                                .unwrap_or_else(|| "Ungrouped".to_string()),
                        )
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut self.new_account.group_id, String::new(), "Ungrouped");
                            for g in &self.groups {
                                ui.selectable_value(&mut self.new_account.group_id, g.id.clone(), &g.name);
                            }
                        });
                    if self.can_manage_finance {
                        if self.new_account.group_id.is_empty() {
                            ui.label("Leverage (e.g. 100)");
                            ui.text_edit_singleline(&mut self.new_account.leverage);
                        }
                        ui.label("Starting balance");
                        ui.text_edit_singleline(&mut self.new_account.initial_balance);
                    }
                    ui.label("Country");
                    ui.text_edit_singleline(&mut self.new_account.country);
                    ui.label("Phone");
                    ui.text_edit_singleline(&mut self.new_account.phone);
                    ui.label("Date of birth (YYYY-MM-DD)");
                    ui.text_edit_singleline(&mut self.new_account.date_of_birth);
                    ui.add_space(8.0);

                    let needs_type = self.account_types.iter().any(|t| t.enabled) && self.new_account.account_type_id.is_empty();
                    let needs_leverage = self.can_manage_finance && self.new_account.group_id.is_empty() && self.new_account.leverage.trim().is_empty();
                    let valid = !self.new_account.full_name.trim().is_empty()
                        && self.new_account.email.contains('@')
                        && self.new_account.password.len() >= 8
                        && !needs_type
                        && !needs_leverage;
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
                                    account_type_id: if self.new_account.account_type_id.is_empty() { None } else { Some(self.new_account.account_type_id.clone()) },
                                    currency: if self.new_account.currency.trim().is_empty() { "USD".to_string() } else { self.new_account.currency.trim().to_string() },
                                    group_id: if self.new_account.group_id.is_empty() { None } else { Some(self.new_account.group_id.clone()) },
                                    leverage: if self.new_account.group_id.is_empty() { self.new_account.leverage.trim().parse::<f64>().ok() } else { None },
                                    initial_balance: if self.new_account.initial_balance.trim().is_empty() { "0".to_string() } else { self.new_account.initial_balance.trim().to_string() },
                                    country: if self.new_account.country.trim().is_empty() { None } else { Some(self.new_account.country.trim().to_string()) },
                                    phone: if self.new_account.phone.trim().is_empty() { None } else { Some(self.new_account.phone.trim().to_string()) },
                                    date_of_birth: if self.new_account.date_of_birth.trim().is_empty() { None } else { Some(self.new_account.date_of_birth.trim().to_string()) },
                                },
                            );
                        }
                    }
                    if needs_leverage {
                        ui.weak("Enter a leverage.");
                    } else if self.new_account.password.len() < 8 {
                        ui.weak("Password must be at least 8 characters.");
                    }
                }
            });
            ui.add_space(10.0);
        }

        if let Some(err) = &self.accounts_error {
            ui.colored_label(theme::danger(), err);
            return;
        }

        // --- Pending balance adjustments (maker-checker) ---
        if !self.pending_adjustments.is_empty() {
            theme::card(12).show(ui, |ui| {
                ui.strong(format!("Pending balance adjustments ({})", self.pending_adjustments.len()));
                ui.add_space(6.0);
                let mut decide: Option<(String, &'static str)> = None;
                for req in self.pending_adjustments.clone() {
                    let amount: f64 = req.amount.parse().unwrap_or(0.0);
                    ui.horizontal(|ui| {
                        let tone = if amount >= 0.0 { theme::accent() } else { theme::danger() };
                        ui.colored_label(tone, if amount >= 0.0 { "Credit" } else { "Debit" });
                        ui.monospace(format!("{}{}", if amount >= 0.0 { "+" } else { "" }, req.amount));
                        ui.vertical(|ui| {
                            ui.label(format!("{}, {} (balance {})", req.account.account_number, req.account.full_name, req.account.balance));
                            ui.weak(format!("Requested by {} \u{b7} {} \u{b7} \"{}\"", req.requested_by_name, req.created_at, req.note));
                            if let Some(err) = self.pending_adjustment_errors.get(&req.id) {
                                ui.colored_label(theme::danger(), err);
                            }
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            let busy = self.reviewing_adjustment_id.as_deref() == Some(req.id.as_str());
                            if theme::accent_button_enabled(ui, !busy, if busy { "Working..." } else { "Approve" }).clicked() {
                                decide = Some((req.id.clone(), "approve"));
                            }
                            if ui.add_enabled(!busy, egui::Button::new("Reject")).clicked() {
                                decide = Some((req.id.clone(), "reject"));
                            }
                        });
                    });
                    ui.separator();
                }
                if let Some((id, decision)) = decide {
                    self.reviewing_adjustment_id = Some(id.clone());
                    if let Some(api) = &self.api {
                        api.review_pending_adjustment(ctx.clone(), self.tx.clone(), id, decision.to_string());
                    }
                }
            });
            ui.add_space(10.0);
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
        let mut pending_group_change: Option<(String, String)> = None;
        let mut pending_type_change: Option<(String, String)> = None;
        let mut open_adjust: Option<AdjustBalance> = None;

        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(60.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(80.0))
            .column(Column::auto().at_least(80.0))
            .column(Column::auto().at_least(130.0))
            .column(Column::auto().at_least(70.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(100.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(80.0))
            .column(Column::remainder().at_least(130.0))
            .header(26.0, |mut header| {
                for label in ["Account", "Mode", "Type", "Country", "KYC", "Group", "Leverage", "Balance", "Credit", "Status", "Max daily loss", "Swap-free", "Action"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(10.5).color(theme::text_3()));
                    });
                }
            })
            .body(|body| {
                body.rows(30.0, visible_indices.len(), |mut row| {
                    let a = &self.accounts[visible_indices[row.index()]];
                    row.col(|ui| {
                        ui.vertical(|ui| {
                            ui.monospace(&a.account_number);
                            ui.weak(format!("{}, {}", a.full_name, a.email));
                            if let Some(m) = &a.mirror {
                                ui.colored_label(theme::accent(), format!("Mirrored: {} \u{d7}{}", if m.direction == "REVERSE" { "Reverse" } else { "Same" }, m.multiplier));
                            }
                            if a.has_custom_pricing {
                                ui.colored_label(theme::warning(), "Custom pricing");
                            }
                        });
                    });
                    row.col(|ui| {
                        ui.label(&a.account_mode);
                    });
                    row.col(|ui| {
                        let current = a.account_type_name.clone().unwrap_or_else(|| "-".to_string());
                        egui::ComboBox::from_id_salt(format!("acct-type-{}", a.id)).selected_text(current).show_ui(ui, |ui| {
                            for t in self.account_types.iter().filter(|t| t.enabled || Some(&t.id) == a.account_type_id.as_ref()) {
                                if ui.selectable_label(a.account_type_id.as_deref() == Some(t.id.as_str()), &t.name).clicked() {
                                    pending_type_change = Some((a.id.clone(), t.id.clone()));
                                }
                            }
                        });
                    });
                    row.col(|ui| {
                        ui.weak(a.country.as_deref().unwrap_or("-"));
                    });
                    row.col(|ui| match a.kyc_status.as_deref() {
                        Some("APPROVED") => {
                            ui.colored_label(theme::accent(), "APPROVED");
                        }
                        Some("REJECTED") => {
                            ui.colored_label(theme::danger(), "REJECTED");
                        }
                        Some(s) => {
                            ui.colored_label(theme::warning(), s);
                        }
                        None => {
                            ui.weak("NO KYC");
                        }
                    });
                    row.col(|ui| {
                        let current = a.group_name.clone().unwrap_or_else(|| "Ungrouped".to_string());
                        egui::ComboBox::from_id_salt(format!("acct-group-{}", a.id)).selected_text(current).show_ui(ui, |ui| {
                            if ui.selectable_label(a.group_id.is_none(), "Ungrouped").clicked() {
                                pending_group_change = Some((a.id.clone(), String::new()));
                            }
                            for g in &self.groups {
                                if ui.selectable_label(a.group_id.as_deref() == Some(g.id.as_str()), &g.name).clicked() {
                                    pending_group_change = Some((a.id.clone(), g.id.clone()));
                                }
                            }
                        });
                    });
                    row.col(|ui| {
                        ui.monospace(format!("1:{}", a.leverage));
                    });
                    row.col(|ui| {
                        ui.monospace(format!("{} {}", a.currency, a.balance));
                    });
                    row.col(|ui| {
                        ui.monospace(&a.credit);
                    });
                    row.col(|ui| {
                        let color = match a.status.as_str() {
                            "ACTIVE" => theme::accent(),
                            "SUSPENDED" => theme::warning(),
                            _ => theme::text_3(),
                        };
                        ui.colored_label(color, &a.status);
                    });
                    row.col(|ui| {
                        ui.monospace(a.max_daily_loss.as_deref().unwrap_or("-"));
                    });
                    row.col(|ui| {
                        ui.label(match a.swap_free {
                            Some(true) => "Free",
                            Some(false) => "Charged",
                            None => "Inherit",
                        });
                    });
                    row.col(|ui| {
                        if self.can_manage_finance {
                            if ui.small_button("Adjust").clicked() {
                                open_adjust = Some(AdjustBalance { account_id: a.id.clone(), account_number: a.account_number.clone(), is_credit: true, amount: String::new(), note: String::new(), error: None });
                            }
                            let next_status = if a.status == "ACTIVE" { "SUSPENDED" } else { "ACTIVE" };
                            let action_label = if a.status == "ACTIVE" { "Suspend" } else { "Reactivate" };
                            if a.status != "CLOSED" && ui.small_button(action_label).clicked() {
                                pending_status_change = Some((a.id.clone(), next_status.to_string()));
                            }
                        }
                    });
                });
            });

        if let Some(target) = open_adjust {
            self.adjust_target = Some(target);
        }
        if let Some((account_id, status)) = pending_status_change {
            if let Some(api) = &self.api {
                api.set_account_status(ctx.clone(), self.tx.clone(), account_id, status);
            }
        }
        if let Some((account_id, group_id)) = pending_group_change {
            if let Some(api) = &self.api {
                let value = if group_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(group_id) };
                api.patch_account(ctx.clone(), self.tx.clone(), account_id, serde_json::json!({ "groupId": value }), "account moved to a new group".to_string());
            }
        }
        if let Some((account_id, type_id)) = pending_type_change {
            if let Some(api) = &self.api {
                api.patch_account(ctx.clone(), self.tx.clone(), account_id, serde_json::json!({ "accountTypeId": type_id }), "account type updated".to_string());
            }
        }

        // --- Adjust balance modal ---
        if let Some(mut adjust) = self.adjust_target.take() {
            let mut open = true;
            let mut submit = false;
            egui::Window::new(format!("Adjust balance - {}", adjust.account_number))
                .id(egui::Id::new("adjust-balance-window"))
                .collapsible(false)
                .resizable(false)
                .open(&mut open)
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.selectable_value(&mut adjust.is_credit, true, "Credit (add funds)");
                        ui.selectable_value(&mut adjust.is_credit, false, "Debit (remove funds)");
                    });
                    ui.label("Amount (USD)");
                    ui.add(egui::TextEdit::singleline(&mut adjust.amount).hint_text("0.00"));
                    ui.label("Reason (required, logged in audit trail)");
                    ui.text_edit_multiline(&mut adjust.note);
                    if let Some(err) = &adjust.error {
                        ui.colored_label(theme::danger(), err);
                    }
                    ui.add_space(6.0);
                    if theme::accent_button(ui, "Apply adjustment").clicked() {
                        submit = true;
                    }
                });
            if submit {
                let magnitude: Option<f64> = adjust.amount.trim().parse().ok();
                if magnitude.is_none_or(|m| m <= 0.0) {
                    adjust.error = Some("Enter a valid amount".to_string());
                    self.adjust_target = Some(adjust);
                } else if adjust.note.trim().is_empty() {
                    adjust.error = Some("Reason is required for the audit trail".to_string());
                    self.adjust_target = Some(adjust);
                } else if let Some(api) = &self.api {
                    let signed = if adjust.is_credit { magnitude.unwrap() } else { -magnitude.unwrap() };
                    api.adjust_balance(ctx.clone(), self.tx.clone(), adjust.account_id.clone(), signed, adjust.note.trim().to_string());
                }
            } else if open {
                self.adjust_target = Some(adjust);
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
            if self.dealing_loading || self.dealing_desk_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        // --- Dealer ON/OFF toggle ---
        if let Some(state) = &self.dealer_toggle {
            let dealer_on = state.dealer_on;
            let bg = if dealer_on { theme::bg_1() } else { theme::warning().gamma_multiply(0.12) };
            egui::Frame::new()
                .fill(bg)
                .stroke(egui::Stroke::new(1.0_f32, if dealer_on { theme::border() } else { theme::warning() }))
                .corner_radius(egui::CornerRadius::same(10))
                .inner_margin(egui::Margin::symmetric(16, 12))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let switch_color = if dealer_on { theme::accent() } else { theme::text_3() };
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
        } else if let Some(err) = &self.dealer_toggle_error {
            ui.weak(permission_error_message(err, "RISK_SETTINGS"));
            ui.add_space(10.0);
        }

        if let Some(err) = &self.dealing_error {
            ui.colored_label(theme::danger(), err);
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
                        let side_color = if order.side == "BUY" { theme::accent() } else { theme::danger() };
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
                            ui.colored_label(theme::danger(), err);
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
                    let side_color = if row.side == "BUY" { theme::accent() } else { theme::danger() };
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
                ui.colored_label(theme::danger(), err);
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
                                ui.label(egui::RichText::new(label.to_uppercase()).size(11.0).color(theme::text_3()));
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
                                let color = if r.side == "BUY" { theme::accent() } else { theme::danger() };
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

    // Direct native port of GroupsManager.tsx + its own
    // SymbolPricingEditor.tsx mount: the group list (name, leverage,
    // margin call %, stop out %, max lot, restriction, routing badge,
    // swap-free, default) and, drilled into a group, the full 5-field
    // per-symbol pricing editor (spread markup OR target total spread
    // pips -- mutually exclusive, expressed as a mode toggle --
    // commission/lot, swap long, swap short, each with its own "inherits:
    // X" hint when blank). Not ported (disclosed, not silent): the
    // Create/Edit group modal itself (name/leverage/margin levels/
    // restriction/routing-type selector/force-dealing choice) and group
    // delete -- this pass is the list + pricing tab only.
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
            ui.add_space(8.0);

            if let Some(err) = &self.group_pricing_error {
                ui.colored_label(theme::danger(), err);
                return;
            }

            let mut save_target: Option<(String, PricingEditRow)> = None;

            TableBuilder::new(ui)
                .striped(true)
                .resizable(true)
                .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
                .column(Column::exact(90.0))
                .column(Column::exact(80.0))
                .column(Column::exact(150.0))
                .column(Column::exact(140.0))
                .column(Column::exact(110.0))
                .column(Column::exact(110.0))
                .column(Column::exact(90.0))
                .column(Column::remainder().at_least(70.0))
                .header(26.0, |mut header| {
                    for label in ["Symbol", "Mode", "Spread / Target", "Commission / lot", "Swap long", "Swap short", "Override?", "Action"] {
                        header.col(|ui| {
                            ui.label(egui::RichText::new(label.to_uppercase()).size(10.5).color(theme::text_3()));
                        });
                    }
                })
                .body(|body| {
                    body.rows(30.0, self.group_pricing.len(), |mut row| {
                        let p = &self.group_pricing[row.index()];
                        let edit = self.pricing_edit_buffer.entry(p.symbol_id.clone()).or_insert_with(|| PricingEditRow {
                            is_target_mode: p.target_total_spread_pips.is_some(),
                            spread_markup: p.spread_markup.clone().unwrap_or_default(),
                            target_total_spread_pips: p.target_total_spread_pips.clone().unwrap_or_default(),
                            commission_per_lot: p.commission_per_lot.clone().unwrap_or_default(),
                            swap_long: p.swap_long.clone().unwrap_or_default(),
                            swap_short: p.swap_short.clone().unwrap_or_default(),
                        });
                        row.col(|ui| {
                            ui.monospace(&p.symbol_name);
                        });
                        row.col(|ui| {
                            egui::ComboBox::from_id_salt(format!("pricing-mode-{}", p.symbol_id))
                                .selected_text(if edit.is_target_mode { "Target" } else { "Markup" })
                                .show_ui(ui, |ui| {
                                    ui.selectable_value(&mut edit.is_target_mode, false, "Markup");
                                    ui.selectable_value(&mut edit.is_target_mode, true, "Target");
                                });
                        });
                        row.col(|ui| {
                            if edit.is_target_mode {
                                ui.add(egui::TextEdit::singleline(&mut edit.target_total_spread_pips).hint_text(
                                    p.default_spread_markup.as_deref().map(|d| format!("inherits: {d}")).unwrap_or_else(|| "inherit".to_string()),
                                ));
                            } else {
                                ui.add(egui::TextEdit::singleline(&mut edit.spread_markup).hint_text(
                                    p.default_spread_markup.as_deref().map(|d| format!("inherits: {d}")).unwrap_or_else(|| "inherit".to_string()),
                                ));
                            }
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.commission_per_lot).hint_text(
                                p.default_commission_per_lot.as_deref().map(|d| format!("inherits: {d}")).unwrap_or_else(|| "inherit".to_string()),
                            ));
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.swap_long).hint_text(
                                p.default_swap_long.as_deref().map(|d| format!("inherits: {d}")).unwrap_or_else(|| "inherit".to_string()),
                            ));
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.swap_short).hint_text(
                                p.default_swap_short.as_deref().map(|d| format!("inherits: {d}")).unwrap_or_else(|| "inherit".to_string()),
                            ));
                        });
                        row.col(|ui| {
                            if p.has_override {
                                ui.colored_label(theme::accent(), "custom");
                            } else {
                                ui.weak("default");
                            }
                        });
                        row.col(|ui| {
                            if theme::accent_button(ui, "Save").clicked() {
                                save_target = Some((p.symbol_id.clone(), edit.clone()));
                            }
                        });
                    });
                });

            if let Some((symbol_id, edit)) = save_target {
                if let Some(api) = &self.api {
                    api.update_group_pricing(
                        ctx.clone(),
                        self.tx.clone(),
                        group.id.clone(),
                        symbol_id,
                        if edit.is_target_mode { "target" } else { "markup" }.to_string(),
                        edit.spread_markup,
                        edit.target_total_spread_pips,
                        edit.commission_per_lot,
                        edit.swap_long,
                        edit.swap_short,
                    );
                }
            }
            return;
        }

        ui.horizontal(|ui| {
            if self.groups_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.groups_error {
            ui.colored_label(theme::danger(), err);
            return;
        }

        let mut open_group: Option<GroupRow> = None;
        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::remainder().at_least(140.0))
            .column(Column::auto().at_least(80.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(80.0))
            .column(Column::auto().at_least(70.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(150.0))
            .column(Column::auto().at_least(70.0))
            .column(Column::auto().at_least(60.0))
            .column(Column::auto().at_least(120.0))
            .header(26.0, |mut header| {
                for label in ["Name", "Leverage", "Margin call %", "Stop out %", "Max lot", "Restriction", "Routing", "Swap-free", "Default", "Action"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(10.0).color(theme::text_3()));
                    });
                }
            })
            .body(|body| {
                body.rows(28.0, self.groups.len(), |mut row| {
                    let g = &self.groups[row.index()];
                    row.col(|ui| {
                        ui.label(&g.name);
                    });
                    row.col(|ui| {
                        ui.monospace(format!("1:{}", g.leverage));
                    });
                    row.col(|ui| {
                        ui.monospace(&g.margin_call_level);
                    });
                    row.col(|ui| {
                        ui.monospace(&g.stop_out_level);
                    });
                    row.col(|ui| {
                        ui.monospace(if g.max_lot_size.is_empty() { "-" } else { &g.max_lot_size });
                    });
                    row.col(|ui| {
                        ui.label(match g.trading_restriction.as_str() {
                            "BUY_ONLY" => "Buy only",
                            "SELL_ONLY" => "Sell only",
                            _ => "Both",
                        });
                    });
                    row.col(|ui| {
                        // routingBadge() in GroupsManager.tsx: LP -> A-Book,
                        // groupType!=DEMO && dealingMode==AUTO -> B-Book
                        // Auto, else Dealing (Reverse if a mirror rule
                        // sources from this group).
                        let (label, color) = if g.group_type == "LP" {
                            ("A-Book (LP)", theme::accent())
                        } else if g.group_type != "DEMO" && g.dealing_mode == "AUTO" {
                            ("B-Book (Auto)", theme::warning())
                        } else if g.has_mirror_rule {
                            ("Reverse (Mirror)", theme::warning())
                        } else {
                            ("Dealing", theme::accent())
                        };
                        let suffix = if g.dealing_mode == "MANUAL" { " \u{b7} Force" } else { "" };
                        ui.colored_label(color, format!("{label}{suffix}"));
                    });
                    row.col(|ui| {
                        ui.label(match g.swap_free {
                            Some(true) => "\u{2713}",
                            Some(false) => "\u{2717}",
                            None => "-",
                        });
                    });
                    row.col(|ui| {
                        ui.label(if g.is_default { "\u{2713}" } else { "-" });
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

    // Direct native port of app/manage/(shell)/kyc/KycRequestsManager.tsx
    // -- identity document submissions (KycRecord), separate model/route
    // from Client KYC's own suitability-questionnaire flow below. Table:
    // Account, Document type, Documents (Front/Back -- fetched through
    // this app's own session and shown in-app, since an OS-browser link
    // can't carry this app's cookie jar), Status, Submitted, Action.
    fn render_kyc(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if let Some(err) = &self.kyc_error {
            ui.colored_label(theme::danger(), permission_error_message(err, "KYC_REVIEW"));
            return;
        }

        ui.horizontal(|ui| {
            if self.kyc_loading {
                ui.spinner();
            }
            ui.weak(format!("{} KYC submissions", self.kyc.len()));
        });
        ui.add_space(8.0);

        let mut approve_id: Option<String> = None;
        let mut confirm_reject: Option<(String, String)> = None;
        let mut view_document: Option<(String, &'static str)> = None;

        for record in self.kyc.clone() {
            theme::card(10).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.monospace(&record.account_number);
                        ui.weak(format!(
                            "{}{}{}",
                            record.account_full_name,
                            record.account_country.as_deref().map(|c| format!(", {c}")).unwrap_or_default(),
                            record.account_phone.as_deref().map(|p| format!(", {p}")).unwrap_or_default()
                        ));
                    });
                    ui.monospace(&record.document_type);
                    if ui.small_button("Front").clicked() {
                        view_document = Some((record.id.clone(), "front"));
                    }
                    if ui.small_button("Back").clicked() {
                        view_document = Some((record.id.clone(), "back"));
                    }
                    let status_color = match record.status.as_str() {
                        "APPROVED" => theme::accent(),
                        "REJECTED" => theme::danger(),
                        _ => theme::warning(),
                    };
                    ui.colored_label(status_color, &record.status);
                    if record.status == "REJECTED" {
                        if let Some(reason) = &record.rejection_reason {
                            ui.weak(reason);
                        }
                    }
                    ui.weak(record.created_at.get(0..10).unwrap_or(&record.created_at));
                    if record.status == "PENDING" {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if theme::accent_button(ui, "Approve").clicked() {
                                approve_id = Some(record.id.clone());
                            }
                            if ui.button("Reject").clicked() {
                                self.kyc_docs_reject = Some(PendingReject { id: record.id.clone(), reason: String::new() });
                            }
                        });
                    }
                });
                if self.kyc_docs_reject.as_ref().is_some_and(|p| p.id == record.id) {
                    let mut pending = self.kyc_docs_reject.take().unwrap();
                    let mut cancelled = false;
                    ui.horizontal(|ui| {
                        ui.label("Reason (required, shown to the client):");
                        ui.text_edit_singleline(&mut pending.reason);
                        if theme::danger_button_enabled(ui, !pending.reason.trim().is_empty(), "Reject submission").clicked() {
                            confirm_reject = Some((pending.id.clone(), pending.reason.clone()));
                        }
                        if ui.button("Cancel").clicked() {
                            cancelled = true;
                        }
                    });
                    if !cancelled && confirm_reject.is_none() {
                        self.kyc_docs_reject = Some(pending);
                    }
                }
            });
        }
        if self.kyc.is_empty() && !self.kyc_loading {
            ui.weak("No KYC submissions.");
        }

        if let Some(id) = approve_id {
            if let Some(api) = &self.api {
                api.kyc_action(ctx.clone(), self.tx.clone(), id, "APPROVE".to_string(), None);
            }
        }
        if let Some((id, reason)) = confirm_reject {
            if let Some(api) = &self.api {
                api.kyc_action(ctx.clone(), self.tx.clone(), id, "REJECT".to_string(), Some(reason));
            }
        }
        if let Some((id, side)) = view_document {
            self.kyc_document = None;
            self.kyc_document_error = None;
            self.kyc_document_loading = true;
            if let Some(api) = &self.api {
                api.fetch_kyc_document(ctx.clone(), self.tx.clone(), id, side.to_string());
            }
        }

        if self.kyc_document_loading || self.kyc_document.is_some() || self.kyc_document_error.is_some() {
            let mut open = true;
            egui::Window::new("KYC document").id(egui::Id::new("kyc-document-window")).collapsible(false).open(&mut open).show(ctx, |ui| {
                if self.kyc_document_loading {
                    ui.spinner();
                    ui.label("Loading document...");
                } else if let Some(err) = &self.kyc_document_error {
                    ui.colored_label(theme::danger(), err);
                } else if let Some(texture) = &self.kyc_document {
                    ui.add(egui::Image::new(texture).max_width(560.0).max_height(560.0));
                }
            });
            if !open {
                self.kyc_document = None;
                self.kyc_document_error = None;
            }
        }
    }

    fn render_client_kyc(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.client_kyc_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.client_kyc_error {
            ui.colored_label(theme::danger(), permission_error_message(err, "KYC_REVIEW"));
            return;
        }

        let mut approve_id: Option<String> = None;
        let mut confirm_reject: Option<(String, String)> = None;
        let mut toggle_expand: Option<String> = None;

        for record in self.client_kyc.clone() {
            theme::card(10).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.label(&record.client_full_name);
                        ui.weak(format!(
                            "{}{}{}",
                            record.client_email,
                            record.client_country.as_deref().map(|c| format!(", {c}")).unwrap_or_default(),
                            record.client_phone.as_deref().map(|p| format!(", {p}")).unwrap_or_default()
                        ));
                    });
                    ui.monospace(&record.document_type);
                    if record.has_address_proof {
                        ui.weak("+address proof");
                    }
                    ui.weak(record.created_at.get(0..10).unwrap_or(&record.created_at));
                    let status_color = match record.status.as_str() {
                        "APPROVED" => theme::accent(),
                        "REJECTED" => theme::danger(),
                        _ => theme::warning(),
                    };
                    ui.colored_label(status_color, &record.status);
                    if record.status == "REJECTED" {
                        if let Some(reason) = &record.rejection_reason {
                            ui.weak(reason);
                        }
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if record.status == "PENDING" {
                            if theme::accent_button(ui, "Approve").clicked() {
                                approve_id = Some(record.id.clone());
                            }
                            if ui.button("Reject").clicked() {
                                self.kyc_reject = Some(PendingReject { id: record.id.clone(), reason: String::new() });
                            }
                        }
                        let expanded = self.client_kyc_expanded.contains(&record.id);
                        if ui.button(if expanded { "Hide suitability" } else { "View suitability" }).clicked() {
                            toggle_expand = Some(record.id.clone());
                        }
                    });
                });
                if self.client_kyc_expanded.contains(&record.id) {
                    ui.add_space(6.0);
                    ui.separator();
                    egui::Grid::new(format!("suitability-{}", record.id)).num_columns(2).spacing([16.0, 4.0]).show(ui, |ui| {
                        ui.weak("Annual income");
                        ui.label(record.annual_income.as_deref().unwrap_or("-"));
                        ui.end_row();
                        ui.weak("Source of funds");
                        ui.label(record.source_of_funds.as_deref().unwrap_or("-"));
                        ui.end_row();
                        ui.weak("Trading experience");
                        ui.label(record.trading_experience.as_deref().unwrap_or("-"));
                        ui.end_row();
                        ui.weak("Employment status");
                        ui.label(record.employment_status.as_deref().unwrap_or("-"));
                        ui.end_row();
                        ui.weak("Risk tolerance");
                        ui.label(record.risk_tolerance.as_deref().unwrap_or("-"));
                        ui.end_row();
                    });
                }
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
        if let Some(id) = toggle_expand {
            if !self.client_kyc_expanded.remove(&id) {
                self.client_kyc_expanded.insert(id);
            }
        }
    }

    fn render_live_account_requests(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.live_account_requests_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.live_account_requests_error {
            ui.colored_label(theme::danger(), permission_error_message(err, "KYC_REVIEW"));
            return;
        }

        let mut approve_id: Option<String> = None;
        let mut confirm_reject: Option<(String, String)> = None;

        for req in self.live_account_requests.clone() {
            theme::card(10).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.label(&req.client_full_name);
                        ui.weak(format!(
                            "{}{}{}",
                            req.client_email,
                            req.client_country.as_deref().map(|c| format!(", {c}")).unwrap_or_default(),
                            req.client_phone.as_deref().map(|p| format!(", {p}")).unwrap_or_default()
                        ));
                    });
                    ui.monospace(req.account_type_name.as_deref().unwrap_or("-"));
                    ui.weak(req.created_at.get(0..10).unwrap_or(&req.created_at));
                    ui.vertical(|ui| {
                        let status_color = match req.status.as_str() {
                            "APPROVED" => theme::accent(),
                            "REJECTED" => theme::danger(),
                            _ => theme::warning(),
                        };
                        ui.colored_label(status_color, &req.status);
                        if req.status == "REJECTED" {
                            if let Some(reason) = &req.rejection_reason {
                                ui.weak(reason);
                            }
                        }
                        if req.status == "APPROVED" {
                            if let Some(acc) = &req.created_account_number {
                                ui.monospace(acc);
                            }
                        }
                    });
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

    // Direct native port of app/manage/(shell)/notifications/
    // NotificationsManager.tsx -- unread-count-in-label "Mark all read"
    // (shown only when there's something to mark), per-row card
    // (accent-highlighted while unread), type badge + title + body +
    // timestamp, and per-row actions: "Reset password" for
    // PASSWORD_RESET_REQUESTED (opens a modal, generates + shows a new
    // password once), "View" for every other type with a real
    // SECTION_FOR_TYPE mapping (jumps to that screen AND marks read), and
    // a plain "Mark read" otherwise.
    fn render_notifications(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let unread_count = self.notifications.iter().filter(|n| !n.read).count();
        ui.horizontal(|ui| {
            if self.notifications_loading {
                ui.spinner();
            }
            if unread_count > 0 {
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button(format!("Mark all read ({unread_count})")).clicked() {
                        if let Some(api) = &self.api {
                            api.mark_all_notifications_read(ctx.clone(), self.tx.clone());
                        }
                    }
                });
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.notifications_error {
            ui.colored_label(theme::danger(), err);
            return;
        }

        if self.notifications.is_empty() && !self.notifications_loading {
            ui.weak("No notifications yet.");
        }

        let mut mark_read: Option<String> = None;
        let mut navigate: Option<(String, Screen)> = None;
        let mut open_reset: Option<NotificationRow> = None;

        egui::ScrollArea::vertical().show(ui, |ui| {
            for n in self.notifications.clone() {
                let (fill, stroke) = if n.read { (theme::bg_1(), theme::border()) } else { (theme::accent().linear_multiply(0.10), theme::accent()) };
                egui::Frame::new()
                    .fill(fill)
                    .stroke(egui::Stroke::new(1.0_f32, stroke))
                    .corner_radius(egui::CornerRadius::same(8))
                    .inner_margin(egui::Margin::symmetric(14, 10))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.vertical(|ui| {
                                ui.horizontal(|ui| {
                                    let badge_color = if n.read { theme::text_3() } else { theme::accent() };
                                    ui.colored_label(badge_color, n.notif_type.replace('_', " "));
                                    ui.strong(&n.title);
                                });
                                ui.label(egui::RichText::new(&n.body).color(theme::text_2()));
                                ui.label(egui::RichText::new(&n.created_at).size(11.0).color(theme::text_3()));
                            });
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if !n.read && ui.button("Mark read").clicked() {
                                    mark_read = Some(n.id.clone());
                                }
                                if n.notif_type == "PASSWORD_RESET_REQUESTED" && n.entity_id.is_some() {
                                    if theme::accent_button(ui, "Reset password").clicked() {
                                        open_reset = Some(n.clone());
                                    }
                                } else if let Some(screen) = section_for_notification_type(&n.notif_type) {
                                    if theme::accent_button(ui, "View").clicked() {
                                        navigate = Some((n.id.clone(), screen));
                                    }
                                }
                            });
                        });
                    });
                ui.add_space(6.0);
            }
        });

        if let Some(id) = mark_read {
            if let Some(api) = &self.api {
                api.mark_notification_read(ctx.clone(), self.tx.clone(), id);
            }
        }
        if let Some((id, screen)) = navigate {
            if let Some(api) = &self.api {
                api.mark_notification_read(ctx.clone(), self.tx.clone(), id);
            }
            self.screen = screen;
            self.ensure_loaded(ctx, screen);
        }
        if let Some(row) = open_reset {
            self.reset_password_target = Some(row);
            self.reset_password_result = None;
            self.reset_password_error = None;
        }

        // --- Reset trader password modal ---
        if let Some(target) = self.reset_password_target.clone() {
            let mut open = true;
            let mut confirm = false;
            let mut done = false;
            egui::Window::new("Reset trader password").id(egui::Id::new("reset-password-window")).collapsible(false).resizable(false).open(&mut open).show(ctx, |ui| {
                if let Some(password) = &self.reset_password_result {
                    ui.colored_label(theme::accent(), "Password reset. Share this with the trader now, it will not be shown again.");
                    ui.add_space(6.0);
                    theme::card(10).show(ui, |ui| {
                        ui.monospace(password);
                    });
                    ui.add_space(8.0);
                    if ui.button("Done").clicked() {
                        done = true;
                    }
                } else {
                    ui.label("Generates a new random password for this account and shows it once. The trader will need to be told the new password directly (phone, secure channel); it isn't emailed automatically.");
                    if let Some(err) = &self.reset_password_error {
                        ui.colored_label(theme::danger(), err);
                    }
                    ui.add_space(8.0);
                    ui.horizontal(|ui| {
                        let label = if self.reset_password_busy { "Working..." } else { "Generate new password" };
                        if theme::accent_button_enabled(ui, !self.reset_password_busy, label).clicked() {
                            confirm = true;
                        }
                    });
                }
            });
            if confirm {
                self.reset_password_busy = true;
                self.reset_password_error = None;
                if let Some(entity_id) = &target.entity_id {
                    if let Some(api) = &self.api {
                        api.reset_trader_password(ctx.clone(), self.tx.clone(), entity_id.clone());
                    }
                }
            }
            if done {
                if let Some(api) = &self.api {
                    api.mark_notification_read(ctx.clone(), self.tx.clone(), target.id.clone());
                }
                self.reset_password_target = None;
                self.fetch(ctx, Screen::Notifications);
            } else if !open {
                self.reset_password_target = None;
            }
        }
    }

    fn render_risk_radar(&mut self, ui: &mut egui::Ui, _ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.risk_radar_loading {
                ui.spinner();
            }
            ui.weak("Behavioral risk flags over the last 30 days, computed server-side (up to 5 min stale).");
        });
        ui.add_space(8.0);

        if let Some(err) = &self.risk_radar_error {
            ui.colored_label(theme::danger(), err);
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
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::text_3()));
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
                            theme::danger()
                        } else {
                            ui.visuals().text_color()
                        };
                        ui.colored_label(color, format!("${:.2}", r.profit_velocity_per_day));
                    });
                    row.col(|ui| {
                        ui.horizontal(|ui| {
                            if r.scalp_flag {
                                ui.colored_label(theme::warning(), "SCALP");
                            }
                            if r.martingale_flag {
                                ui.colored_label(theme::danger(), "MARTINGALE");
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
            if self.settings_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        if let Some(err) = &self.settings_error {
            ui.colored_label(theme::danger(), err);
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
            if self.reports_loading {
                ui.spinner();
            }
            ui.weak("Last 30 days, live accounts only.");
        });
        ui.add_space(10.0);
        if let Some(err) = &self.reports_error {
            ui.colored_label(theme::danger(), err);
            return;
        }
        let Some(r) = &self.reports else { return };
        egui::Grid::new("reports-stats").num_columns(4).spacing([10.0, 10.0]).show(ui, |ui| {
            stat_card(ui, "Trading volume (lots)", &format!("{:.2}", r.trading_volume));
            stat_card(ui, "Commission revenue", &format!("${:.2}", r.commission_revenue));
            stat_card(ui, "Net deposits", &format!("${:.2}", r.net_deposits));
            stat_card(ui, "New clients", &r.new_clients.to_string());
        });

        ui.add_space(20.0);
        ui.strong("Export");
        ui.weak("Saves the CSV straight to your Downloads folder (this app has no browser to click a download link in).");
        ui.add_space(6.0);
        let mut download: Option<&'static str> = None;
        ui.horizontal_wrapped(|ui| {
            for (label, kind) in [
                ("Trading report (CSV)", "trading"),
                ("Financial report (CSV)", "financial"),
                ("Client report (CSV)", "client"),
                ("IB report (CSV)", "ib"),
                ("Risk report (CSV)", "risk"),
                ("LP report (CSV)", "lp"),
            ] {
                if ui.button(label).clicked() {
                    download = Some(kind);
                }
            }
        });
        if let Some(kind) = download {
            if let Some(api) = &self.api {
                api.download_report_csv(ctx.clone(), self.tx.clone(), kind.to_string());
            }
        }
        if let Some(msg) = &self.action_message {
            ui.add_space(6.0);
            ui.colored_label(theme::accent(), msg);
        }
    }

    // Direct native port of SymbolConfigTable.tsx -- fully editable now
    // (was read-only): enabled, trading mode, default book type, and all
    // 8 numeric fields (spread markup, min/max lot, lot step, swap long/
    // short, commission/lot, max exposure), each row with its own Save,
    // plus a Sessions button opening the trading-windows modal. Not
    // ported: the omni-search "?symbol=" scroll-to-and-highlight
    // deep-link (this app has no comparable global search yet).
    fn render_symbols(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if self.symbols_loading {
            ui.spinner();
        }
        if let Some(err) = &self.symbols_error {
            ui.colored_label(theme::danger(), err);
            return;
        }

        let mut save_target: Option<api::SymbolConfigEdit> = None;
        let mut open_sessions: Option<SymbolConfigRow> = None;

        egui::ScrollArea::horizontal().show(ui, |ui| {
            TableBuilder::new(ui)
                .striped(true)
                .resizable(true)
                .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
                .column(Column::exact(110.0))
                .column(Column::exact(60.0))
                .column(Column::exact(100.0))
                .column(Column::exact(80.0))
                .column(Column::exact(90.0))
                .column(Column::exact(70.0))
                .column(Column::exact(70.0))
                .column(Column::exact(70.0))
                .column(Column::exact(80.0))
                .column(Column::exact(80.0))
                .column(Column::exact(90.0))
                .column(Column::exact(90.0))
                .column(Column::remainder().at_least(160.0))
                .header(26.0, |mut header| {
                    for label in ["Symbol", "Enabled", "Trading mode", "Book", "Spread markup", "Min lot", "Max lot", "Lot step", "Swap long", "Swap short", "Commission/lot", "Max exposure", "Action"] {
                        header.col(|ui| {
                            ui.label(egui::RichText::new(label.to_uppercase()).size(9.5).color(theme::text_3()));
                        });
                    }
                })
                .body(|body| {
                    body.rows(30.0, self.symbols.len(), |mut row| {
                        let s = &self.symbols[row.index()];
                        let edit = self.symbol_edit.entry(s.symbol_id.clone()).or_insert_with(|| api::SymbolConfigEdit {
                            symbol_id: s.symbol_id.clone(),
                            enabled: s.enabled,
                            trading_mode: s.trading_mode.clone(),
                            default_book_type: s.default_book_type.clone(),
                            spread_markup: s.spread_markup.clone(),
                            min_lot: s.min_lot.clone(),
                            max_lot: s.max_lot.clone(),
                            lot_step: s.lot_step.clone(),
                            swap_long: s.swap_long.clone(),
                            swap_short: s.swap_short.clone(),
                            commission_per_lot: s.commission_per_lot.clone(),
                            max_exposure: s.max_exposure.clone().unwrap_or_default(),
                        });
                        row.col(|ui| {
                            ui.vertical(|ui| {
                                ui.monospace(&s.symbol_name);
                                ui.weak(&s.category);
                            });
                        });
                        row.col(|ui| {
                            ui.checkbox(&mut edit.enabled, "");
                        });
                        row.col(|ui| {
                            egui::ComboBox::from_id_salt(format!("sym-mode-{}", s.symbol_id))
                                .selected_text(match edit.trading_mode.as_str() {
                                    "BUY_ONLY" => "Buy only",
                                    "SELL_ONLY" => "Sell only",
                                    _ => "Both",
                                })
                                .show_ui(ui, |ui| {
                                    ui.selectable_value(&mut edit.trading_mode, "BOTH".to_string(), "Both");
                                    ui.selectable_value(&mut edit.trading_mode, "BUY_ONLY".to_string(), "Buy only");
                                    ui.selectable_value(&mut edit.trading_mode, "SELL_ONLY".to_string(), "Sell only");
                                });
                        });
                        row.col(|ui| {
                            egui::ComboBox::from_id_salt(format!("sym-book-{}", s.symbol_id))
                                .selected_text(if edit.default_book_type == "A_BOOK" { "A-Book" } else { "B-Book" })
                                .show_ui(ui, |ui| {
                                    ui.selectable_value(&mut edit.default_book_type, "A_BOOK".to_string(), "A-Book");
                                    ui.selectable_value(&mut edit.default_book_type, "B_BOOK".to_string(), "B-Book");
                                });
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.spread_markup).desired_width(70.0));
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.min_lot).desired_width(60.0));
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.max_lot).desired_width(60.0));
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.lot_step).desired_width(60.0));
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.swap_long).desired_width(70.0));
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.swap_short).desired_width(70.0));
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.commission_per_lot).desired_width(80.0));
                        });
                        row.col(|ui| {
                            ui.add(egui::TextEdit::singleline(&mut edit.max_exposure).hint_text("no limit").desired_width(80.0));
                        });
                        row.col(|ui| {
                            if theme::accent_button(ui, "Save").clicked() {
                                save_target = Some(edit.clone());
                            }
                            let has_broker_symbol = s.broker_symbol_id.is_some();
                            if ui.add_enabled(has_broker_symbol, egui::Button::new("Sessions")).clicked() {
                                open_sessions = Some(s.clone());
                            }
                        });
                    });
                });
        });

        if let Some(edit) = save_target {
            if let Some(api) = &self.api {
                api.save_symbol_config(ctx.clone(), self.tx.clone(), edit);
            }
        }
        if let Some(row) = open_sessions {
            self.symbol_sessions_loading = true;
            self.symbol_sessions_error = None;
            self.symbol_sessions = None;
            if let Some(api) = &self.api {
                if let Some(bsid) = &row.broker_symbol_id {
                    api.fetch_symbol_sessions(ctx.clone(), self.tx.clone(), bsid.clone());
                }
            }
            self.symbol_sessions_for = Some(row);
        }

        // --- Trading sessions modal ---
        if let Some(row) = self.symbol_sessions_for.clone() {
            let mut open = true;
            let mut remove_id: Option<String> = None;
            let mut add_clicked = false;
            egui::Window::new(format!("Trading sessions - {}", row.symbol_name))
                .id(egui::Id::new("symbol-sessions-window"))
                .collapsible(false)
                .open(&mut open)
                .show(ctx, |ui| {
                    ui.set_width(420.0);
                    ui.weak("No sessions = always tradable. All times UTC.");
                    ui.add_space(6.0);
                    if self.symbol_sessions_loading {
                        ui.spinner();
                    } else if let Some(err) = &self.symbol_sessions_error {
                        ui.colored_label(theme::danger(), err);
                    } else if let Some(sessions) = &self.symbol_sessions {
                        if sessions.is_empty() {
                            ui.weak("No sessions set, always tradable.");
                        }
                        const DAY_LABELS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
                        for s in sessions {
                            ui.horizontal(|ui| {
                                ui.monospace(format!("{} {}-{}", DAY_LABELS.get(s.day_of_week as usize).unwrap_or(&"?"), s.open_time, s.close_time));
                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    if ui.button("Remove").clicked() {
                                        remove_id = Some(s.id.clone());
                                    }
                                });
                            });
                        }
                        ui.add_space(8.0);
                        ui.horizontal(|ui| {
                            egui::ComboBox::from_id_salt("sess-new-day")
                                .selected_text(DAY_LABELS[self.symbol_session_new_day as usize])
                                .show_ui(ui, |ui| {
                                    for (i, label) in DAY_LABELS.iter().enumerate() {
                                        ui.selectable_value(&mut self.symbol_session_new_day, i as i64, *label);
                                    }
                                });
                            ui.add(egui::TextEdit::singleline(&mut self.symbol_session_new_open).desired_width(50.0));
                            ui.label("-");
                            ui.add(egui::TextEdit::singleline(&mut self.symbol_session_new_close).desired_width(50.0));
                            if ui.button("Add").clicked() {
                                add_clicked = true;
                            }
                        });
                    }
                });
            if let (Some(bsid), Some(sessions)) = (row.broker_symbol_id.clone(), self.symbol_sessions.clone()) {
                if let Some(id) = remove_id {
                    let next: Vec<api::SymbolSessionRow> = sessions.into_iter().filter(|s| s.id != id).collect();
                    self.symbol_sessions_loading = true;
                    if let Some(api) = &self.api {
                        api.save_symbol_sessions(ctx.clone(), self.tx.clone(), bsid, next);
                    }
                } else if add_clicked {
                    let mut next = sessions;
                    next.push(api::SymbolSessionRow {
                        id: String::new(),
                        day_of_week: self.symbol_session_new_day,
                        open_time: self.symbol_session_new_open.clone(),
                        close_time: self.symbol_session_new_close.clone(),
                    });
                    self.symbol_sessions_loading = true;
                    if let Some(api) = &self.api {
                        api.save_symbol_sessions(ctx.clone(), self.tx.clone(), bsid, next);
                    }
                }
            }
            if !open {
                self.symbol_sessions_for = None;
                self.symbol_sessions = None;
            }
        }
    }

    // Direct native port of TeamManager.tsx -- an "Add a team member"
    // form (email/password/role, with the same SUPPORT-has-no-access
    // warning), and per-row Status toggle plus delegated-permissions
    // checkboxes (MANAGER rows only; BROKER_ADMIN already has
    // everything, matching PERMISSIONS/PERMISSION_LABELS exactly).
    fn render_team(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        if self.admins_loading {
            ui.spinner();
        }
        if let Some(err) = &self.admins_error {
            ui.colored_label(theme::danger(), err);
            return;
        }
        ui.label(egui::RichText::new(format!("{} admin{}.", self.admins.len(), if self.admins.len() == 1 { "" } else { "s" })).size(11.5).color(theme::text_3()));
        ui.add_space(8.0);

        theme::card(14).show(ui, |ui| {
            ui.strong("Add a team member");
            ui.add_space(6.0);
            ui.horizontal_wrapped(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.new_admin_email).hint_text("Email").desired_width(180.0));
                ui.add(egui::TextEdit::singleline(&mut self.new_admin_password).password(true).hint_text("Initial password (min 8 chars)").desired_width(200.0));
                egui::ComboBox::from_id_salt("new-admin-role")
                    .selected_text(if self.new_admin_role.is_empty() { "Select role...".to_string() } else { self.new_admin_role.clone() })
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut self.new_admin_role, "BROKER_ADMIN".to_string(), "Broker Admin");
                        ui.selectable_value(&mut self.new_admin_role, "MANAGER".to_string(), "Manager");
                        ui.selectable_value(&mut self.new_admin_role, "SUPPORT".to_string(), "Support");
                    });
                let valid = self.new_admin_email.contains('@') && self.new_admin_password.len() >= 8 && !self.new_admin_role.is_empty();
                if theme::accent_button_enabled(ui, valid, "Add").clicked() {
                    if let Some(api) = &self.api {
                        api.create_admin(ctx.clone(), self.tx.clone(), self.new_admin_email.trim().to_string(), self.new_admin_password.clone(), self.new_admin_role.clone());
                        self.new_admin_email.clear();
                        self.new_admin_password.clear();
                    }
                }
                if let Some(err) = &self.new_admin_error {
                    ui.colored_label(theme::danger(), err);
                }
            });
            if self.new_admin_role == "SUPPORT" {
                ui.add_space(6.0);
                ui.colored_label(
                    theme::warning(),
                    "No backoffice page currently grants the Support role any access, every page requires Manager or Broker Admin. A Support admin can log in but every page will 403. Pick Manager (and delegate only the permissions they need) until Support has real access wired up.",
                );
            }
        });
        ui.add_space(10.0);

        let mut pending_status: Option<(String, String)> = None;
        let mut pending_permission: Option<(String, Vec<String>)> = None;
        for a in self.admins.clone() {
            let is_self = a.id == self.current_admin_id;
            theme::card(10).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.horizontal(|ui| {
                            ui.label(&a.email);
                            if is_self {
                                ui.weak("(you)");
                            }
                        });
                        ui.colored_label(theme::accent(), &a.role);
                        ui.weak(a.last_login_at.as_deref().unwrap_or("never"));
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let next = if a.status == "ACTIVE" { "DISABLED" } else { "ACTIVE" };
                        let label = if a.status == "ACTIVE" { "Disable" } else { "Activate" };
                        if ui.add_enabled(!is_self, egui::Button::new(label)).on_disabled_hover_text("You cannot change your own status").clicked() {
                            pending_status = Some((a.id.clone(), next.to_string()));
                        }
                        let status_color = if a.status == "ACTIVE" { theme::accent() } else { theme::text_3() };
                        ui.colored_label(status_color, &a.status);
                    });
                });
                if a.role == "MANAGER" {
                    ui.add_space(6.0);
                    ui.separator();
                    ui.add_space(4.0);
                    ui.weak("Delegated permissions:");
                    ui.horizontal_wrapped(|ui| {
                        for (key, label) in api::PERMISSIONS {
                            let mut checked = a.extra_permissions.iter().any(|p| p == key);
                            if ui.checkbox(&mut checked, label).changed() {
                                let next: Vec<String> = if checked {
                                    a.extra_permissions.iter().cloned().chain(std::iter::once(key.to_string())).collect()
                                } else {
                                    a.extra_permissions.iter().filter(|p| p.as_str() != key).cloned().collect()
                                };
                                pending_permission = Some((a.id.clone(), next));
                            }
                        }
                    });
                } else if a.role == "BROKER_ADMIN" {
                    ui.weak("has everything");
                }
            });
        }
        if let Some((id, status)) = pending_status {
            if let Some(api) = &self.api {
                api.set_admin_status(ctx.clone(), self.tx.clone(), id, status);
            }
        }
        if let Some((id, permissions)) = pending_permission {
            if let Some(api) = &self.api {
                api.set_admin_permissions(ctx.clone(), self.tx.clone(), id, permissions);
            }
        }
    }

    fn render_transfers(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.transfers_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);

        // --- Transfer form (was read-only -- POST /api/manage/transfers
        // now actually wired) ---
        let active_accounts: Vec<&AccountRow> = self.accounts.iter().filter(|a| a.status == "ACTIVE").collect();
        theme::card(14).show(ui, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.vertical(|ui| {
                    ui.label(egui::RichText::new("FROM ACCOUNT").size(10.5).color(theme::text_3()));
                    egui::ComboBox::from_id_salt("transfer-from")
                        .selected_text(active_accounts.iter().find(|a| a.id == self.transfer_from_id).map(|a| format!("{}, {}", a.account_number, a.full_name)).unwrap_or_else(|| "Select account".to_string()))
                        .show_ui(ui, |ui| {
                            for a in &active_accounts {
                                ui.selectable_value(&mut self.transfer_from_id, a.id.clone(), format!("{}, {}", a.account_number, a.full_name));
                            }
                        });
                });
                ui.vertical(|ui| {
                    ui.label(egui::RichText::new("TO ACCOUNT").size(10.5).color(theme::text_3()));
                    egui::ComboBox::from_id_salt("transfer-to")
                        .selected_text(active_accounts.iter().find(|a| a.id == self.transfer_to_id).map(|a| format!("{}, {}", a.account_number, a.full_name)).unwrap_or_else(|| "Select account".to_string()))
                        .show_ui(ui, |ui| {
                            for a in &active_accounts {
                                ui.selectable_value(&mut self.transfer_to_id, a.id.clone(), format!("{}, {}", a.account_number, a.full_name));
                            }
                        });
                });
                ui.vertical(|ui| {
                    ui.label(egui::RichText::new("AMOUNT (USD)").size(10.5).color(theme::text_3()));
                    ui.add(egui::TextEdit::singleline(&mut self.transfer_amount).hint_text("0.00").desired_width(100.0));
                });
                ui.vertical(|ui| {
                    ui.label(egui::RichText::new("NOTE (REQUIRED, LOGGED IN AUDIT TRAIL)").size(10.5).color(theme::text_3()));
                    ui.add(egui::TextEdit::singleline(&mut self.transfer_note).hint_text("e.g. Client requested consolidation").desired_width(220.0));
                });
                let valid = !self.transfer_from_id.is_empty() && !self.transfer_to_id.is_empty() && !self.transfer_amount.trim().is_empty();
                if theme::accent_button_enabled(ui, valid, "Transfer").clicked() {
                    if let Some(api) = &self.api {
                        api.create_transfer(ctx.clone(), self.tx.clone(), self.transfer_from_id.clone(), self.transfer_to_id.clone(), self.transfer_amount.trim().to_string(), self.transfer_note.clone());
                    }
                }
            });
        });
        ui.add_space(10.0);

        if let Some(err) = &self.transfers_error {
            ui.colored_label(theme::danger(), err);
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
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::text_3()));
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
    // Direct native port of WalletsManager.tsx: search, a Total
    // balance/Total credit summary line (recomputed from whichever
    // filtered subset is on screen, same as the web), and Account/
    // Currency/Balance/Credit/Status columns (self.accounts is the same
    // /api/manage/accounts data the web's own WalletsManager reuses).
    fn render_wallets(&mut self, ui: &mut egui::Ui, _ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.accounts_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.accounts_error {
            ui.colored_label(theme::danger(), err);
            return;
        }

        let q = self.wallets_filter.to_lowercase();
        let filtered: Vec<&AccountRow> = self
            .accounts
            .iter()
            .filter(|a| q.is_empty() || a.account_number.to_lowercase().contains(&q) || a.full_name.to_lowercase().contains(&q))
            .collect();
        let total_balance: f64 = filtered.iter().filter_map(|a| a.balance.parse::<f64>().ok()).sum();
        let total_credit: f64 = filtered.iter().filter_map(|a| a.credit.parse::<f64>().ok()).sum();

        ui.horizontal(|ui| {
            ui.add(egui::TextEdit::singleline(&mut self.wallets_filter).hint_text("Search by account number or name..."));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                ui.label(
                    egui::RichText::new(format!("Total balance: {total_balance:.2}  \u{b7}  Total credit: {total_credit:.2}"))
                        .size(12.0)
                        .color(theme::text_2()),
                );
            });
        });
        ui.add_space(8.0);

        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(100.0))
            .column(Column::remainder().at_least(160.0))
            .column(Column::auto().at_least(80.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(110.0))
            .column(Column::auto().at_least(100.0))
            .header(28.0, |mut header| {
                for label in ["Account", "Client", "Currency", "Balance", "Credit", "Status"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::text_3()));
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, filtered.len(), |mut row| {
                    let a = filtered[row.index()];
                    row.col(|ui| {
                        ui.monospace(&a.account_number);
                    });
                    row.col(|ui| {
                        ui.label(&a.full_name);
                    });
                    row.col(|ui| {
                        ui.weak(&a.currency);
                    });
                    row.col(|ui| {
                        ui.monospace(&a.balance);
                    });
                    row.col(|ui| {
                        ui.monospace(&a.credit);
                    });
                    row.col(|ui| {
                        let color = match a.status.as_str() {
                            "ACTIVE" => theme::accent(),
                            "SUSPENDED" => theme::warning(),
                            _ => theme::text_3(),
                        };
                        ui.colored_label(color, &a.status);
                    });
                });
            });
    }

    fn render_ib(&mut self, ui: &mut egui::Ui, _ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.ib_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.ib_error {
            ui.colored_label(theme::danger(), err);
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
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::text_3()));
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

    fn render_leads(&mut self, ui: &mut egui::Ui, _ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.leads_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.leads_error {
            ui.colored_label(theme::danger(), err);
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
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::text_3()));
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

    // Direct native port of DealsManager.tsx -- search, VOIDED badge,
    // Open/Commission/Swap columns (were missing entirely), and a real
    // Delete action (soft-delete from the trader's statement, reason
    // required, same maker-checker 202-pending gate as balance
    // adjustments). Not ported: the Replay button (DealingReplayPanel is
    // a tick-by-tick fill replay viewer -- real complexity, low value
    // for a first native pass, deferred).
    // Part 1 adoption: first page migrated from the raw TableBuilder +
    // ad-hoc Window pattern to components::DataTable + ConfirmDialog
    // (PROMPT-backoffice-15-pages.md Part 1). Deliberately not doing every
    // page in this pass -- Part 3 works through the rest one at a time so
    // each gets its own real design-vs-implementation check, not a
    // mechanical find/replace.
    fn render_deals(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.deals_loading {
                ui.spinner();
            }
            ui.label(
                egui::RichText::new(format!("{} closed trade{} (most recent 500).", self.deals.len(), if self.deals.len() == 1 { "" } else { "s" }))
                    .size(11.5)
                    .color(theme::text_3()),
            );
        });
        components::search_field(ui, &mut self.deals_filter, "Search by account number, name, or symbol...");
        ui.add_space(8.0);

        let q = self.deals_filter.to_lowercase();
        let filtered: Vec<&DealRow> = self
            .deals
            .iter()
            .filter(|d| q.is_empty() || d.account_number.to_lowercase().contains(&q) || d.account_full_name.to_lowercase().contains(&q) || d.symbol.to_lowercase().contains(&q))
            .collect();

        let mut delete_target: Option<DealRow> = None;
        let columns = vec![
            components::Column::new("Account", 100.0),
            components::Column::new("Symbol", 80.0),
            components::Column::new("Side", 70.0),
            components::Column::new("Volume", 80.0).right(),
            components::Column::new("Open", 80.0).right(),
            components::Column::new("Close", 80.0).right(),
            components::Column::new("Commission", 80.0).right(),
            components::Column::new("Swap", 70.0).right(),
            components::Column::new("P/L", 90.0).right(),
            components::Column::new("Closed", 140.0),
            components::Column::new("Action", 80.0),
        ];
        let mut table = components::DataTable::new(columns);
        table = if self.deals_loading && self.deals.is_empty() {
            table.loading()
        } else if let Some(err) = &self.deals_error {
            table.error(err, !self.deals.is_empty(), None)
        } else if filtered.is_empty() {
            if self.deals_filter.is_empty() {
                table.empty("No closed trades yet", "Deals appear here once a position closes.")
            } else {
                table.empty("No matches", "Nothing in the last 500 closed trades matches this search.")
            }
        } else {
            table
        };
        let resp = table.show(ui, filtered.len(), |row, idx| {
            let d = filtered[idx];
            row.col(|ui| {
                ui.vertical(|ui| {
                    ui.monospace(&d.account_number);
                    ui.weak(&d.account_full_name);
                });
            });
            row.col(|ui| {
                ui.monospace(&d.symbol);
            });
            row.col(|ui| {
                let color = if d.side == "BUY" { theme::accent() } else { theme::danger() };
                ui.colored_label(color, &d.side);
                if d.status == "VOIDED" {
                    ui.colored_label(theme::warning(), "VOIDED");
                }
            });
            row.col(|ui| {
                ui.monospace(&d.volume);
            });
            row.col(|ui| {
                ui.monospace(&d.open_price);
            });
            row.col(|ui| {
                ui.monospace(&d.close_price);
            });
            row.col(|ui| {
                ui.monospace(&d.commission);
            });
            row.col(|ui| {
                ui.monospace(&d.swap);
            });
            row.col(|ui| {
                let color = match d.realized_pnl.parse::<f64>() {
                    Ok(v) if v > 0.0 => theme::up(),
                    Ok(v) if v < 0.0 => theme::down(),
                    _ => theme::text_2(),
                };
                ui.colored_label(color, &d.realized_pnl);
            });
            row.col(|ui| {
                ui.weak(&d.closed_at);
            });
            row.col(|ui| {
                if ui.add(egui::Button::new(egui::RichText::new("Delete").color(theme::down())).stroke(egui::Stroke::new(1.0_f32, theme::border()))).clicked() {
                    delete_target = Some(d.clone());
                }
            });
        });
        let retry_clicked = resp.retry_clicked;
        let filtered_count = filtered.len();
        let total_count = self.deals.len();
        if !filtered.is_empty() {
            components::table_footer(ui, filtered_count, total_count, Some("Closed"));
        }
        if retry_clicked {
            self.fetch(ctx, Screen::Deals);
        }

        if let Some(d) = delete_target {
            self.deal_delete_confirm = Some((d, String::new(), None));
        }

        if let Some((deal, reason, error)) = self.deal_delete_confirm.clone() {
            let mut new_reason = reason.clone();
            let mut typed = String::new();
            if let Some(err) = &error {
                ui.colored_label(theme::danger(), err);
            }
            let dialog_resp = components::ConfirmDialog::new(
                "deal-delete-window",
                "Confirm delete deal",
                &format!(
                    "Removes {}'s {} {} deal from the trader-visible statement/history entirely. The row itself isn't erased; it's recoverable from the audit log. A reason is required.",
                    deal.account_number, deal.symbol, deal.side
                ),
            )
            .require_reason(true)
            .confirm_label("Confirm delete")
            .show(ctx, &mut new_reason, &mut typed);
            if new_reason != reason {
                self.deal_delete_confirm = Some((deal.clone(), new_reason.clone(), error.clone()));
            }
            if dialog_resp.confirmed {
                if let Some(api) = &self.api {
                    api.delete_deal(ctx.clone(), self.tx.clone(), deal.id.clone(), new_reason.trim().to_string());
                }
            } else if !dialog_resp.still_open {
                self.deal_delete_confirm = None;
            }
        }
    }

    // Direct native port of AuditLogTable.tsx: a search box (account
    // number or order number, matches the real API's own ?q= handling --
    // a Search button here instead of the web's 250ms debounce, since
    // egui has no built-in timer primitive to debounce against), the
    // Order column (symbol/side/lots/order# and the account it belongs
    // to -- dispute-resolution evidence, shown inline rather than behind
    // a click), a click-to-expand diff, and the entityType/entityId
    // target. Not ported: double-click-to-navigate to the changed entity
    // (no in-app deep-linking to an arbitrary record by id yet).
    fn render_audit(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.audit_loading {
                ui.spinner();
            }
        });
        ui.add_space(6.0);
        ui.horizontal(|ui| {
            let response = ui.add(egui::TextEdit::singleline(&mut self.audit_query).hint_text("Search by order number or account number..."));
            let search_clicked = ui.button("Search").clicked();
            if search_clicked || (response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter))) {
                if let Some(api) = &self.api {
                    self.audit_loading = true;
                    api.fetch_audit_log(ctx.clone(), self.tx.clone(), self.audit_query.clone());
                }
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.audit_error {
            ui.colored_label(theme::danger(), err);
            return;
        }
        if self.audit_log.is_empty() && !self.audit_loading {
            ui.weak(if self.audit_query.trim().is_empty() { "No audit entries yet." } else { "No audit entries match that search." });
        }

        let mut toggle_expand: Option<String> = None;
        egui::ScrollArea::vertical().show(ui, |ui| {
            for log in self.audit_log.clone() {
                theme::card(8).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.vertical(|ui| {
                            ui.label(&log.actor_email);
                            ui.horizontal(|ui| {
                                ui.weak(&log.action_label);
                                if !log.diff_lines.is_empty() {
                                    ui.weak(if self.audit_expanded.as_deref() == Some(log.id.as_str()) { "\u{25be}" } else { "\u{25b8}" });
                                }
                            });
                        });
                        ui.vertical(|ui| {
                            if let Some(order) = &log.order {
                                let mut parts = Vec::new();
                                if let Some(s) = &order.symbol {
                                    parts.push(s.clone());
                                }
                                if let Some(s) = &order.side {
                                    parts.push(s.clone());
                                }
                                if let Some(s) = &order.lots {
                                    parts.push(s.clone());
                                }
                                ui.monospace(format!("{} \u{b7} #{}", parts.join(" "), order.order_number.get(order.order_number.len().saturating_sub(8)..).unwrap_or(&order.order_number)));
                                if let Some(acc) = &order.account_number {
                                    ui.weak(acc);
                                }
                            } else {
                                ui.weak("-");
                            }
                        });
                        ui.weak(format!("{} \u{b7} {}", log.entity_type, log.entity_id));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.weak(&log.created_at_label);
                        });
                    });
                    if !log.diff_lines.is_empty() && ui.interact(ui.min_rect(), ui.id().with("row-click"), egui::Sense::click()).clicked() {
                        toggle_expand = Some(log.id.clone());
                    }
                    if self.audit_expanded.as_deref() == Some(log.id.as_str()) {
                        ui.add_space(4.0);
                        ui.separator();
                        for line in &log.diff_lines {
                            ui.monospace(egui::RichText::new(line).size(11.0).color(theme::text_2()));
                        }
                    }
                });
            }
        });
        if let Some(id) = toggle_expand {
            if self.audit_expanded.as_deref() == Some(id.as_str()) {
                self.audit_expanded = None;
            } else {
                self.audit_expanded = Some(id);
            }
        }
    }

    // No dedicated endpoint for this native pass (2FA setup is a QR-code/
    // TOTP flow -- real complexity, deferred) -- shows the signed-in
    // admin's own identity, which is genuinely all this app can offer
    // without a proper enrollment UI. Full 2FA management stays on the
    // web backoffice for now.
    fn render_security(&mut self, ui: &mut egui::Ui) {
        theme::card(16).show(ui, |ui| {
            ui.set_width(360.0);
            ui.label(egui::RichText::new("Signed in as").size(11.0).color(theme::text_3()));
            ui.label(egui::RichText::new(&self.logged_in_email).size(16.0).color(theme::text_1()));
            ui.add_space(10.0);
            ui.weak("Two-factor setup and device management aren't implemented in this native pass yet -- use the web backoffice's Security page for those.");
        });
    }

    // Direct native port of FundsRequestsManager.tsx -- the real
    // two-person withdrawal approval flow: a first admin "Mark for
    // approval" (withdrawals only; deposits Approve immediately), a
    // DIFFERENT admin must "Confirm (2nd approval)" before any balance
    // moves, and the marking admin can "Cancel mark" to back out. Every
    // action goes through the same confirm-modal the web uses, with the
    // web's own exact per-state copy.
    fn render_funds(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.funds_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.funds_error {
            ui.colored_label(theme::danger(), err);
            return;
        }
        if self.funds_requests.is_empty() && !self.funds_loading {
            ui.weak("No funds requests.");
        }

        for f in self.funds_requests.clone() {
            theme::card(10).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.monospace(&f.account_number);
                        ui.weak(&f.account_full_name);
                    });
                    let side_color = if f.request_type == "DEPOSIT" { theme::accent() } else { theme::danger() };
                    ui.colored_label(side_color, &f.request_type);
                    ui.monospace(&f.amount);
                    ui.weak(format!("balance {}", f.current_balance.as_deref().unwrap_or("-")));
                    ui.vertical(|ui| {
                        let status_color = match f.status.as_str() {
                            "COMPLETED" => theme::accent(),
                            "REJECTED" => theme::danger(),
                            _ => theme::warning(),
                        };
                        ui.colored_label(status_color, &f.status);
                        if let Some(marker) = &f.marked_by_admin_email {
                            ui.colored_label(theme::warning(), format!("Marked by {marker}, needs 2nd approval"));
                        }
                    });
                    ui.weak(&f.created_at);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if f.status == "PENDING" {
                            if f.marked_by_admin_id.as_deref() == Some(self.current_admin_id.as_str()) {
                                ui.weak("Awaiting another staff member");
                                if ui.button("Cancel mark").clicked() {
                                    self.funds_confirm = Some((f.clone(), "CANCEL_MARK"));
                                }
                            } else if f.marked_by_admin_id.is_some() {
                                if ui.button("Reject").clicked() {
                                    self.funds_confirm = Some((f.clone(), "REJECT"));
                                }
                                if theme::accent_button(ui, "Confirm (2nd approval)").clicked() {
                                    self.funds_confirm = Some((f.clone(), "APPROVE"));
                                }
                            } else {
                                if theme::danger_button_enabled(ui, true, "Reject").clicked() {
                                    self.funds_confirm = Some((f.clone(), "REJECT"));
                                }
                                let approve_label = if f.request_type == "WITHDRAWAL" { "Mark for approval" } else { "Approve" };
                                if theme::accent_button(ui, approve_label).clicked() {
                                    self.funds_confirm = Some((f.clone(), "APPROVE"));
                                }
                            }
                        }
                    });
                });
            });
        }

        if let Some((row, action)) = self.funds_confirm.clone() {
            let mut open = true;
            let mut confirm = false;
            let is_first_mark = action == "APPROVE" && row.request_type == "WITHDRAWAL" && row.marked_by_admin_id.is_none();
            let title = match action {
                "APPROVE" if is_first_mark => "Mark withdrawal for approval".to_string(),
                "APPROVE" => format!("Approve {}", row.request_type.to_lowercase()),
                "CANCEL_MARK" => "Cancel withdrawal mark".to_string(),
                _ => format!("Reject {}", row.request_type.to_lowercase()),
            };
            egui::Window::new(title).id(egui::Id::new("funds-confirm-window")).collapsible(false).resizable(false).open(&mut open).show(ctx, |ui| {
                let body = match action {
                    "CANCEL_MARK" => "This request goes back to plain pending, either staff member can mark it again.".to_string(),
                    "APPROVE" if is_first_mark => "This only marks the request. A different staff member must confirm before any balance moves.".to_string(),
                    "APPROVE" => format!("This moves {} through the ledger onto {}'s balance.", row.amount, row.account_number),
                    _ => format!("{}'s balance is left untouched.", row.account_number),
                };
                ui.label(body);
                ui.add_space(6.0);
                let btn_label = if action == "CANCEL_MARK" { "Confirm cancel" } else if action == "APPROVE" { "Confirm approval" } else { "Confirm rejection" };
                let clicked = if action == "APPROVE" {
                    ui.add(egui::Button::new(btn_label).fill(theme::accent())).clicked()
                } else if action == "CANCEL_MARK" {
                    ui.button(btn_label).clicked()
                } else {
                    theme::danger_button_enabled(ui, true, btn_label).clicked()
                };
                if clicked {
                    confirm = true;
                }
            });
            if confirm {
                if let Some(api) = &self.api {
                    api.funds_request_action(ctx.clone(), self.tx.clone(), row.id.clone(), action.to_string());
                }
                self.funds_confirm = None;
            } else if !open {
                self.funds_confirm = None;
            }
        }
    }

    // Direct native port of PaymentMethodsManager.tsx -- fully editable
    // now (was read-only): enabled toggle, min/max amount, fee %/fixed,
    // wallet address (crypto types) or a bank-details hint pointing at
    // Instructions, and Instructions, each with its own per-row Save.
    fn render_payment_methods(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.payment_methods_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.payment_methods_error {
            ui.colored_label(theme::danger(), err);
            return;
        }

        let mut save_target: Option<(String, PaymentMethodEdit)> = None;

        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::exact(130.0))
            .column(Column::exact(60.0))
            .column(Column::exact(80.0))
            .column(Column::exact(80.0))
            .column(Column::exact(60.0))
            .column(Column::exact(60.0))
            .column(Column::exact(180.0))
            .column(Column::remainder().at_least(160.0))
            .column(Column::exact(90.0))
            .header(26.0, |mut header| {
                for label in ["Method", "Enabled", "Min", "Max", "Fee %", "Fee fixed", "Wallet / bank", "Instructions", "Action"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(10.0).color(theme::text_3()));
                    });
                }
            })
            .body(|body| {
                body.rows(30.0, self.payment_methods.len(), |mut row| {
                    let m = &self.payment_methods[row.index()];
                    let edit = self.payment_method_edit.entry(m.method_type.clone()).or_insert_with(|| PaymentMethodEdit {
                        enabled: m.enabled,
                        min_amount: m.min_amount.clone(),
                        max_amount: m.max_amount.clone().unwrap_or_default(),
                        fee_percent: m.fee_percent.clone(),
                        fee_fixed: m.fee_fixed.clone(),
                        wallet_address: m.wallet_address.clone().unwrap_or_default(),
                        instructions: m.instructions.clone().unwrap_or_default(),
                    });
                    row.col(|ui| {
                        ui.label(payment_method_label(&m.method_type));
                    });
                    row.col(|ui| {
                        ui.checkbox(&mut edit.enabled, "");
                    });
                    row.col(|ui| {
                        ui.add(egui::TextEdit::singleline(&mut edit.min_amount).desired_width(70.0));
                    });
                    row.col(|ui| {
                        ui.add(egui::TextEdit::singleline(&mut edit.max_amount).hint_text("no limit").desired_width(70.0));
                    });
                    row.col(|ui| {
                        ui.add(egui::TextEdit::singleline(&mut edit.fee_percent).desired_width(50.0));
                    });
                    row.col(|ui| {
                        ui.add(egui::TextEdit::singleline(&mut edit.fee_fixed).desired_width(50.0));
                    });
                    row.col(|ui| {
                        if payment_method_is_crypto(&m.method_type) {
                            ui.add(egui::TextEdit::singleline(&mut edit.wallet_address).hint_text("broker's deposit address").desired_width(170.0));
                        } else {
                            ui.weak("Use Instructions for bank details");
                        }
                    });
                    row.col(|ui| {
                        ui.add(egui::TextEdit::singleline(&mut edit.instructions).hint_text("Shown to the trader").desired_width(150.0));
                    });
                    row.col(|ui| {
                        if theme::accent_button(ui, "Save").clicked() {
                            save_target = Some((m.method_type.clone(), edit.clone()));
                        }
                    });
                });
            });

        if let Some((method_type, edit)) = save_target {
            if let Some(api) = &self.api {
                api.save_payment_method(
                    ctx.clone(),
                    self.tx.clone(),
                    method_type,
                    edit.enabled,
                    edit.min_amount,
                    edit.max_amount,
                    edit.fee_percent,
                    edit.fee_fixed,
                    edit.wallet_address,
                    edit.instructions,
                );
            }
        }
    }

    fn render_margin(&mut self, ui: &mut egui::Ui, _ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.margin_loading {
                ui.spinner();
            }
            ui.weak("Sorted by lowest margin level first.");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.margin_error {
            ui.colored_label(theme::danger(), err);
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
            .column(Column::auto().at_least(100.0))
            .column(Column::remainder().at_least(110.0))
            .header(28.0, |mut header| {
                for label in ["Account", "Positions", "Exposure", "Floating P/L", "Margin level", "Status"] {
                    header.col(|ui| {
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::text_3()));
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
                        ui.monospace(m.margin_level.map(|v| format!("{v:.0}%")).unwrap_or_else(|| "-".to_string()));
                    });
                    row.col(|ui| {
                        // statusFor() in MarginManager.tsx: NO FEED / STOP-OUT
                        // / MARGIN CALL / OK, in that priority order.
                        let (label, color) = match m.margin_level {
                            None => ("NO FEED", theme::text_3()),
                            Some(v) if v < m.stop_out_level => ("STOP-OUT", theme::danger()),
                            Some(v) if v < m.margin_call_level => ("MARGIN CALL", theme::warning()),
                            _ => ("OK", theme::accent()),
                        };
                        ui.colored_label(color, label);
                    });
                });
            });
    }

    fn render_liquidity(&mut self, ui: &mut egui::Ui, _ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.liquidity_loading {
                ui.spinner();
            }
            ui.weak("Open-position book exposure per symbol.");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.liquidity_error {
            ui.colored_label(theme::danger(), err);
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
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::text_3()));
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

    fn render_liquidity_routing(&mut self, ui: &mut egui::Ui, _ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.lp_routing_loading {
                ui.spinner();
            }
            ui.weak("Intended routing, not live routing -- no execution path reads this yet (matches the web page's own note).");
        });
        ui.add_space(8.0);
        if let Some(err) = &self.lp_routing_error {
            ui.colored_label(theme::danger(), err);
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
                        ui.label(egui::RichText::new(label.to_uppercase()).size(11.5).color(theme::text_3()));
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

    fn render_feed_health(&mut self, ui: &mut egui::Ui, _ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.feed_health_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.feed_health_error {
            ui.colored_label(theme::danger(), err);
            return;
        }
        let Some(data) = &self.feed_health else { return };
        ui.horizontal(|ui| {
            ui.label("Trading core feed:");
            if data.feed_stats.is_some() {
                ui.colored_label(theme::accent(), "connected");
            } else {
                ui.colored_label(theme::text_3(), "not reachable");
            }
        });
        ui.horizontal(|ui| {
            ui.label("Gateway:");
            if data.gateway_stats.is_some() {
                ui.colored_label(theme::accent(), "connected");
            } else {
                ui.colored_label(theme::text_3(), "not reachable");
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
            if self.risk_loading {
                ui.spinner();
            }
        });
        ui.add_space(10.0);
        ui.weak("The broker-wide kill switch. Existing open positions are never touched by this -- it only blocks new orders.");
        ui.add_space(10.0);
        if let Some(err) = &self.risk_error {
            ui.colored_label(theme::danger(), err);
            return;
        }
        let Some(risk) = &self.risk else { return };
        theme::card(16).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label("Status:");
                if risk.trading_halted {
                    ui.colored_label(theme::danger(), "TRADING HALTED");
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

    // Direct native port of app/manage/(shell)/risk/RiskSettingsManager.tsx
    // -- broker-wide "Dealing mode" master switch (Broker.dealingModeAt,
    // distinct from the Dealing page's own dealingDeskAutoFillAt toggle),
    // Smart Dealer auto-accept/reject %s (shown only while dealing mode
    // is on), exposure/position limits, and a stat grid derived
    // client-side from the same /api/manage/margin rows the Margin page
    // uses (matches the web's own "avoid a duplicate aggregate route"
    // reasoning).
    fn render_risk_settings(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if self.risk_settings_loading {
                ui.spinner();
            }
        });
        ui.add_space(8.0);
        if let Some(err) = &self.risk_settings_error {
            ui.colored_label(theme::danger(), err);
        }
        let Some(risk) = self.risk_settings.clone() else { return };

        // --- Stat grid (open exposure / floating P&L / open positions /
        // accounts at risk), derived from self.margin exactly like the
        // web derives it from the same GET /api/manage/margin rows. ---
        if !self.margin.is_empty() {
            let total_exposure: f64 = self.margin.iter().filter_map(|m| m.exposure.parse::<f64>().ok()).sum();
            let total_floating_pnl: f64 = self.margin.iter().filter_map(|m| m.floating_pnl.parse::<f64>().ok()).sum();
            let open_positions: i64 = self.margin.iter().map(|m| m.position_count).sum();
            let at_stop_out = self
                .margin
                .iter()
                .filter(|m| m.margin_level.is_some_and(|lvl| lvl < m.stop_out_level))
                .count();
            let at_margin_call = self
                .margin
                .iter()
                .filter(|m| m.margin_level.is_some_and(|lvl| lvl >= m.stop_out_level && lvl < m.margin_call_level))
                .count();
            egui::Grid::new("risk-stats").num_columns(4).spacing([12.0, 8.0]).show(ui, |ui| {
                stat_card(ui, "Open exposure", &format!("{total_exposure:.2} lots"));
                stat_card(ui, "Floating P&L", &format!("{}{:.2}", if total_floating_pnl >= 0.0 { "+" } else { "" }, total_floating_pnl));
                stat_card(ui, "Open positions", &open_positions.to_string());
                stat_card(ui, "Accounts at risk", &(at_margin_call + at_stop_out).to_string());
                ui.end_row();
            });
            ui.label(
                egui::RichText::new(format!(
                    "{at_stop_out} account{} below stop-out, {at_margin_call} below margin call. Stop-out is enforced automatically; this is a live snapshot, not a manual queue. Full list on Margin.",
                    if at_stop_out == 1 { "" } else { "s" }
                ))
                .size(11.5)
                .color(theme::text_3()),
            );
            ui.add_space(12.0);
        }

        // --- Dealing mode ---
        theme::card(14).show(ui, |ui| {
            ui.horizontal(|ui| {
                if risk.dealing_mode {
                    ui.colored_label(theme::accent(), "DEALING MODE ON");
                } else {
                    ui.colored_label(theme::text_3(), "Instant execution");
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    let label = if risk.dealing_mode { "Turn off" } else { "Turn on" };
                    let clicked = if risk.dealing_mode {
                        theme::danger_button_enabled(ui, true, label).clicked()
                    } else {
                        theme::accent_button(ui, label).clicked()
                    };
                    if clicked {
                        self.risk_settings_confirm_dealing = true;
                    }
                });
            });
            ui.label(
                egui::RichText::new(if risk.dealing_mode {
                    "New MARKET orders wait for manual Accept/Reject in the Dealing queue instead of filling instantly."
                } else {
                    "New MARKET orders fill instantly, as normal. Limit/Stop orders also fill instantly once triggered."
                })
                .size(12.0)
                .color(theme::text_3()),
            );

            if risk.dealing_mode {
                ui.add_space(10.0);
                ui.separator();
                ui.add_space(6.0);
                ui.label("Smart Dealer: auto-decide an order the moment it's submitted, before it ever reaches a human. Blank = fully manual (today's behavior).");
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.label(egui::RichText::new("AUTO-ACCEPT WITHIN (%)").size(10.5).color(theme::text_3()));
                        ui.add(egui::TextEdit::singleline(&mut self.risk_smart_accept_input).hint_text("off").desired_width(90.0));
                    });
                    ui.vertical(|ui| {
                        ui.label(egui::RichText::new("AUTO-REJECT BEYOND (%)").size(10.5).color(theme::text_3()));
                        ui.add(egui::TextEdit::singleline(&mut self.risk_smart_reject_input).hint_text("off").desired_width(90.0));
                    });
                    if ui.button("Save").clicked() {
                        if let Some(api) = &self.api {
                            let accept = if self.risk_smart_accept_input.trim().is_empty() { None } else { Some(self.risk_smart_accept_input.trim().to_string()) };
                            let reject = if self.risk_smart_reject_input.trim().is_empty() { None } else { Some(self.risk_smart_reject_input.trim().to_string()) };
                            api.save_smart_dealer(ctx.clone(), self.tx.clone(), accept, reject);
                            self.risk_smart_saved = true;
                        }
                    }
                    if self.risk_smart_saved {
                        ui.colored_label(theme::accent(), "Saved");
                    }
                });
            }
        });

        if self.risk_settings_confirm_dealing {
            let mut open = true;
            let mut confirm = false;
            let title = if risk.dealing_mode { "Confirm turn off dealing mode" } else { "Confirm turn on dealing mode" };
            egui::Window::new(title).id(egui::Id::new("confirm-dealing-mode")).collapsible(false).resizable(false).open(&mut open).show(ctx, |ui| {
                ui.label(if risk.dealing_mode {
                    "New MARKET orders will fill instantly again immediately."
                } else {
                    "New MARKET orders will queue for manual Accept/Reject in the Dealing queue until turned off. Limit/Stop orders queue the same way once their trigger price is hit."
                });
                ui.add_space(6.0);
                let btn_label = if self.risk_settings_dealing_busy { "Working..." } else if risk.dealing_mode { "Confirm: turn off" } else { "Confirm: turn on" };
                if theme::danger_button_enabled(ui, !self.risk_settings_dealing_busy, btn_label).clicked() {
                    confirm = true;
                }
            });
            if confirm {
                self.risk_settings_confirm_dealing = false;
                self.risk_settings_dealing_busy = true;
                if let Some(api) = &self.api {
                    api.set_dealing_mode(ctx.clone(), self.tx.clone(), !risk.dealing_mode);
                }
            } else if !open {
                self.risk_settings_confirm_dealing = false;
            }
        }

        ui.add_space(12.0);

        // --- Exposure & position limits ---
        theme::card(14).show(ui, |ui| {
            ui.strong("Exposure & position limits");
            ui.add_space(8.0);
            ui.label(egui::RichText::new("TOTAL BROKER EXPOSURE LIMIT (LOTS, BLANK = NO LIMIT)").size(10.5).color(theme::text_3()));
            ui.add(egui::TextEdit::singleline(&mut self.risk_exposure_limit_input).hint_text("no limit").desired_width(200.0));
            ui.add_space(8.0);
            ui.label(egui::RichText::new("MAX OPEN POSITIONS PER ACCOUNT (BLANK = NO LIMIT)").size(10.5).color(theme::text_3()));
            ui.add(egui::TextEdit::singleline(&mut self.risk_max_positions_input).hint_text("no limit").desired_width(200.0));
            ui.add_space(10.0);
            ui.horizontal(|ui| {
                if theme::accent_button(ui, "Save").clicked() {
                    if let Some(api) = &self.api {
                        let limit = if self.risk_exposure_limit_input.trim().is_empty() { None } else { Some(self.risk_exposure_limit_input.trim().to_string()) };
                        let max_positions = if self.risk_max_positions_input.trim().is_empty() { None } else { self.risk_max_positions_input.trim().parse::<i64>().ok() };
                        api.save_risk_limits(ctx.clone(), self.tx.clone(), limit, max_positions);
                        self.risk_limits_saved = true;
                    }
                }
                if self.risk_limits_saved {
                    ui.colored_label(theme::accent(), "Saved");
                }
            });
        });
    }
}

// Broker.primaryColor's own stored format (see BrokersManager.tsx's own
// "#f4551c"-style placeholder) -- "#rrggbb" or bare "rrggbb", both seen
// in real broker rows this session.
// Which screen a notification's type should jump to -- matches
// NotificationsManager.tsx's own SECTION_FOR_TYPE map exactly.
fn section_for_notification_type(notif_type: &str) -> Option<Screen> {
    match notif_type {
        "DEALING_ORDER_PENDING" | "DEALER_ACTIVITY" => Some(Screen::Dealing),
        "KYC_SUBMITTED" => Some(Screen::Kyc),
        "NEW_LEAD" => Some(Screen::Leads),
        "FUNDS_REQUEST" => Some(Screen::Funds),
        _ => None,
    }
}

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
        .fill(theme::bg_1())
        .stroke(egui::Stroke::new(1.0_f32, theme::border()))
        .corner_radius(egui::CornerRadius::same(10))
        .inner_margin(egui::Margin::symmetric(16, 14))
        .show(ui, |ui| {
            ui.set_min_width(180.0);
            ui.vertical(|ui| {
                ui.label(egui::RichText::new(label.to_uppercase()).size(11.0).color(theme::text_3()));
                ui.add_space(6.0);
                ui.label(egui::RichText::new(value).size(24.0).color(theme::text_1()));
            });
        });
}

// A row of stat cards that actually spans the panel's full width (no
// leftover empty space on the right), unlike a plain egui::Grid whose
// columns only ever shrink-to-fit their content. Columns = card count,
// each card's width computed from the real available width right
// before drawing, so it holds at any window size (wraps to a second row
// only if the window is too narrow for one card at its minimum width).
fn responsive_stat_row(ui: &mut egui::Ui, stats: &[(&str, String, Option<(String, egui::Color32)>)]) {
    const GAP: f32 = 12.0;
    const MIN_CARD_WIDTH: f32 = 200.0;
    let available = ui.available_width();
    let max_cols = ((available + GAP) / (MIN_CARD_WIDTH + GAP)).floor().max(1.0) as usize;
    let cols = max_cols.min(stats.len()).max(1);

    let old_spacing = ui.spacing().item_spacing.x;
    ui.spacing_mut().item_spacing.x = GAP;
    for chunk in stats.chunks(cols) {
        // ui::columns splits the CURRENT available width into exactly
        // `cols` equal columns and hands back that many child Uis --
        // safer than hand-computing pixel widths (an earlier
        // allocate_ui-based version visibly overflowed the window's
        // right edge instead of respecting the sidebar's own reserved
        // width). A short final chunk still allocates `cols` columns so
        // its cards line up under the ones above rather than stretching
        // to fill the row alone.
        ui.columns(cols, |columns| {
            for (i, col) in columns.iter_mut().enumerate() {
                let Some((label, value, delta)) = chunk.get(i) else { continue };
                egui::Frame::new()
                    .fill(theme::bg_1())
                    .stroke(egui::Stroke::new(1.0_f32, theme::border()))
                    .corner_radius(egui::CornerRadius::same(10))
                    .inner_margin(egui::Margin::symmetric(16, 14))
                    .show(col, |ui| {
                        ui.vertical(|ui| {
                            ui.label(egui::RichText::new(label.to_uppercase()).size(11.0).color(theme::text_3()));
                            ui.add_space(6.0);
                            ui.label(egui::RichText::new(value.as_str()).size(24.0).color(theme::text_1()));
                            if let Some((text, color)) = delta {
                                ui.add_space(3.0);
                                ui.label(egui::RichText::new(text).size(11.0).color(*color));
                            } else {
                                ui.add_space(ui.text_style_height(&egui::TextStyle::Small) + 3.0);
                            }
                        });
                    });
            }
        });
        ui.add_space(GAP);
    }
    ui.spacing_mut().item_spacing.x = old_spacing;
}

// Days-since-epoch -> (year, month, day), UTC. Howard Hinnant's
// civil_from_days algorithm (public domain, chrono-equivalent, used
// instead of pulling in the chrono crate for one field -- same tradeoff
// chrono_like_utc_now already makes for the header clock).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

// "YYYY-MM-DD" for `days` days before today (UTC) -- lexicographically
// comparable against DealRow/ActivityRow's own "YYYY-MM-DD HH:MM:SS"
// labels, so Dashboard's 7d/14d windowing is plain string comparison.
fn date_days_ago(days: i64) -> String {
    let now_secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let epoch_days = now_secs / 86400 - days;
    let (y, m, d) = civil_from_days(epoch_days);
    format!("{y:04}-{m:02}-{d:02}")
}

// Dashboard's Activity card has no server-side category (ActivityRow's
// entityType is the closest real signal available) -- a disclosed
// heuristic, not an authoritative classification.
fn dashboard_activity_category(row: &ActivityRow) -> &'static str {
    if row.actor_email == "system" {
        return "System";
    }
    match row.entity_type.as_str() {
        "Position" | "Order" | "Deal" => "Trades",
        "Transaction" | "BalanceAdjustment" | "Wallet" => "Money",
        _ => "Admin",
    }
}

// One of Dashboard's four attention cards (Margin calls / Withdrawals /
// KYC pending / Live account requests) -- returns true when clicked
// anywhere on the card, so the caller navigates.
fn dashboard_attention_card(ui: &mut egui::Ui, count: &str, title: &str, subtitle: &str, action_label: &str, active: bool) -> bool {
    let mut clicked = false;
    egui::Frame::new()
        .fill(theme::bg_1())
        .stroke(egui::Stroke::new(1.0_f32, if active { theme::warning().gamma_multiply(0.5) } else { theme::border() }))
        .corner_radius(egui::CornerRadius::same(10))
        .inner_margin(egui::Margin::symmetric(16, 14))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(count).font(theme::heading_font(22.0)).color(if active { theme::warning() } else { theme::text_3() }));
                ui.vertical(|ui| {
                    ui.label(egui::RichText::new(title).color(theme::text_1()).strong());
                    ui.label(egui::RichText::new(subtitle).size(11.0).color(theme::text_3()));
                });
            });
            ui.add_space(6.0);
            if ui.link(format!("{action_label} \u{2192}")).clicked() {
                clicked = true;
            }
        });
    clicked
}

fn dashboard_mini_stat(ui: &mut egui::Ui, label: &str, value: &str) {
    egui::Frame::new()
        .fill(theme::bg_2())
        .corner_radius(egui::CornerRadius::same(8))
        .inner_margin(egui::Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.vertical(|ui| {
                ui.label(egui::RichText::new(label).size(10.5).color(theme::text_3()));
                ui.label(egui::RichText::new(value).size(15.0).color(theme::text_1()).strong());
            });
        });
}

// Hand-drawn dual-series bar chart (deposits vs withdrawals, last 7
// days) -- no plotting crate in this binary's dependencies, and 7 fixed
// bars is well within what's reasonable to paint directly.
fn dashboard_bar_chart(ui: &mut egui::Ui, buckets: &[DayBucket]) {
    if buckets.is_empty() {
        ui.weak("No deposit/withdrawal activity in the last 7 days.");
        return;
    }
    let max_value = buckets.iter().flat_map(|b| [b.deposits, b.withdrawals]).fold(1.0_f64, f64::max);
    let chart_height = 160.0_f32;
    let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), chart_height + 22.0), egui::Sense::hover());
    let painter = ui.painter();
    let n = buckets.len() as f32;
    let group_w = rect.width() / n;
    let bar_w = (group_w * 0.28).min(22.0);
    for (i, b) in buckets.iter().enumerate() {
        let cx = rect.left() + group_w * (i as f32 + 0.5);
        let dep_h = (b.deposits / max_value) as f32 * chart_height;
        let wd_h = (b.withdrawals / max_value) as f32 * chart_height;
        let base_y = rect.top() + chart_height;
        let dep_rect = egui::Rect::from_min_size(egui::pos2(cx - bar_w - 2.0, base_y - dep_h), egui::vec2(bar_w, dep_h));
        let wd_rect = egui::Rect::from_min_size(egui::pos2(cx + 2.0, base_y - wd_h), egui::vec2(bar_w, wd_h));
        painter.rect_filled(dep_rect, egui::CornerRadius::same(2), theme::accent());
        painter.rect_filled(wd_rect, egui::CornerRadius::same(2), theme::text_3());
        let label = b.date.get(5..10).unwrap_or(&b.date); // "MM-DD"
        painter.text(egui::pos2(cx, base_y + 14.0), egui::Align2::CENTER_CENTER, label, egui::FontId::proportional(10.5), theme::text_3());
    }
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
        "ORDER_MODIFIED" | "ORDER_TRIGGERED" => theme::warning(),
        "ORDER_CANCELLED" => theme::danger(),
        "POSITION_OPENED" => theme::accent(),
        _ => theme::text_3(),
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
            ui.label(egui::RichText::new(&row.at).size(11.0).color(theme::text_3()));
            ui.add_space(6.0);
            ui.monospace(egui::RichText::new(&row.account_number).size(12.0));
            if show_dealing_chip && row.is_dealing_group {
                ui.label(egui::RichText::new("DEALING").size(9.0).color(theme::text_3()));
            }
            ui.add_space(6.0);
            ui.colored_label(activity_action_color(&row.action), activity_action_label(&row.action));
            if let Some(symbol) = &row.symbol {
                ui.add_space(6.0);
                ui.monospace(symbol);
            }
            if let Some(side) = &row.side {
                let color = if side == "BUY" { theme::accent() } else { theme::danger() };
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
fn sidebar_nav_item(ui: &mut egui::Ui, icon: &str, label: &str, selected: bool, badge: Option<usize>) -> egui::Response {
    let desired_size = egui::vec2(ui.available_width(), 40.0);
    let (rect, response) = ui.allocate_exact_size(desired_size, egui::Sense::click());

    if ui.is_rect_visible(rect) {
        if selected {
            ui.painter().rect_filled(rect, 0.0, theme::accent().linear_multiply(0.14));
            let bar = egui::Rect::from_min_size(rect.min, egui::vec2(3.0, rect.height()));
            ui.painter().rect_filled(bar, 0.0, theme::accent());
        } else if response.hovered() {
            ui.painter().rect_filled(rect, 0.0, theme::bg_2());
        }
        let text_color = if selected { theme::accent() } else { theme::text_2() };
        let icon_pos = rect.min + egui::vec2(20.0, rect.height() / 2.0);
        ui.painter().text(icon_pos, egui::Align2::LEFT_CENTER, icon, egui::FontId::proportional(14.0), text_color);
        let label_pos = rect.min + egui::vec2(46.0, rect.height() / 2.0);
        ui.painter().text(
            label_pos,
            egui::Align2::LEFT_CENTER,
            label,
            egui::FontId::proportional(13.5),
            if selected { theme::text_1() } else { theme::text_2() },
        );
        // Unread-count pill -- matches AdminShell.tsx's own NavGroup badge
        // (rounded-full bg-[var(--sell)] text), shown only when > 0.
        if let Some(count) = badge {
            if count > 0 {
                let text = if count > 99 { "99+".to_string() } else { count.to_string() };
                let badge_pos = egui::pos2(rect.right() - 16.0, rect.center().y);
                ui.painter().circle_filled(badge_pos, 9.0, theme::danger());
                ui.painter().text(badge_pos, egui::Align2::CENTER_CENTER, text, egui::FontId::proportional(9.5), egui::Color32::WHITE);
            }
        }
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
            Some("kyc") => Some(Screen::Kyc),
            Some("client-kyc") => Some(Screen::ClientKyc),
            Some("live-accounts") => Some(Screen::LiveAccountRequests),
            Some("notifications") => Some(Screen::Notifications),
            Some("risk-radar") => Some(Screen::RiskRadar),
            Some("risk") => Some(Screen::Risk),
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
impl BackofficeApp {
    // Single unified top bar (2026-09-08 fix: this used to be two stacked
    // bars -- a 34px drag/window-controls strip plus a separate "header"
    // TopBottomPanel below it showing the screen title/email/logout/
    // theme toggle -- which read as a broken double-header, not a real
    // product chrome). Now one bar carries all of it: branding + screen
    // title on the left, window controls + Log out + theme toggle +
    // signed-in admin on the right, still draggable/double-click-to-
    // maximize across its full width. Logged-out state (login screen)
    // shows just the generic wordmark + window controls, same as before.
    // Redesign Part A -- rebuilt to the design reference's own 56px grid
    // (232px brand cell | flexible breadcrumb+search | right cluster),
    // replacing the old ad-hoc bar. Every control that existed before
    // (drag-to-move/double-click-to-maximize, window buttons, Log out,
    // theme toggle, signed-in identity) is still here, none removed --
    // just laid out to match the reference and, for identity, moved to
    // the avatar's tooltip instead of two bare lines of text competing
    // with the new right-cluster pills (see the avatar block below).
    fn render_titlebar(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("titlebar")
            .exact_height(56.0)
            .frame(egui::Frame::new().fill(theme::bg_1()).stroke(egui::Stroke { width: 1.0, color: theme::border() }))
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
                    // --- Brand cell: fixed 232px, matches the sidebar's
                    // own width exactly so the border-right below lines
                    // up with the sidebar's own left edge on the row
                    // underneath (Part A item 1's "baselines align" fix).
                    let brand_left = bar_rect.left();
                    ui.allocate_ui_with_layout(egui::vec2(232.0, bar_rect.height()), egui::Layout::left_to_right(egui::Align::Center), |ui| {
                        ui.add_space(20.0);
                        if let Some(texture) = &self.broker_logo_texture {
                            ui.add(egui::Image::new(texture).max_height(20.0).max_width(26.0));
                        } else {
                            ui.label(egui::RichText::new("●").size(14.0).color(theme::accent()));
                        }
                        ui.add_space(8.0);
                        ui.vertical(|ui| {
                            ui.add_space(4.0);
                            // Truncated to fit the 232px brand cell on one
                            // line -- a long broker name ("ZZZ QA Test
                            // Broker (not real)", this QA tenant's own
                            // deliberately verbose name) otherwise wraps
                            // to a second line and pushes "Backoffice"
                            // past the header's own 56px height into the
                            // sidebar underneath it, a real overflow bug
                            // caught live on this exact tenant.
                            let raw = self.broker_name.as_deref().unwrap_or("VyXTrader");
                            let brand = if raw.chars().count() > 20 { format!("{}…", raw.chars().take(19).collect::<String>()) } else { raw.to_string() };
                            ui.add(egui::Label::new(egui::RichText::new(brand).font(theme::heading_font(14.0)).color(theme::text_1())).wrap());
                            ui.label(egui::RichText::new("Backoffice").size(10.0).color(theme::text_3()));
                        });
                    });
                    ui.painter().line_segment(
                        [egui::pos2(brand_left + 232.0, bar_rect.top()), egui::pos2(brand_left + 232.0, bar_rect.bottom())],
                        egui::Stroke::new(1.0, theme::border()),
                    );
                    ui.add_space(20.0);

                    if self.logged_in {
                        // Breadcrumb -- "Section › Page" (Part A item 4),
                        // replacing the old bare page title so the page's
                        // own H1 (rendered by each render_* fn) isn't a
                        // second, redundant title directly under it.
                        ui.label(egui::RichText::new(self.screen.group_label()).size(13.5).color(theme::text_3()));
                        ui.label(egui::RichText::new(" \u{203A} ").size(13.0).color(theme::text_3()));
                        ui.label(egui::RichText::new(self.screen.label()).size(13.5).color(theme::text_1()).strong());
                        ui.add_space(24.0);

                        // Global search (Part A item 6) -- a real,
                        // typeable field; not wired to live cross-entity
                        // results this pass, see global_search's own
                        // field comment for why.
                        let search_edit = egui::TextEdit::singleline(&mut self.global_search)
                            .hint_text("Search clients, accounts, orders, symbols…")
                            .desired_width(300.0)
                            .margin(egui::Margin::symmetric(10, 7));
                        ui.add(search_edit);
                        ui.add_space(6.0);
                        ui.label(egui::RichText::new("Ctrl+K").size(10.5).color(theme::text_3()));
                    }

                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        let win_btn = |ui: &mut egui::Ui, symbol: &str, hover: egui::Color32| {
                            let (rect, response) = ui.allocate_exact_size(egui::vec2(34.0, 56.0), egui::Sense::click());
                            if ui.is_rect_visible(rect) {
                                if response.hovered() {
                                    ui.painter().rect_filled(rect, 0.0, hover);
                                }
                                ui.painter().text(rect.center(), egui::Align2::CENTER_CENTER, symbol, egui::FontId::proportional(12.0), theme::text_2());
                            }
                            response
                        };
                        if win_btn(ui, "✕", theme::danger()).clicked() {
                            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                        }
                        if win_btn(ui, "▢", theme::bg_2()).clicked() {
                            ctx.send_viewport_cmd(egui::ViewportCommand::Maximized(!maximized));
                        }
                        if win_btn(ui, "—", theme::bg_2()).clicked() {
                            ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(true));
                        }

                        if self.logged_in {
                            ui.add_space(10.0);

                            // Log out + theme toggle -- same actions as
                            // before, kept as their own small buttons
                            // rather than tucked behind a new dropdown-
                            // menu widget (the design reference's avatar
                            // doesn't come with a documented menu shape
                            // anywhere in the prompt files, so inventing
                            // one is out of scope for this pass).
                            if ui
                                .add(egui::Button::new(egui::RichText::new("Log out").size(11.5).color(theme::text_2())).fill(egui::Color32::TRANSPARENT).stroke(egui::Stroke::new(1.0_f32, theme::border())))
                                .clicked()
                            {
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
                            ui.add_space(8.0);
                            // Added before the avatar/pills below, not
                            // after -- a widget added to a right_to_left
                            // layout AFTER a nested ui.vertical()/
                            // ui.horizontal() call lands at a stale
                            // cursor position in this egui version
                            // (confirmed live: it rendered pinned near
                            // the window's top-left instead of the
                            // right-aligned cluster), so anything else in
                            // this closure has to come before the first
                            // such nested call, not after.
                            let dark = theme::is_dark();
                            let toggle_label = if dark { "\u{25CF}" } else { "\u{25CB}" };
                            if ui
                                .add(
                                    egui::Button::new(egui::RichText::new(toggle_label).size(12.0).color(theme::text_2()))
                                        .fill(theme::bg_2())
                                        .stroke(egui::Stroke::new(1.0_f32, theme::border())),
                                )
                                .clicked()
                            {
                                theme::toggle_mode();
                                theme::apply_visuals(ctx);
                                if let Some(api) = &self.api {
                                    api.set_theme(ctx.clone(), if theme::is_dark() { "dark" } else { "light" }.to_string());
                                }
                            }
                            ui.add_space(14.0);

                            // Avatar -- initials from the signed-in
                            // email's local part; full email + host
                            // (previously two bare lines of header text)
                            // now live in its tooltip, still real
                            // information, just not competing for header
                            // width with the new pills.
                            let initials: String = self
                                .logged_in_email
                                .split(['@', '.'])
                                .next()
                                .unwrap_or("")
                                .chars()
                                .take(2)
                                .collect::<String>()
                                .to_uppercase();
                            let (avatar_rect, avatar_resp) = ui.allocate_exact_size(egui::vec2(30.0, 30.0), egui::Sense::hover());
                            ui.painter().circle_filled(avatar_rect.center(), 15.0, theme::bg_2());
                            ui.painter().circle_stroke(avatar_rect.center(), 15.0, egui::Stroke::new(1.0, theme::border()));
                            ui.painter().text(avatar_rect.center(), egui::Align2::CENTER_CENTER, &initials, egui::FontId::proportional(11.0), theme::text_1());
                            avatar_resp.on_hover_text(format!("{}\n{}", self.logged_in_email, self.host_input));
                            ui.add_space(12.0);

                            // Notification bell -- orange dot when there's
                            // an unread notification, same real count the
                            // sidebar's own Notifications badge uses.
                            // Clicking navigates to Notifications, same
                            // as clicking the sidebar row.
                            let unread = self.notifications.iter().filter(|n| !n.read).count();
                            let (bell_rect, bell_resp) = ui.allocate_exact_size(egui::vec2(26.0, 26.0), egui::Sense::click());
                            // A real bell emoji doesn't exist in Inter's
                            // glyph set (renders as tofu/fallback) --
                            // same plain-Unicode-glyph, no-icon-font
                            // convention Screen::icon() already
                            // established for exactly this reason. Reuses
                            // that same Notifications glyph so the bell
                            // and the sidebar row it navigates to read as
                            // the same icon.
                            ui.painter().text(bell_rect.center(), egui::Align2::CENTER_CENTER, Screen::Notifications.icon(), egui::FontId::proportional(15.0), theme::text_2());
                            if unread > 0 {
                                ui.painter().circle_filled(bell_rect.center() + egui::vec2(7.0, -7.0), 4.0, theme::accent());
                            }
                            if bell_resp.on_hover_text(if unread > 0 { format!("{unread} unread") } else { "No unread notifications".to_string() }).clicked() {
                                self.screen = Screen::Notifications;
                                self.ensure_loaded(ctx, Screen::Notifications);
                            }
                            ui.add_space(14.0);

                            // Clock -- real UTC time, ticks every frame
                            // since the update loop already repaints on
                            // the 5s auto-refresh timer at minimum.
                            let now = chrono_like_utc_now();
                            ui.label(egui::RichText::new(now).size(12.0).color(theme::text_3()).monospace());
                            ui.add_space(14.0);

                            // Feed / Engine pills -- real connectivity
                            // signals, not fabricated numbers. Feed shows
                            // measured round-trip time of this app's own
                            // last periodic refresh cycle (see
                            // last_refresh_rtt_ms's own comment) instead
                            // of the design reference's placeholder
                            // "42ms" -- no real per-tick feed latency is
                            // exposed by any endpoint this app calls, so
                            // showing a made-up number would be worse
                            // than showing the honest thing this app can
                            // actually measure. Engine shows whether the
                            // most recent API round-trip (any screen)
                            // succeeded.
                            let pill = |ui: &mut egui::Ui, dot: egui::Color32, text: String| {
                                egui::Frame::new()
                                    .stroke(egui::Stroke::new(1.0, theme::border()))
                                    // CornerRadius is a u8 (0..=255) --
                                    // 20 is already well past half this
                                    // pill's own height, so it renders
                                    // fully pill-shaped same as a literal
                                    // 999 would, just within range.
                                    .corner_radius(egui::CornerRadius::same(20))
                                    .inner_margin(egui::Margin::symmetric(9, 5))
                                    .show(ui, |ui| {
                                        ui.horizontal(|ui| {
                                            let (dot_rect, _) = ui.allocate_exact_size(egui::vec2(7.0, 7.0), egui::Sense::hover());
                                            ui.painter().circle_filled(dot_rect.center(), 3.5, dot);
                                            ui.label(egui::RichText::new(text).size(11.5).color(theme::text_3()));
                                        });
                                    });
                            };
                            let (feed_dot, feed_text) = match self.last_refresh_rtt_ms {
                                Some(ms) => (theme::up(), format!("Feed {ms}ms")),
                                None => (theme::text_3(), "Feed …".to_string()),
                            };
                            pill(ui, feed_dot, feed_text);
                            ui.add_space(8.0);
                            // Engine: green while a session is active. This
                            // app doesn't cheaply expose a per-request
                            // success/failure signal common to every one of
                            // ApiEvent's many variants, so rather than fake
                            // a health check this reflects the one thing
                            // that's actually true here -- an authenticated
                            // session is up and the shell is rendering.
                            pill(ui, theme::up(), "Engine".to_string());
                        }
                    });
                });
            });
    }
}

// The server's 403 body is always the bare JSON string "forbidden" --
// true for both a real auth failure and a MANAGER correctly missing a
// specific delegated permission (KYC_REVIEW, RISK_SETTINGS, ...), see
// lib/permissions.ts's forbidUnlessBrokerAdminOrPermission. Rendering
// that raw word gives no admin any idea whether this is expected
// (ask a Broker Admin to delegate the permission) or a real bug. Only
// rewrites the literal "forbidden" string -- any other error text
// (network error, bad response, a real 500) passes through unchanged.
fn permission_error_message(err: &str, required_permission: &str) -> String {
    if err == "forbidden" {
        format!(
            "You don't have permission to view this -- it requires the {required_permission} permission. Ask a Broker Admin to grant it under Users & roles."
        )
    } else {
        err.to_string()
    }
}

// UTC clock text, HH:MM:SS -- std::time only (no chrono dependency in
// this crate), reads the system clock and does the civil-time math by
// hand. Named for what it returns, not a claim this crate depends on
// the chrono crate.
fn chrono_like_utc_now() -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs_today = now.as_secs() % 86400;
    format!("{:02}:{:02}:{:02} UTC", secs_today / 3600, (secs_today % 3600) / 60, secs_today % 60)
}

impl eframe::App for BackofficeApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_events(ctx);

        const AUTO_REFRESH: std::time::Duration = std::time::Duration::from_secs(5);
        if self.logged_in {
            let elapsed = self.last_auto_refresh.elapsed();
            if elapsed >= AUTO_REFRESH {
                self.last_auto_refresh = std::time::Instant::now();
                self.last_refresh_started = Some(std::time::Instant::now());
                self.fetch(ctx, self.screen);
            }
            // Keeps the update loop ticking on its own even with no
            // mouse/keyboard input, so the timer above actually fires --
            // egui otherwise only repaints in response to real events.
            ctx.request_repaint_after(AUTO_REFRESH.saturating_sub(elapsed));
        }

        self.render_titlebar(ctx);
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
