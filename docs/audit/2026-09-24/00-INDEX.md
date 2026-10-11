# 00-INDEX: VyX functional audit (read-only), 2026-09-24/25

## Repos and paths
| Part | Path | Commit audited |
|---|---|---|
| Native apps (Avalonia, .NET 8, Native AOT) | `E:\vyxtrader` (origin darkkk001/VyxTrader, master) | `1c8b0d3` |
| Web / API (Next.js 15, Prisma) + Rust engine + API gateway | `D:\VyXTrader-Tauri\vyX` (newrepo darkkk001/vyX, main) | `74b3c02` |
| Backoffice app | `E:\vyxtrader\src\Vyx.Backoffice.App` | live build 1.0.22 |
| Trader terminal app | `E:\vyxtrader\src\Vyx.Trader.App` | live build 1.0.45 |
| Shared (API client, models, trading math) | `E:\vyxtrader\src\Vyx.Shared` (`Api\ApiClient*.cs`, `Api\Models.cs`, `Trading\*.cs`, `Charting\*.cs`) | |
| Shared UI (title bar, StartupGate, UpdateService, chart host, MenuHost) | `E:\vyxtrader\src\Vyx.Shared.Ui` | |
| Web routes | `D:\VyXTrader-Tauri\vyX\app\api\**\route.ts` | |
| Web business logic | `D:\VyXTrader-Tauri\vyX\lib\*.ts` | |
| Rust engine | `D:\VyXTrader-Tauri\vyX\engine` (server, order-management, market-data, risk, margin, parity) | |
| API gateway (Node) | `D:\VyXTrader-Tauri\vyX\services\api-gateway` | |
| DB schema | `D:\VyXTrader-Tauri\vyX\prisma\schema.prisma` | live DB: Neon ep-morning-glade |

