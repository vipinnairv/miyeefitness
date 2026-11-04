# MiyeeFit Pro

**Personal Fitness, Weight Reduction & Pure Vegetarian Nutrition Tracker** — engineered by [Miyee Tech Labs](https://miyeetechlabs.com).

The whole app is a single `index.html` (Tailwind CSS, Chart.js and Font Awesome from CDN). A small Cloudflare Worker serves it and adds **user accounts with cloud-saved data**.

## Modules
- **Executive Dashboard**: step, water, calorie-balance and weight KPI cards; weight trend, intake vs burn, and macro charts.
- **Daily Tracker**: 68-item pure-veg food database (Jain and Low-GI tags), custom veg foods, MET-based cardio logger, biometric check-in.
- **Scope of Improvement**: Daily Fitness Score (0–100) from 7 audits, each with actionable fixes.
- **Veg Diet Planner**: 4 templates scaled to your calorie target, meal swaps, 1-click apply, protein/fiber cheat sheet.
- **Profile & Biometrics**: BMI (WHO and Asian cut-offs), Mifflin-St Jeor BMR, TDEE, calorie and macro targets, goal date.
- **Data Vault & Cloud Account**: sign in / create account, automatic cloud saving, JSON backup/restore, CSV report, demo data, reset.

## Accounts & cloud sync
- Sign up with name, email and password. Passwords are hashed with PBKDF2-SHA256 (100k iterations), and sessions last 30 days.
- Every change is saved locally first, then pushed to the cloud about 1.5 s later. It works offline and syncs again when the connection is back.
- Other devices pick up changes when the app is reopened or refocused. Simultaneous edits are merged rather than overwritten.
- You can continue without an account; data then stays in that browser only.
- The account panel offers change password, sign out (optionally wiping the device) and delete account.

## Deployment (Cloudflare Workers, via Git)
`wrangler.jsonc` defines the Worker `miyeefitness`:
- `worker/index.js` handles `/api/*`. Every other request is served from the static assets; `.assetsignore` makes sure only `index.html` is published.
- KV binding `MIYEEFIT_KV`. The namespace is created automatically on the first `wrangler deploy`.

Cloudflare Workers Builds deploys on every push to `main` (build command: none; deploy command: `npx wrangler deploy`).

Local development: `npx wrangler dev`, then open http://localhost:8787.

Static copies (e.g. GitHub Pages) still work fully, in local-only mode without sign-in.
