// Shadows the repo root's postcss.config.mjs so Vite doesn't walk up and
// pick that one up for this project -- Tailwind here is handled entirely
// by the @tailwindcss/vite plugin (vite.config.ts), not PostCSS. Same
// fix as desktop-tauri/webtrader-shell/postcss.config.mjs, which hit
// this for real (a 500 error trying to resolve the root config's
// @tailwindcss/postcss plugin instance).
export default { plugins: {} };
