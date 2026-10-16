# Advanced usage

Scheduled jobs, background workers, replicas, multi-server load balancing, a separate build server and ready-made templates let you get more out of Xudbin.

## Scheduled jobs (cron)

On the app's **Scheduled jobs** tab, click **Add job**:

- **Name:** e.g. Nightly cleanup
- **When:** cron format (`minute hour day month weekday`), runs in the panel's time zone
- **Command:** e.g. `python manage.py clearsessions` or `php artisan schedule:run`
- **Timeout (min)** and **Enabled**

The command runs in a separate container from the app's latest image, with the same environment variables and persistent folders. **Run now** starts it by hand; **Output** shows each run's output, duration and exit code. All jobs are listed on the **Scheduled jobs** page, and you can be notified about failed jobs.

```text
0 3 * * *     every night at 03:00
*/15 * * * *  every 15 minutes
```

Scheduled jobs aren't supported for Compose apps; add a separate service to your Compose file instead. Change the time zone under **Settings > Panel > Time zone**.

## Background workers

For processes without a web server, like Celery, Sidekiq or `queue:work`, set **App type** to **Background worker** on the app's **Settings** tab. Workers don't get a domain and have no HTTP check on deploy. Usually you create a second app from the same repository and change its start command.

## Replicas

**Replicas** on the app's **Settings** tab can be 1–10. For web apps, Caddy spreads traffic across replicas and takes a failed one out of rotation. The change applies on the next deploy.

With **Memory limit (MB)** and **CPU limit (cores)** you keep one app from affecting the whole server; if the limit is exceeded, only that app restarts.

## Multi-server load balancing

Pick additional servers in **Extra servers (load balancing)** on the app's **Settings** tab. The app also runs on those servers; visitors arrive at the main server and requests are spread across all copies, skipping unreachable servers. Traffic between servers is encrypted with TLS. The setting applies on the next deploy.

Limits:

- It's meant for stateless apps. Apps with persistent folders and Compose apps can't be distributed.
- Copies on extra servers can't reach databases on the main server's internal network. Expose the database externally and use that address.
- Visitors always arrive at the main server; if it goes down, the site is unreachable. DNS-level redundancy is out of scope.

## Separate build server

So heavy builds don't slow down live apps, choose a **Build server** on the app's **Settings** tab (shown for Git and upload apps when you have more than one ready server). The build runs there and the finished image is transferred to the app's server. Both servers must share the same CPU architecture (e.g. both amd64).

## Templates

Install ready-made apps in one click from the **Templates** page: WordPress, Ghost, n8n, Uptime Kuma, Vaultwarden, Gitea, Nextcloud, Metabase, NocoDB, Adminer, Matomo, Directus, Grafana and listmonk.

1. Pick a template.
2. Choose the **Project**, **Name** and **Server**.
3. Click **Install**.

Passwords are generated, and the domain and HTTPS come ready. Generated values are visible on the app's **Environment variables** tab; you can change everything after installing.
