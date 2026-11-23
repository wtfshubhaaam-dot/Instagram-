# GlassPost: Instagram Scheduler

A production-oriented Instagram scheduler: one Node.js server file plus plain HTML, CSS and JavaScript, styled with the Glassy UI stylesheet and WebGL glass renderer (MIT). It publishes photos and Reels through the official Instagram API (Instagram Login) at the time you choose.

## 1. Architecture

| Concern | Choice | Why |
| --- | --- | --- |
| Web app and API | Single Node.js file (`server.mjs`, no framework, no build step) in a Docker image on Koyeb | Small image, fast deploys, fits the free web service |
| Database | External PostgreSQL (Neon free plan recommended) | Koyeb's free Postgres includes only 5 compute-hours per month, which a per-minute scheduler would exhaust |
| Media storage | Cloudflare R2 (public bucket on your domain) | Instagram must download media from a public HTTPS URL; Koyeb's free plan has no persistent volumes |
| Scheduler | `GET /api/cron/tick` called every minute by an external pinger | Koyeb's free instance sleeps after one hour without traffic and cannot run a background worker |
| Auth | Instagram Business Login, signed HttpOnly session cookie | No extra auth service |
| Secrets | Tokens encrypted with AES-256-GCM before storage | Limits impact of a database leak |

Publishing flow per post: create media container, check its status, publish, store the permalink. Temporary errors are retried up to three times with backoff; permanent errors are shown in the dashboard.

### File layout (flat, no sub-folders)

| File | Purpose |
| --- | --- |
| `server.mjs` | HTTP server, Instagram OAuth, API routes, scheduler, R2 uploads |
| `index.html`, `dashboard.html` | Landing page and scheduler dashboard |
| `privacy.html`, `terms.html`, `data-deletion.html` | Pages Meta requires |
| `site.js`, `app.js` | Shared UI script and page logic |
| `glassy-scene.js` | The real Glassy UI WebGL glass renderer (MIT), merged into one framework-free file |
| `glass.css`, `site.css` | Glassy UI stylesheet and site tokens |
| `vermilion-*.svg` | Wallpapers |
| `package.json`, `Dockerfile`, `.env.example` | Runtime and deployment |
| `META-APPROVAL.md` | Meta approval checklist, review text, screencast script and suspension-prevention rules |

## 2. Prerequisites

- A GitHub account (the repository Koyeb deploys from).
- Your domain, with access to its DNS records.
- A Koyeb account (free plan).
- A free Neon account and a free Cloudflare account (R2 requires a payment method on file; the free allowance is generous).
- An Instagram **Professional** account (Business or Creator). Personal accounts cannot publish through the API.

## 3. Set up services

### 3.1 PostgreSQL (Neon)
Create a project and copy the pooled connection string into `DATABASE_URL`. Tables are created automatically on first request.

### 3.2 Media storage (Cloudflare R2)
1. Create a bucket, for example `glasspost-media`.
2. Under **Settings > Custom Domains**, attach `media.yourdomain.com`. Use this as `R2_PUBLIC_BASE_URL`.
3. Create an **API token** with *Object Read & Write* on that bucket. Copy the Account ID, Access Key ID and Secret.
4. Under **Settings > CORS policy**, add:
```json
[{
  "AllowedOrigins": ["https://app.yourdomain.com"],
  "AllowedMethods": ["PUT"],
  "AllowedHeaders": ["Content-Type"],
  "MaxAgeSeconds": 3600
}]
```
5. Optional: add a lifecycle rule to delete objects older than 90 days.

### 3.3 Secrets
Generate three values and keep them private:
```bash
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # CRON_SECRET
```
Do not rotate `ENCRYPTION_KEY` without re-connecting accounts, because stored tokens would become unreadable.

## 4. Create the Meta (Facebook) developer app

1. Go to https://developers.facebook.com, **My Apps > Create App**, choose the **Business** type (or "Other" then Business), and give it a name that does not include Instagram trademarks.
2. Add the product **Instagram** and select **API setup with Instagram login**.
3. Copy the **Instagram app ID** and **Instagram app secret** into `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET`. These differ from the Facebook app ID and secret.
4. Under **Business login settings**, set:
   - **OAuth redirect URI:** `https://app.yourdomain.com/api/auth/instagram/callback` (must match `APP_URL` exactly)
   - **Deauthorize callback URL:** `https://app.yourdomain.com/api/meta/deauthorize`
   - **Data deletion request URL:** `https://app.yourdomain.com/api/meta/data-deletion`