## Build / run
- Native, debug: `dotnet build E:\vyxtrader\Vyx.Native.sln -c Debug`; tests `dotnet test tests\Vyx.Shared.Tests`.
- Native, release (per broker, tenant-bound, AOT): `tools\publish-terminal.ps1` / `tools\publish-backoffice.ps1 -Brand -Slug -DefaultHost -Version -FeedRoot -Notes` (registers the build, packs with vpk; feed staged to the web repo's `public\native-*-updates\<slug>`).
- Web: `npm run dev` (next dev), `npm run build` (prisma generate + next build), `npm test` (vitest; DB tests need the local scratch DB, `vitest.setup.db-guard.ts`).
- Engine: `cargo build --release` in `engine`; tests `bash scripts/test-engine.sh`; parity `bash scripts/parity/run-db.sh`; shadow gate `bash scripts/load/shadow-gate.sh`.
- Harness (headless): terminal `Vyx.Trader.App.exe --screenshot --dev-dock-demo ...`; backoffice `--screenshot --fixture`, `--live-check`, `--manifest-check`.

## Backoffice navigation (exact order and titles)
Source: `E:\vyxtrader\src\Vyx.Backoffice.App\ViewModels\ShellViewModel.cs:50-88`.
| Group | Code | Title | Screen file |
|---|---|---|---|
| OVERVIEW | DASH | Dashboard | Screens\DashboardScreen.cs |
| OVERVIEW | RPT | Reports | Screens\IbReportsScreens.cs |
| OVERVIEW | NTF | Notifications | Screens\NotificationsAuditScreens.cs |
| TRADING | EXP | Live exposure | Screens\LiveExposureScreen.cs |
| TRADING | DEAL | Dealing | Screens\DealingScreen.cs (+ Services\DealingChart.cs, DealingMarketWatch.cs) |
| TRADING | DLS | Trade history | Screens\DealsScreen.cs |
| TRADING | SYM | Symbols | Screens\SymbolsScreen.cs |
| TRADING | GRP | Groups | Screens\GroupsScreen.cs (+ Controls\PricingPanel.cs) |
| TRADING | ATY | Account types | Screens\AccountTypesScreen.cs (+ Controls\PricingPanel.cs) |
| TRADING | MIR | Mirror rules | Screens\ApprovalsMirrorScreens.cs |
| RISK | RISK | Risk | Screens\RiskScreen.cs |
| RISK | RDR | Risk radar | Screens\LiquidityScreens.cs |
| RISK | EMG | Trading halt | Screens\SecurityEmergencyScreens.cs |
| RISK | MRG | Margin | Screens\RiskScreen.cs |
| LIQUIDITY | LP | Liquidity | Screens\LiquidityScreens.cs |
| LIQUIDITY | ROUTE | Liquidity routing | Screens\LiquidityScreens.cs |
| LIQUIDITY | FEED | Feed health | Screens\LiquidityScreens.cs |
| CLIENTS | CLI | Clients (+ Client 360) | Screens\ClientsScreen.cs |
| CLIENTS | CRM | Leads | Screens\WalletsLeadsScreens.cs |
| CLIENTS | IB | IB partners | Screens\IbReportsScreens.cs |
| CLIENTS | KYC | KYC review | Screens\KycScreen.cs |
| CLIENTS | LAR | Account requests | Screens\LiveAccountRequestsScreen.cs |
| FINANCE | DEP | Deposits · withdrawals | Screens\FundsScreen.cs |
| FINANCE | APR | Approvals | Screens\ApprovalsMirrorScreens.cs |
| FINANCE | PSP | Payment methods | Screens\PaymentMethodsScreen.cs |
| FINANCE | TRX | Transfers | Screens\TransfersScreen.cs |
| FINANCE | WAL | Wallets | Screens\WalletsLeadsScreens.cs |
| SYSTEM | USR | Team | Screens\TeamScreen.cs |
| SYSTEM | AUD | Audit log | Screens\NotificationsAuditScreens.cs |
| SYSTEM | SEC | Security | Screens\SecurityEmergencyScreens.cs |
| SYSTEM | CFG | Settings | Screens\SettingsScreen.cs |

Backoffice shared components: `Controls\DataTable.cs` (every table), `Controls\FormOverlay.cs` (every form dialog), `Controls\ConfirmOverlay.axaml(.cs)` (confirm / typed confirm / input confirm), `Controls\PricingPanel.cs` (GRP + ATY pricing), `Controls\KpiTile.cs`, `Controls\Ui.cs` (text/badge helpers), `Controls\DocumentViewer.cs` (KYC docs), `Controls\ScreenPlaceholder.axaml`, `Services\MenuHost.cs` (context menus), `Services\LiveService.cs` (event stream), `Screens\Screen.cs` (base: Confirm / Form / Toast / AfterWriteAsync).

## Trader terminal areas and files
| Area | Files |
|---|---|
| Shell / header / account strip / status bar / tape | MainWindow.axaml(.cs), Views\TopBar, Views\StatusBar, Views\Tape |
| Market watch | Views\MarketWatchPanel, ViewModels\MarketWatchViewModels, Views\SymbolSpecWindow |
| Chart | Vyx.Shared.Ui\Charting (ChartHost, StudiesStore, DrawingsStore), Vyx.Shared\Charting, Vyx.Trader.App\Charting |
| Order ticket (dock) | Views\OrderTicketPanel, ViewModels\OrderTicketViewModel(s) |
| F9 new order | Views\NewOrderWindow, ViewModels\NewOrderViewModel |
| Positions + tabs (pending / orders / history / balance / log) | Views\PositionsPanel, ViewModels\DockViewModels, PositionsViewModels, Services\StatementExport |
| Modify / close | Views\ModifyPositionWindow, ViewModels\ModifyPositionViewModel |
| Smart Trade Manager | Views\SmartRulesWindow, Services\SmartRulesEngine |
| Account panel | Views\AccountPanel, ViewModels\AccountViewModel |
| Economic calendar / news | Views\EcoPanel |
| Alerts | Views\AlertsWindow |
| Settings | Views\SettingsWindow, Services\TerminalSettings |
| Share card | Views\ShareCardWindow, Services\ShareCard |
| Session / update | Views\LoginWindow, Services\CredentialStore, Services\UpdateService + Vyx.Shared.Ui UpdateService / StartupGate |
| All logic hub | Services\MarketDataService.cs |

## Audit files (this folder)
Per screen: `bo-<CODE>.md` (backoffice, incl. `bo-SHELL.md`) and `term-<area>.md` (terminal); cross-cutting: `ui-map.md`, `entities.md`, `endpoints.md`, `config.md`, `cross-cutting.md`, `questions.md`, `issues.md`, `recommendations.md`; everything combined: `VYX-AUDIT-ALL*.md`; zip: `vyx-audit-2026-09-24.zip`. `_BRIEF.md` = the method every file follows.
