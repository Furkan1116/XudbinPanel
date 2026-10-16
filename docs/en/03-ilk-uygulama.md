# Deploy your first app

You create a project, add an app from a Git repository, uploaded files, a Docker image or a Compose file, deploy it, and fix problems with Deploy Doctor.

## 1. Create a project

Projects keep related apps and databases together. Each project has its own Docker network, so an app in one project can't reach apps or databases in another.

Click **Projects > Create project**, give it a name and click **Create**.

## 2. Add an app

On the project page click **Add app** and pick a source:

| Source | When to use it |
|---|---|
| **Git repository** | GitHub, GitLab, Gitea... For a private repo enter an **Access token**, or use **Pick from GitHub** if the [GitHub App](08-git-ve-otomatik-deploy.md) is connected. In a monorepo, put the subfolder in **Project folder** (e.g. `apps/web`). |
| **Upload files** | Drag and drop the project folder or a zip file. The `.env` file isn't uploaded; enter its values as environment variables. |
| **Docker image** | Run a ready-made image, e.g. `ghcr.io/user/app:latest`. |
| **Docker Compose** | Multiple services. The compose file comes from the repo or you paste it in. |

For ready-made apps (WordPress, Ghost, n8n...) use the **Ready-made app** button or the **Templates** page.

## 3. Framework detection

When you click **Inspect repository**, the repo is scanned and a matching framework is suggested (Django, Flask, FastAPI, Next.js, Nuxt, SvelteKit, Astro, NestJS, Laravel, Rails, ASP.NET Core, Go, Rust, Spring Boot, static sites...). If the repo has a Dockerfile, it's used; otherwise Xudbin generates one and shows it in the deploy log.

The framework card shows "what happens on deploy" and its settings (e.g. for Django, whether to run migrate on every deploy). With **Detect automatically**, the framework is picked again on every deploy.

## 4. Environment variables

In the wizard's **Settings** step and on the app's **Environment variables** tab, write one `KEY=value` per line. Values are stored encrypted.

- **Add all required** adds the variables the framework needs; values like secret keys are generated for you.
- Variables from `.env.example` and those read in your code can be added in one click with **Add all**.
- `PORT` is added automatically. `{{XUDBIN_URL}}`, `{{XUDBIN_DOMAINS}}` and `{{XUDBIN_ORIGINS}}` are filled in with the app's current domains during deploy:

```env
DJANGO_ALLOWED_HOSTS={{XUDBIN_DOMAINS}}
CSRF_TRUSTED_ORIGINS={{XUDBIN_ORIGINS}}
```

Redeploy for changes to take effect.

## 5. Deploy

Click **Create and deploy**. The live log streams on the **Deployments** tab. The new version takes over traffic once it answers a request to the real domain successfully; if it returns 400 or 5xx, the old version stays live. If the app listens on a different port than configured, the port setting is corrected automatically. A deploy that doesn't finish within 30 minutes is stopped; you can stop a running deploy with **Cancel**.

Once the app is live you'll find its automatic address on the **Overview** tab.

## Deploy Doctor

If a deploy fails or the app is misbehaving, click **Diagnose** on the **Deploy Doctor** card on the **Overview** tab. A request is sent to the real domain and the logs are scanned. Known problems (Django ALLOWED_HOSTS, CSRF, a missing secret key, database connection, migrations, a missing package or environment variable, out of memory) are explained, and where possible a one-click fix applies the change and starts a redeploy.

## Logs

The **Logs** tab shows live app logs. The search box on the same tab searches past logs from the last hour up to 14 days (e.g. `Traceback`, `500`), across all replicas and Compose services.

## Rolling back

On the **Deployments** tab, click **Roll back to this version** next to the successful deploy you want. A rollback deploy starts with that version's image. Rollback isn't available for Compose apps.

For apps created by uploading files, drop the new version onto **Upload a new version** on the **Overview** tab; it's uploaded and deployed right away.
