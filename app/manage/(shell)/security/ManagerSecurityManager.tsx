"use client";

import AdminSessionsCard from "@/components/admin/AdminSessionsCard";

// Sessions only for now -- 2FA (app/api/admin/two-factor/*) is currently
// gated SUPER_ADMIN-only (see that route's own requireAdminRole check),
// so a 2FA section here would just 403 for every Manager/BROKER_ADMIN/
// SUPPORT user. Extending 2FA to broker-scoped admin roles is Phase 1 §1's
// own scope, not silently bundled into this (§2, sessions).
export default function ManagerSecurityManager({ onLoggedOut }: { onLoggedOut?: () => void } = {}) {
  return <AdminSessionsCard loginHref="/manage/login" onLoggedOut={onLoggedOut} />;
}
