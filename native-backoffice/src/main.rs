// True-native (zero-webview) backoffice -- real native window via
// eframe/winit, no webview, no browser, no HTML/CSS/JS anywhere in this
// binary. See api.rs's own top comment for why this talks to the live
// /api/manage/* HTTP endpoints rather than "a Rust DB layer" -- no such
// layer exists yet (engine/ is a Phase 1, no-I/O scaffold).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;

use api::{
    AccountRow, ApiClient, ApiEvent, ClientKycRow, DashboardData, DealingOrderRow, GroupPricingRow, GroupRow,
    LiveAccountRequestRow, NewAccountBody, NotificationRow, PositionRow, RiskRadarRow, SettingsData,
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
}

impl Screen {
    fn label(self) -> &'static str {
        match self {
            Screen::Dashboard => "Dashboard",
            Screen::Positions => "Positions",
            Screen::Accounts => "Clients / Accounts",
            Screen::Dealing => "Dealing",
            Screen::Groups => "Groups",
            Screen::ClientKyc => "Client KYC",
            Screen::LiveAccountRequests => "Live Account Requests",
            Screen::Notifications => "Notifications",
            Screen::RiskRadar => "Risk / Exposure",
            Screen::Settings => "Settings",
        }
    }
}

// Shared by Dealing/Client KYC/Live Account Requests -- all three follow
// the same "Reject requires a typed reason, Approve/Accept doesn't" shape
// in the real API, so one small inline-reason-box state does for all of
// them instead of three near-identical structs.
#[derive(Default)]
struct PendingReject {
    id: String,
    reason: String,
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

    // --- dashboard ---
    dashboard: Option<DashboardData>,
    dashboard_loading: bool,
    dashboard_error: Option<String>,

    // --- positions ---
    positions: Vec<PositionRow>,
    positions_loading: bool,
    positions_error: Option<String>,

    // --- accounts ---
    accounts: Vec<AccountRow>,
    accounts_loading: bool,
    accounts_error: Option<String>,
    accounts_filter: String,
    show_new_account_form: bool,
    new_account: NewAccountForm,

