//! Synthetic symbols for the shadow-bot tenant (owner decision 2026-09-28).
//!
//! A synthetic symbol's name starts with the reserved prefix [`SYNTH_PREFIX`] ("v", lowercase, CASE-SENSITIVE): e.g.
//! `vGOLD`, `vEUR`. Its prices come ONLY from the dedicated `/internal/synth-feed` route (its own secret), never from
//! the MT5 feed, and the real ingest drops any tick with this prefix. The web holds the same constant in
//! `lib/synthetic-symbols.ts` (`SYNTH_PREFIX`); `lib/synthetic-symbols.test.ts` fails if the two ever differ.
//!
//! Why case-sensitive lowercase: real instrument names are upper case (the MT5 feed's names, every Symbol row), and
//! real upper-case "V..." names exist in the market (VIX, VOD, ...). A case-insensitive rule would reserve those too
//! and could drop a real price; the lowercase-only rule reserves nothing a real feed sends.

/// The one reserved prefix (Rust side). Matched with `starts_with` only -- never a suffix or substring match.
pub const SYNTH_PREFIX: &str = "v";

/// A synthetic symbol: the name starts with [`SYNTH_PREFIX`] (case-sensitive, leading only).
pub fn is_synthetic(symbol: &str) -> bool {
    symbol.starts_with(SYNTH_PREFIX)
}

/// Constant-time equality for the synth feed secret: the time taken does not depend on where the first differing
/// byte is. (Lengths are compared first; the secret's length is not a secret.)
pub fn secret_eq(provided: &str, expected: &str) -> bool {
    let (a, b) = (provided.as_bytes(), expected.as_bytes());
    if a.len() != b.len() || b.is_empty() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_leading_lowercase_v_is_synthetic() {
        for s in ["vGOLD", "vEUR", "vGBP", "vJPY", "vIDX"] {
            assert!(is_synthetic(s), "{s}");
        }
        // upper-case V, a v inside or at the end, and every real name: not synthetic
        for s in ["VIX", "VOD", "XAUUSD", "EURUSD", "US30", "BTCUSD", "XAUUSDv", "EURvUSD", "", " vGOLD"] {
            assert!(!is_synthetic(s), "{s:?}");
        }
    }

    #[test]
    fn synthetic_symbols_trade_through_the_weekend_real_ones_do_not() {
        use chrono::{TimeZone, Utc};
        let saturday_noon = Utc.with_ymd_and_hms(2026, 10, 3, 12, 0, 0).unwrap();
        assert!(crate::gap_fill::market_open("vGOLD", saturday_noon));
        assert!(crate::gap_fill::market_open("vIDX", saturday_noon));
        assert!(!crate::gap_fill::market_open("VIX", saturday_noon));
        assert!(!crate::gap_fill::market_open("XAUUSD", saturday_noon));
        // no daily metals break for vGOLD either (the break list is by exact real name)
        let ny_break = Utc.with_ymd_and_hms(2026, 9, 29, 21, 30, 0).unwrap();
        assert!(crate::gap_fill::market_open("vGOLD", ny_break));
    }

    #[test]
    fn secret_compare_is_exact() {
        assert!(secret_eq("abc123", "abc123"));
        assert!(!secret_eq("abc124", "abc123"));
        assert!(!secret_eq("abc12", "abc123"));
        assert!(!secret_eq("", ""));
        assert!(!secret_eq("x", ""));
    }
}
