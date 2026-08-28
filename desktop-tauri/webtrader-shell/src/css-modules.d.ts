// TradeLoginForm.tsx imports a *.module.css file -- Vite already handles
// CSS Modules at build time (same convention Next.js uses), but tsc has
// no ambient type for that specifier without this declaration, since this
// project's tsconfig doesn't pull in next-env.d.ts (a Next.js-specific
// file, not portable to a bare Vite app).
declare module "*.module.css" {
  const classes: { [key: string]: string };
  export default classes;
}