    // --- dealing ---
    dealing_queue: Vec<DealingOrderRow>,
    dealing_loading: bool,
    dealing_error: Option<String>,
    dealing_reject: Option<PendingReject>,

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
            dashboard: None,
            dashboard_loading: false,
            dashboard_error: None,
            positions: Vec::new(),
            positions_loading: false,
            positions_error: None,
            accounts: Vec::new(),
            accounts_loading: false,
            accounts_error: None,
            accounts_filter: String::new(),
            show_new_account_form: false,
            new_account: NewAccountForm::default(),
            dealing_queue: Vec::new(),
            dealing_loading: false,
            dealing_error: None,
            dealing_reject: None,
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
                }
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
                        Ok(rows) => self.dealing_queue = rows,
                        Err(e) => self.dealing_error = Some(e),
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
                ApiEvent::ActionDone(result) => match result {
                    Ok(msg) => {
                        self.action_message = Some(msg);
                        self.show_new_account_form = false;
                        self.new_account = NewAccountForm::default();
                        self.dealing_reject = None;
                        self.kyc_reject = None;
                        self.live_account_reject = None;
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
        }
    }

    fn fetch_group_pricing(&mut self, ctx: &egui::Context, group_id: String) {
        let Some(api) = &self.api else { return };
        self.group_pricing_loading = true;
        self.group_pricing_error = None;
        api.fetch_group_pricing(ctx.clone(), self.tx.clone(), group_id);
    }

    fn render_login(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.vertical_centered(|ui| {
                ui.add_space(120.0);
                ui.heading("VyXTrader Backoffice");
                ui.label(egui::RichText::new("native proof-of-concept").weak().italics());
                ui.add_space(24.0);

                egui::Frame::group(ui.style()).inner_margin(20.0).show(ui, |ui| {
                    ui.set_width(360.0);
                    ui.label("Broker host");
                    ui.add(egui::TextEdit::singleline(&mut self.host_input).hint_text("brokername.vyxtrader.com"));
                    ui.add_space(8.0);
                    ui.label("Email");
                    ui.add(egui::TextEdit::singleline(&mut self.email_input).hint_text("admin@broker.com"));
                    ui.add_space(8.0);
                    ui.label("Password");
                    ui.add(egui::TextEdit::singleline(&mut self.password_input).password(true));
                    ui.add_space(14.0);

                    let can_submit = !self.login_busy
                        && !self.host_input.trim().is_empty()
                        && !self.email_input.trim().is_empty()
                        && !self.password_input.is_empty();

                    if ui.add_enabled(can_submit, egui::Button::new(if self.login_busy { "Signing in..." } else { "Sign in" })).clicked() {
                        self.login_error = None;
                        self.login_busy = true;
                        let api = ApiClient::new(self.host_input.trim());
                        self.api = Some(api.clone());
                        api.login(ctx.clone(), self.tx.clone(), self.email_input.trim().to_string(), self.password_input.clone());
                    }

                    if let Some(err) = &self.login_error {
                        ui.add_space(10.0);
                        ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
                    }
                });

                ui.add_space(16.0);
                ui.label(egui::RichText::new("2FA-enabled admin accounts aren't supported here yet -- use the web backoffice for those.").weak().small());
            });
        });
    }

    fn render_shell(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("header").show(ctx, |ui| {
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                ui.heading(self.screen.label());
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Log out").clicked() {
                        self.logged_in = false;
                        self.api = None;
                        self.loaded_once.clear();
                        self.dashboard = None;
                        self.positions.clear();
                        self.accounts.clear();
                    }
                    ui.add_space(12.0);
                    ui.label(egui::RichText::new(format!("{} @ {}", self.logged_in_email, self.host_input)).weak());
                });
            });
            ui.add_space(6.0);
        });

        egui::SidePanel::left("sidebar").resizable(false).exact_width(200.0).show(ctx, |ui| {
            ui.add_space(10.0);
            for screen in [
                Screen::Dashboard,
                Screen::Positions,
                Screen::Accounts,
                Screen::Dealing,
                Screen::Groups,
                Screen::ClientKyc,
                Screen::LiveAccountRequests,
                Screen::Notifications,
                Screen::RiskRadar,
                Screen::Settings,
            ] {
                let selected = self.screen == screen;
                if ui.add(egui::Button::selectable(selected, screen.label())).clicked() {
                    self.screen = screen;
                    self.ensure_loaded(ctx, screen);
                }
            }
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            if let Some(msg) = self.action_message.clone() {
                ui.horizontal(|ui| {
                    ui.label(egui::RichText::new(msg).italics());
                    if ui.small_button("dismiss").clicked() {
                        self.action_message = None;
                    }
                });
                ui.separator();
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
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
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
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
            return;
        }

        TableBuilder::new(ui)
            .striped(true)
            .resizable(true)
            .cell_layout(egui::Layout::left_to_right(egui::Align::Center))
            .column(Column::auto().at_least(100.0))
            .column(Column::remainder().at_least(160.0))
            .column(Column::auto().at_least(80.0))
            .column(Column::auto().at_least(50.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(90.0))
            .column(Column::auto().at_least(140.0))
            .header(28.0, |mut header| {
                for label in ["Account", "Client", "Symbol", "Side", "Volume", "Open", "Current", "Floating P/L", "Opened"] {
                    header.col(|ui| {
                        ui.strong(label);
                    });
                }
            })
            .body(|body| {
                body.rows(26.0, self.positions.len(), |mut row| {
                    let p = &self.positions[row.index()];
                    row.col(|ui| {
                        ui.monospace(&p.account_number);
                    });
                    row.col(|ui| {
                        ui.label(&p.account_full_name);
                    });
                    row.col(|ui| {
                        ui.monospace(&p.symbol_name);
                    });
                    row.col(|ui| {
                        let color = if p.side == "BUY" {
                            egui::Color32::from_rgb(0x16, 0xc7, 0x84)
                        } else {
                            egui::Color32::from_rgb(0xe5, 0x4d, 0x4d)
                        };
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
                        let pnl_text = p.floating_pnl.as_deref().unwrap_or("-");
                        let color = match p.floating_pnl.as_deref().and_then(|s| s.parse::<f64>().ok()) {
                            Some(v) if v > 0.0 => egui::Color32::from_rgb(0x16, 0xc7, 0x84),
                            Some(v) if v < 0.0 => egui::Color32::from_rgb(0xe5, 0x4d, 0x4d),
                            _ => ui.visuals().text_color(),
                        };
                        ui.colored_label(color, pnl_text);
                    });
                    row.col(|ui| {
                        ui.monospace(&p.opened_at);
                    });
                });
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
            egui::Frame::group(ui.style()).inner_margin(12.0).show(ui, |ui| {
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
                if ui.add_enabled(valid, egui::Button::new("Create")).clicked() {
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
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
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
                        ui.strong(label);
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
                            "ACTIVE" => egui::Color32::from_rgb(0x16, 0xc7, 0x84),
                            "SUSPENDED" => egui::Color32::from_rgb(0xe0, 0xa0, 0x30),
                            _ => egui::Color32::from_rgb(0x9a, 0xa4, 0xb2),
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

    fn render_dealing(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.horizontal(|ui| {
            if ui.button("Refresh").clicked() {
                self.fetch(ctx, Screen::Dealing);
            }
            if self.dealing_loading {
                ui.spinner();
            }
            ui.weak(format!("{} orders awaiting review", self.dealing_queue.len()));
        });
        ui.weak("Requote isn't supported in this native pass yet -- Accept or Reject only.");
        ui.add_space(8.0);

        if let Some(err) = &self.dealing_error {
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
            return;
        }

        let mut accept_id: Option<String> = None;
        let mut confirm_reject: Option<(String, String)> = None;

        for order in self.dealing_queue.clone() {
            egui::Frame::group(ui.style()).inner_margin(10.0).show(ui, |ui| {
                ui.horizontal(|ui| {
                    let side_color = if order.side == "BUY" {
                        egui::Color32::from_rgb(0x16, 0xc7, 0x84)
                    } else {
                        egui::Color32::from_rgb(0xe5, 0x4d, 0x4d)
                    };
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
                        if ui.button("Accept").clicked() {
                            accept_id = Some(order.id.clone());
                        }
                    });
                });

                if self.dealing_reject.as_ref().is_some_and(|p| p.id == order.id) {
                    let mut pending = self.dealing_reject.take().unwrap();
                    let mut cancelled = false;
                    ui.horizontal(|ui| {
                        ui.label("Reason (required):");
                        ui.text_edit_singleline(&mut pending.reason);
                        if ui.add_enabled(!pending.reason.trim().is_empty(), egui::Button::new("Confirm reject")).clicked() {
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
            });
        }

        if let Some(id) = accept_id {
            if let Some(api) = &self.api {
                api.dealing_action(ctx.clone(), self.tx.clone(), id, "ACCEPT".to_string(), None);
            }
        }
        if let Some((id, reason)) = confirm_reject {
            if let Some(api) = &self.api {
                api.dealing_action(ctx.clone(), self.tx.clone(), id, "REJECT".to_string(), Some(reason));
            }
        }
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
                ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
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
                            ui.strong(label);
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
                                ui.colored_label(egui::Color32::from_rgb(0x16, 0xc7, 0x84), "custom");
                            } else {
                                ui.weak("broker default");
                            }
                        });
                        row.col(|ui| {
                            if ui.small_button("Save").clicked() {
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
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
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
                        ui.strong(label);
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
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
            return;
        }

        let mut approve_id: Option<String> = None;
        let mut confirm_reject: Option<(String, String)> = None;

        for record in self.client_kyc.clone() {
            egui::Frame::group(ui.style()).inner_margin(10.0).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(&record.client_full_name);
                    ui.weak(&record.client_email);
                    ui.weak(record.client_country.as_deref().unwrap_or("-"));
                    ui.monospace(&record.document_type);
                    ui.weak(record.created_at.get(0..10).unwrap_or(&record.created_at));
                    let status_color = match record.status.as_str() {
                        "APPROVED" => egui::Color32::from_rgb(0x16, 0xc7, 0x84),
                        "REJECTED" => egui::Color32::from_rgb(0xe5, 0x4d, 0x4d),
                        _ => egui::Color32::from_rgb(0xe0, 0xa0, 0x30),
                    };
                    ui.colored_label(status_color, &record.status);
                    if record.status == "PENDING" {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Reject").clicked() {
                                self.kyc_reject = Some(PendingReject { id: record.id.clone(), reason: String::new() });
                            }
                            if ui.button("Approve").clicked() {
                                approve_id = Some(record.id.clone());
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
                        if ui.add_enabled(!pending.reason.trim().is_empty(), egui::Button::new("Confirm reject")).clicked() {
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
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
            return;
        }

        let mut approve_id: Option<String> = None;
        let mut confirm_reject: Option<(String, String)> = None;

        for req in self.live_account_requests.clone() {
            egui::Frame::group(ui.style()).inner_margin(10.0).show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(&req.client_full_name);
                    ui.weak(&req.client_email);
                    ui.monospace(req.account_type_name.as_deref().unwrap_or("-"));
                    ui.weak(req.created_at.get(0..10).unwrap_or(&req.created_at));
                    let status_color = match req.status.as_str() {
                        "APPROVED" => egui::Color32::from_rgb(0x16, 0xc7, 0x84),
                        "REJECTED" => egui::Color32::from_rgb(0xe5, 0x4d, 0x4d),
                        _ => egui::Color32::from_rgb(0xe0, 0xa0, 0x30),
                    };
                    ui.colored_label(status_color, &req.status);
                    if req.status == "PENDING" {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Reject").clicked() {
                                self.live_account_reject = Some(PendingReject { id: req.id.clone(), reason: String::new() });
                            }
                            if ui.button("Approve").clicked() {
                                approve_id = Some(req.id.clone());
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
                        if ui.add_enabled(!pending.reason.trim().is_empty(), egui::Button::new("Confirm reject")).clicked() {
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
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
            return;
        }

        egui::ScrollArea::vertical().show(ui, |ui| {
            for n in &self.notifications {
                ui.horizontal(|ui| {
                    if !n.read {
                        ui.colored_label(egui::Color32::from_rgb(0x16, 0xc7, 0x84), "*");
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
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
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
                        ui.strong(label);
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
                            egui::Color32::from_rgb(0x16, 0xc7, 0x84)
                        } else if r.profit_velocity_per_day < 0.0 {
                            egui::Color32::from_rgb(0xe5, 0x4d, 0x4d)
                        } else {
                            ui.visuals().text_color()
                        };
                        ui.colored_label(color, format!("${:.2}", r.profit_velocity_per_day));
                    });
                    row.col(|ui| {
                        ui.horizontal(|ui| {
                            if r.scalp_flag {
                                ui.colored_label(egui::Color32::from_rgb(0xe0, 0xa0, 0x30), "SCALP");
                            }
                            if r.martingale_flag {
                                ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), "MARTINGALE");
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
            ui.colored_label(egui::Color32::from_rgb(0xe5, 0x4d, 0x4d), err);
            return;
        }
        let Some(settings) = self.settings.clone() else { return };

        egui::Frame::group(ui.style()).inner_margin(14.0).show(ui, |ui| {
            ui.set_width(360.0);
            ui.label(format!("Broker: {}", settings.name));
            ui.label(format!("Default currency: {} (USD only, no conversion yet)", settings.default_account_currency));
            ui.add_space(10.0);
            ui.label("Default account leverage");
            ui.add(egui::TextEdit::singleline(&mut self.settings_leverage_input));
            ui.add_space(10.0);
            let parsed = self.settings_leverage_input.trim().parse::<i64>().ok();
            if ui.add_enabled(matches!(parsed, Some(n) if n > 0), egui::Button::new("Save")).clicked() {
                if let (Some(api), Some(n)) = (&self.api, parsed) {
                    api.update_default_leverage(ctx.clone(), self.tx.clone(), n);
                }
            }
        });
        ui.add_space(10.0);
        ui.weak("This screen covers broker-wide defaults (app/api/manage/settings) -- symbol/spread pricing lives on the Groups screen's per-symbol editor, not here.");
    }
}

fn stat_card(ui: &mut egui::Ui, label: &str, value: &str) {
    egui::Frame::group(ui.style()).inner_margin(14.0).show(ui, |ui| {
        ui.set_min_width(150.0);
        ui.vertical(|ui| {
            ui.weak(label);
            ui.add_space(4.0);
            ui.heading(value);
        });
    });
}

// Matches the real web backoffice's own dark theme (app/admin-theme.css's
// --bg-1/--bg-2/--text-1/--accent) so this reads as the same product
// line, not an unrelated tech demo.
fn apply_brand_theme(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();
    let bg_1 = egui::Color32::from_rgb(0x0b, 0x0f, 0x14);
    let bg_2 = egui::Color32::from_rgb(0x0e, 0x13, 0x19);
    let text_1 = egui::Color32::from_rgb(0xed, 0xef, 0xf2);
    let accent = egui::Color32::from_rgb(0x16, 0xc7, 0x84);

    visuals.panel_fill = bg_1;
    visuals.window_fill = bg_1;
    visuals.extreme_bg_color = bg_2;
    visuals.faint_bg_color = bg_2;
    visuals.override_text_color = Some(text_1);
    visuals.selection.bg_fill = accent;
    visuals.widgets.hovered.bg_fill = bg_2;
    visuals.widgets.active.bg_fill = accent.linear_multiply(0.35);

    ctx.set_visuals(visuals);
    ctx.style_mut(|style| {
        style.spacing.item_spacing = egui::vec2(10.0, 8.0);
        style.spacing.button_padding = egui::vec2(12.0, 6.0);
    });
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
            _ => None,
        };
        if let Some(screen) = target {
            self.screen = screen;
            self.ensure_loaded(ctx, screen);
        }
    }
}

impl eframe::App for BackofficeApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain_events(ctx);
        if self.logged_in {
            self.render_shell(ctx);
        } else {
            self.render_login(ctx);
        }
    }
}

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("VyXTrader Backoffice (Native POC)")
            .with_inner_size([1360.0, 840.0])
            .with_min_inner_size([1024.0, 600.0]),
        ..Default::default()
    };

    eframe::run_native(
        "VyXTrader Backoffice (Native POC)",
        options,
        Box::new(|cc| {
            apply_brand_theme(&cc.egui_ctx);
            let mut app = BackofficeApp::default();
            app.maybe_autologin(&cc.egui_ctx);
            Ok(Box::new(app))
        }),
    )
}
