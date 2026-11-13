//! WHICH BROKERS THIS ENGINE SERVES (productization step 1, owner 2026-11-13).
//!
//! Today one engine serves every broker the database marks RUST-owned: the risk sweep reads positions
//! across all of them and the authority cache loads all of them. The target shape is one private
//! engine per broker (Frankfurt serves these, Singapore serves those), so the engine has to know which
//! brokers are ITS brokers. That assignment will come from the control database; for now it comes from
//! configuration, and it lives here so the move to the control DB changes one function and nothing else.
//!
//! SCOPE. This governs the RISK half only -- which accounts the engine evaluates and acts on. The ORDER
//! half is scoped separately and by account, in `ingress`, and the two are deliberately not merged: an
//! engine can be assigned a broker whose accounts are not yet allowed to place orders through it, which
//! is exactly the state every cutover wave passes through.
//!
//! UNSET OR EMPTY MEANS EVERY BROKER THE DATABASE ALREADY GIVES THIS ENGINE -- today's behaviour,
//! exactly. That is what makes this change provably inert: with no assignment installed, the two
//! queries it touches are built from the SAME STRING they are built from today, with no bound
//! parameter, so the planner sees the same statement and returns the same rows in the same order.
//! `authority::tests` asserts that string equality directly, and the DB parity test asserts the
//! resulting rows are identical both with no assignment and with the assignment set to every broker
//! currently present.
//!
//! A NOTE ON "FAIL-CLOSED", because the word points two ways here. This default is closed against
//! CHANGING BEHAVIOUR, which is the only risk while the feature is dormant: an engine with no
//! assignment does exactly what it does today. It is NOT closed against serving a broker -- an engine
//! with no assignment serves all of them. Once assignments are authoritative in the control DB the safe
//! default inverts: an engine that cannot READ its assignment should serve nothing rather than
//! everything. That decision belongs at the call site that reads the control DB, not here -- the same
//! way `ingress` treats "no list" as unrestricted while `main.rs` is what refuses to run production in
//! that state.
//!
//! Installed once at start-up, before the listener binds and before the first risk pass, for the same
//! reason `ingress::restrict_to` and `db::use_prisma_book()` are: no evaluation may run before the rule
//! that governs its scope is in place.

use std::sync::RwLock;

/// None = no assignment installed, which means every broker the queries already return (today).
/// Some(list) = only these broker ids. An EMPTY list collapses to None -- see `assign_to`.
static ASSIGNED: RwLock<Option<Vec<String>>> = RwLock::new(None);

/// Assign this engine to `broker_ids`.
///
/// AN EMPTY LIST IS NOT "NO BROKERS" HERE, unlike `ingress`'s empty list which means "nobody". It
/// collapses to no assignment at all, i.e. today's behaviour. The difference is deliberate and it is
/// the whole point of the dormant state: "serve no broker" is not a configuration anyone needs yet,
/// whereas "this build carries the feature and behaves exactly as before" is the configuration
/// production runs for as long as it takes to trust it. Making empty mean "nothing" would turn an unset
/// variable into an engine that silently stops evaluating risk, which is the worst outcome available.
pub fn assign_to(broker_ids: Vec<String>) {
    let next = if broker_ids.is_empty() { None } else { Some(broker_ids) };
    *ASSIGNED.write().unwrap_or_else(|p| p.into_inner()) = next;
}

/// SERVE NO BROKER AT ALL -- a third state, distinct from both of the others.
///
/// The control plane needs it (owner 2026-11-13): a PLANNED or RETIRED engine serves nothing, and an
/// engine that has been out of contact with the control plane for longer than its grace serves
/// nothing. That is NOT "no assignment", which means today's behaviour and serves EVERYTHING -- the two
/// are opposites, and confusing them is the difference between an engine that stands down and an engine
/// that quietly takes over every broker.
///
/// The mechanism costs nothing: an empty list in `= ANY($1)` already matches no row. What this adds is
/// the INTENT. `assign_to(vec![])` deliberately collapses to no-assignment, so that an unset variable
/// can never stop an engine by accident; "serve nothing" therefore has to be asked for by name, and
/// the name is what makes a reader of the call site see which of the two was meant.
pub fn serve_nothing() {
    *ASSIGNED.write().unwrap_or_else(|p| p.into_inner()) = Some(Vec::new());
}

/// Is the engine serving no broker ON PURPOSE, as opposed to having no assignment at all?
pub fn is_serving_nothing() -> bool {
    matches!(&*ASSIGNED.read().unwrap_or_else(|p| p.into_inner()), Some(v) if v.is_empty())
}

