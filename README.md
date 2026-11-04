# MiyeeFit Pro

**Personal Fitness, Weight Reduction & Pure Vegetarian Nutrition Tracker** — engineered by [Miyee Tech Labs](https://miyeetechlabs.com).

A single self-contained `index.html` (Tailwind CSS, Chart.js and Font Awesome from CDN). It has no build step and runs entirely in the browser. All data is stored in `localStorage` under the key `miyeefit_pro_v1`. You can optionally sync it to your own Cloudflare Worker + KV.

## Modules
- **Executive Dashboard**: date switcher; step, water, calorie-balance and weight KPI cards; weight trend vs target trajectory; intake vs burn chart; macro doughnut.
- **Daily Tracker**: 68-item pure-veg food database (Jain and Low-GI tags), custom veg foods (non-veg names are rejected), MET-based cardio logger with manual override, biometric check-in (weight, waist, sleep, energy).
- **Scope of Improvement**: Daily Fitness Score (0–100) built from 7 audits: calorie deficit, protein, hydration, steps, cardio, weight plateau and recovery. Each audit gives actionable fixes.
- **Veg Diet Planner**: 4 templates (High-Protein Indian, Low-GI, Working Professional, Jain). Each scales to your calorie target and has meal swaps, 1-click apply, and a protein/fiber cheat sheet.
- **Profile & Biometrics**: BMI (WHO and Asian cut-offs), Mifflin-St Jeor BMR, TDEE, calorie and macro targets, goal date.
- **Data Vault & Sync**: storage stats, Cloudflare push/pull/auto-sync, `worker.js` viewer, JSON backup/restore, CSV report, 14-day demo data, factory reset.

## Deploy
- **Cloudflare Pages:** create a project, upload this folder (or connect the repo), and use no build command with `/` as the output directory.
- **Cloud sync:** open *Data Vault → View Worker Script* and follow the 5 steps. You need a KV binding named `MIYEEFIT_VAULT` and a secret named `SYNC_TOKEN`.
