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

With **Memory limit (MB)** and **CPU limit (cores)** you keep one app from affecting the whole server; if the limit is exceeded, only that app restarts. The memory limit is empty by default (the right value varies per app; apps without one get a warning in the security score). The number of processes is capped at 512 in every app container so a fork bomb cannot lock up the whole server.

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

## Web terminal

The **Terminal** tab on the app page opens a command line in the app's running container (`bash` if present, otherwise `sh`). Use it to run a migration, look at files or debug. For Compose apps and apps with several replicas you choose which container to connect to.

- Only **admins** and the project's **developers** can use it; viewers and API keys cannot. A terminal can read every environment variable and file in the container.
- Opening a terminal is written to the audit log; what you type and the output are not recorded.
- The terminal closes, and the shell in the container is killed, after 15 minutes without input or when you close the tab. Each user can have at most 3 terminals open at once.
- Changes you make inside the container are lost on the next deploy; anything that must persist belongs in a persistent volume.

## Shared environment variables

Variables you put in **Shared environment variables** on the project page are given to every app in that project (a shared API key, SMTP settings and so on). If an app defines its own value under the same name, the app's value wins. They are not given to PR previews, which only use their own "preview environment variables". Changes take effect when the apps are redeployed.

## Copying an app

**Copy the app** on the app's **Settings** tab creates a new app with the same settings: the source, build settings, environment variables, security settings and scheduled jobs are copied. Domains, the contents of persistent volumes, webhook keys and the "host access" approval are not copied. The copy does not run until you deploy it, and auto-deploy starts switched off.

## Server maintenance

On the server page's **Containers** tab:

- You can read the latest logs of every container.
- Containers created outside Xudbin can be started and stopped. Containers managed by Xudbin (apps, databases, Caddy) are managed from their own pages.
- **Docker disk usage** shows the space taken by images, the build cache and persistent volumes. **Clean up** only removes the build cache and dangling images; it does not touch apps, rollback images or persistent volumes. It does not run while a deploy is in progress.