/// Forget any assignment. Tests only -- production installs once and never changes it.
pub fn clear() {
    *ASSIGNED.write().unwrap_or_else(|p| p.into_inner()) = None;
}

/// The installed assignment, if any. `None` is the inert state.
pub fn assigned() -> Option<Vec<String>> {
    ASSIGNED.read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Is an assignment installed at all?
pub fn is_assigned() -> bool {
    ASSIGNED.read().unwrap_or_else(|p| p.into_inner()).is_some()
}

/// The operator's spelling, same shape as `ingress::parse_list`: comma-separated, trimmed, blanks
/// dropped. Kept separate rather than shared because the two lists hold different things (broker ids
/// and account ids) and one day come from different places -- this one from the control DB.
pub fn parse_list(raw: &str) -> Vec<String> {
    raw.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
}

/// The predicate to append to a sweep, as ` AND <qualified> = ANY($<param>)`.
///
/// EMPTY STRING WHEN NOTHING IS ASSIGNED, and that is the whole proof obligation: appending an empty
/// string leaves the statement byte-identical and parameter-free, so there is no second code path to
/// reason about and nothing for the planner to treat differently. Every scoped site below builds its
/// SQL through a pure function so a test can assert that equality on the real statement.
///
/// `qualified` is the column as the query spells it (`a."brokerId"`, `id`, `"brokerId"`), and `param`
/// is the next free placeholder number -- it is NOT always 1, because some of these queries already
/// bind one (`outbox::due_ids` binds its limit as $1).
///
/// THE IDS ARE BOUND, NEVER FORMATTED IN. They come from configuration today and from another database
/// tomorrow; interpolating them would be both an injection and a quoting bug.
pub fn filter_sql(scope: Option<&[String]>, qualified: &str, param: usize) -> String {
    match scope {
        None => String::new(),
        Some(_) => format!(" AND {qualified} = ANY(${param})"),
    }
}

/// `filter_sql` for a statement that has NO `WHERE` clause of its own yet, so the predicate has to
/// open one. Separate function rather than a boolean or a string rewrite: which one a site needs is a
/// property of that site's SQL, visible at the call, and getting it wrong is a syntax error rather
/// than something subtle.
pub fn where_sql(scope: Option<&[String]>, qualified: &str, param: usize) -> String {
    match scope {
        None => String::new(),
        Some(_) => format!(" WHERE {qualified} = ANY(${param})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_parses_the_way_an_operator_would_write_it() {
        assert_eq!(parse_list("b1,b2"), vec!["b1", "b2"]);
        assert_eq!(parse_list(" b1 , b2 ,"), vec!["b1", "b2"]);
        assert_eq!(parse_list(""), Vec::<String>::new());
        assert_eq!(parse_list("  ,  "), Vec::<String>::new());
        assert_eq!(parse_list("one"), vec!["one"]);
    }

    #[test]
    fn an_empty_assignment_is_no_assignment_not_an_empty_scope() {
        // The distinction that keeps an unset variable from stopping risk evaluation altogether.
        assign_to(Vec::new());
        assert!(!is_assigned(), "an empty list must collapse to no assignment");
        assert_eq!(assigned(), None);
        clear();
    }

    #[test]
    fn the_filter_is_an_empty_string_when_nothing_is_assigned() {
        // The byte-same property in its smallest form. Each scoped site asserts it again on its own
        // whole statement, which is what actually reaches the database.
        assert_eq!(filter_sql(None, r#"a."brokerId""#, 1), "");
        assert_eq!(filter_sql(None, "id", 1), "");
        assert_eq!(filter_sql(None, r#""brokerId""#, 2), "");
    }

    #[test]
    fn the_filter_binds_at_the_placeholder_it_is_given() {
        let one = vec!["b1".to_string()];
        assert_eq!(filter_sql(Some(&one), r#"a."brokerId""#, 1), r#" AND a."brokerId" = ANY($1)"#);
        assert_eq!(filter_sql(Some(&one), "id", 1), " AND id = ANY($1)");
        // outbox::due_ids already binds its limit as $1, so its broker filter is $2
        assert_eq!(filter_sql(Some(&one), r#""brokerId""#, 2), r#" AND "brokerId" = ANY($2)"#);
    }

    #[test]
    fn the_filter_never_interpolates_an_id() {
        let ids = vec!["b1'; DROP TABLE \"Broker\"; --".to_string()];
        let sql = filter_sql(Some(&ids), r#"a."brokerId""#, 1);
        assert!(!sql.contains("DROP"), "ids must be bound, not formatted in: {sql}");
        assert!(sql.contains("$1"));
    }
}
