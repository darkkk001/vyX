import Link from "next/link";

// VYX-BASICS-AUDIT.md category 4 -- global App Router catch-all
// (app/broker-not-found/page.tsx is a different, narrower thing: a
// specific "no broker resolved for this subdomain" case middleware.ts
// redirects to, still completely unstyled today -- left as-is, a
// separate followup, not this checkbox). Every unmatched route in the
// app used to fall through to Next.js's own default error page (plain
// black-on-white "404 | This page could not be found").
//
// Deliberately self-contained (literal hex, not var(--bg-0) etc.) rather
// than reusing app/admin-theme.css's tokens -- those are scoped to
// [data-surface="manager"|"super-admin"] set by the manage/super-admin
// layouts, and this page can render for ANY unmatched URL in the app,
// including ones with no such wrapper at all (a bad link on the public
// broker-facing trade/launch routes). The hex values below are copied
// from admin-theme.css's own manager palette so a 404 under /manage/*
// still looks visually consistent with the shell around it.
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[#07090c] px-4 text-center">
      <p className="font-mono text-[13px] tracking-[0.2em] text-[#5a6472]">ERROR 404</p>
      <h1 className="text-2xl font-semibold text-[#edeff2]">Page not found</h1>
      <p className="max-w-sm text-sm leading-[1.5] text-[#8b93a1]">
        The page you&apos;re looking for doesn&apos;t exist, or you may not have access to it.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-lg bg-[#16c784] px-4 py-2 text-sm font-medium text-[#03150c] transition-opacity hover:opacity-90"
      >
        Go to homepage
      </Link>
    </main>
  );
}
