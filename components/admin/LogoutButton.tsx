"use client";

// Neither surface had any logout UI before this -- POST /api/admin/logout
// already existed and worked (clears the shared vyx_admin_session cookie),
// nothing called it. A plain <form method="POST"> would render that route's
// raw {ok:true} JSON response in place of the page, so this does a fetch +
// redirect instead.
//
// onLoggedOut defaults to next/navigation's router.push+refresh (the
// website's real behavior, navigating to a real /login route) -- kept as
// a plain callback rather than calling useRouter() directly so this
// component also works inside a bundled desktop shell (manager-shell/,
// admin-shell/), which has no `next` package to resolve that import
// against at all, and shows its own local login screen instead of
// navigating anywhere.
export function LogoutButton({
  loginHref,
  onLoggedOut,
  children,
}: {
  loginHref: string;
  onLoggedOut?: () => void;
  children: React.ReactNode;
}) {
  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    if (onLoggedOut) {
      onLoggedOut();
    } else {
      window.location.href = loginHref;
    }
  }

  return (
    <button type="button" onClick={handleLogout} title="Log out" className="shrink-0">
      {children}
    </button>
  );
}
