"use client";

import { useRouter } from "next/navigation";

// Neither surface had any logout UI before this -- POST /api/admin/logout
// already existed and worked (clears the shared vyx_admin_session cookie),
// nothing called it. A plain <form method="POST"> would render that route's
// raw {ok:true} JSON response in place of the page, so this does a fetch +
// client-side redirect instead.
export function LogoutButton({ loginHref, children }: { loginHref: string; children: React.ReactNode }) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push(loginHref);
    router.refresh();
  }

  return (
    <button type="button" onClick={handleLogout} title="Log out" className="shrink-0">
      {children}
    </button>
  );
}
