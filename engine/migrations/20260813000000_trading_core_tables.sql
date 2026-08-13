-- Trading Core tables — owned exclusively by the Rust engine (ADR-002,
-- ../../docs/database.md §2-3). Lives under engine/migrations, NOT
-- prisma/migrations: Prisma never reads, writes, or tracks schema drift
-- for these tables. snake_case naming is deliberate so these are never
-- visually confusable with Prisma's PascalCase `Order`/`Position` tables,
-- which keep serving brokers not yet cut over (ADR-003).
--
-- References broker_id/account_id/symbol_id as plain text columns, not
-- foreign keys into Prisma's tables — the two schemas are intentionally
-- decoupled (see docs/database.md §3: "a broker is either fully on the
-- old path or fully on the new one, never split mid-flight"). Referential
-- integrity across that boundary is an application-level concern, not a
-- database-level one, precisely because only one side is ever live for a
-- given broker at a time.

CREATE TYPE order_side AS ENUM ('BUY', 'SELL');
CREATE TYPE order_type AS ENUM ('MARKET', 'LIMIT', 'STOP');

-- Superset of Prisma's OrderStatus — see docs/trading-engine.md §2.1 and
-- engine/protocol/src/lib.rs's OrderStatus (the authoritative Rust type
-- this column's values must stay in lockstep with).
CREATE TYPE order_status AS ENUM (
    'NEW', 'VALIDATING', 'ACCEPTED', 'REJECTED',
    'ROUTING', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'EXPIRED'
);

CREATE TYPE position_status AS ENUM ('OPEN', 'CLOSED');

CREATE TYPE ledger_entry_type AS ENUM (
    'DEPOSIT', 'WITHDRAWAL', 'REALIZED_PNL', 'COMMISSION', 'SWAP', 'CREDIT_ADJUSTMENT'
);

CREATE TABLE orders (
    id                 TEXT PRIMARY KEY,
    broker_id          TEXT NOT NULL,
    account_id         TEXT NOT NULL,
    symbol             TEXT NOT NULL, -- matches Symbol.name, e.g. "EURUSD" (see LivePrice/Candle's own convention)
    side               order_side NOT NULL,
    type               order_type NOT NULL,
    volume             DECIMAL(10, 2) NOT NULL,
    requested_price    DECIMAL(18, 5), -- null for MARKET
    sl_price           DECIMAL(18, 5),
    tp_price           DECIMAL(18, 5),
    status             order_status NOT NULL DEFAULT 'NEW',
    reject_reason      TEXT,
    filled_price       DECIMAL(18, 5),
    filled_volume      DECIMAL(10, 2),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_account ON orders (account_id);
CREATE INDEX idx_orders_broker_status ON orders (broker_id, status);

CREATE TABLE positions (
    id                TEXT PRIMARY KEY,
    broker_id         TEXT NOT NULL,
    account_id        TEXT NOT NULL,
    symbol            TEXT NOT NULL,
    origin_order_id   TEXT NOT NULL UNIQUE REFERENCES orders (id),
    side              order_side NOT NULL,
    volume            DECIMAL(10, 2) NOT NULL,
    open_price        DECIMAL(18, 5) NOT NULL,
    close_price       DECIMAL(18, 5),
    sl_price          DECIMAL(18, 5),
    tp_price          DECIMAL(18, 5),
    status            position_status NOT NULL DEFAULT 'OPEN',
    realized_pnl      DECIMAL(18, 4),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at         TIMESTAMPTZ
);

CREATE INDEX idx_positions_account_status ON positions (account_id, status);

CREATE TABLE ledger_entries (
    id                   TEXT PRIMARY KEY,
    account_id           TEXT NOT NULL,
    entry_type           ledger_entry_type NOT NULL,
    amount               DECIMAL(18, 4) NOT NULL,
    related_position_id  TEXT REFERENCES positions (id),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_entries_account ON ledger_entries (account_id, created_at);
