// Shadows the repo root's postcss.config.mjs (Tailwind, for the Next.js
// app) so Vite doesn't walk up and pick that one up for this project --
// webtrader.css is plain CSS, no PostCSS transforms needed here.
export default { plugins: {} };