5. Under **App settings > Basic**, add the **Privacy Policy URL** (`/privacy`), **Terms of Service URL** (`/terms`), app icon, category, and contact email.
6. **Development mode testing:** under **App roles**, add your Instagram account as an Instagram Tester (accept the invite in Instagram under *Settings > Apps and websites > Tester invites*). Roles can use every permission without review while the app is in Development mode.

### Taking the app live (production)
Public users require the app to be **Live**, which requires:
1. **Business Verification** of the business connected to the app (Meta Business Settings > Security Center).
2. **App Review** with Advanced Access for `instagram_business_basic` and `instagram_business_content_publish`. Provide a screen recording showing: connecting an account, uploading media, scheduling, and the post appearing on Instagram. Provide a test Instagram account and explain each permission.
3. Switch the **App mode** toggle to **Live** after approval.

Review timelines and requirements are set by Meta and change over time; check the current Instagram Platform documentation before submitting.

## 5. Deploy to Koyeb

1. Push this project to a GitHub repository (files at the repository root). Run `npm install` locally once and commit the generated `package-lock.json`. Before deploying, replace `privacy@your-domain.com` in `privacy.html` and `data-deletion.html` with your real contact address.
2. In Koyeb, **Create Service > Web Service > GitHub**, select the repository, and set the builder to **Dockerfile**.
3. Instance: **Free**. Exposed port: **8000** (HTTP). Health check path: `/api/health`.
4. Add environment variables from `.env.example`. Mark secrets as secrets.
5. Deploy. Koyeb gives you a `*.koyeb.app` address.

### Custom domain
1. In the Koyeb service, open **Settings > Domains > Add domain** and enter `app.yourdomain.com`.
2. At your DNS provider, create the **CNAME** record Koyeb displays. Using a subdomain is strongly recommended; an apex domain needs ALIAS/ANAME or CNAME flattening support.
3. Wait for verification. HTTPS is issued automatically.
4. Set `APP_URL=https://app.yourdomain.com`, redeploy, and update the Meta redirect URIs from section 4.

## 6. Start the scheduler

Publishing happens only when `/api/cron/tick` is called. Create a free job at https://cron-job.org (or any monitor that supports custom headers):

- URL: `https://app.yourdomain.com/api/cron/tick`
- Schedule: every 1 minute
- Header: `Authorization: Bearer <CRON_SECRET>`

Each call also wakes the instance if it has gone to sleep. Verify with:
```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" https://app.yourdomain.com/api/cron/tick
```

## 7. Go-live checklist

- [ ] `/api/health` returns `{"status":"ok"}` on your domain
- [ ] Instagram sign-in completes and `/dashboard` loads
- [ ] A test photo schedules 2 minutes ahead and publishes
- [ ] A test Reel publishes (processing can take several minutes)
- [ ] Meta callbacks respond (use the app dashboard's test tools)
- [ ] Privacy, Terms and Data deletion pages are reachable
- [ ] Meta Business Verification and App Review approved, app set to Live
- [ ] `.env` is not committed

## 8. Free-plan limitations

- The free instance scales to zero after one hour with no traffic. The one-minute pinger keeps it warm; a cold start takes a few seconds.
- A single small instance (shared CPU, 512 MB) is enough for personal or small-team use. Upgrade the instance type before onboarding many accounts.
- Free-tier terms (credit card requirements, allowances) have changed during 2026. Confirm the current terms on Koyeb's pricing page.
- Instagram supports **JPEG** images only. Reels use MP4 or MOV.
- Meta limits API publishing per account in a rolling 24 hours. The app enforces a conservative limit of 50.
- The glass refraction uses WebGL2. Browsers without it, and users who enable reduced transparency, automatically get the CSS glass instead.
- Not included in this version: carousels, Stories, first-comment automation, and teams. The data model allows adding them.

## 9. Local development

```bash
cp .env.example .env
npm install
node --env-file=.env server.mjs
```
Instagram OAuth requires a public HTTPS redirect URI, so use a tunnel (for example Cloudflare Tunnel) as `APP_URL` when testing sign-in locally.

## 10. Licenses and branding

- `glass.css` and the design tokens in `site.css` come from Glassy UI, MIT licensed. See `LICENSE-GLASSYUI`.
- The Instagram glyph is used only to identify the Instagram connection. Follow Meta's brand guidelines, and do not imply endorsement.
