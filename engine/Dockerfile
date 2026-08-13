# Builds engine/server's trading-core-server binary. Build context is the
# engine/ directory (Railway: set this service's "Root Directory" to
# engine/) — the whole Cargo workspace is needed since server depends on
# every other crate as a path dependency.

FROM rust:1.82-slim-bookworm AS builder
WORKDIR /build

# Cached separately from source so a source-only change doesn't re-fetch
# every dependency.
COPY Cargo.toml ./
COPY protocol/Cargo.toml protocol/Cargo.toml
COPY market-data/Cargo.toml market-data/Cargo.toml
COPY order-management/Cargo.toml order-management/Cargo.toml
COPY position/Cargo.toml position/Cargo.toml
COPY risk/Cargo.toml risk/Cargo.toml
COPY margin/Cargo.toml margin/Cargo.toml
COPY execution/Cargo.toml execution/Cargo.toml
COPY ledger/Cargo.toml ledger/Cargo.toml
COPY server/Cargo.toml server/Cargo.toml

COPY . .
RUN cargo build --release -p server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/trading-core-server /usr/local/bin/trading-core-server

EXPOSE 8081
CMD ["trading-core-server"]
