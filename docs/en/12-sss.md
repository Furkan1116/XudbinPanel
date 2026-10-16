# FAQ and troubleshooting

This page covers the most common problems, why they happen and how to fix them.

## My Django app returns 400 Bad Request

Django rejects requests for host names it doesn't know (`Invalid HTTP_HOST header`). Because Xudbin sends a request to the real domain before moving traffic to a new version, the deploy is marked as failed and the old version stays live.

Fix:

1. Make `settings.py` read the allowed hosts from an environment variable:

   ```python
   import os
   ALLOWED_HOSTS = os.environ["DJANGO_ALLOWED_HOSTS"].split(",")
   CSRF_TRUSTED_ORIGINS = os.environ.get("CSRF_TRUSTED_ORIGINS", "").split(",")
   ```

2. Add these on the app's **Environment variables** tab; they're filled in with the current domains on every deploy:

   ```env
   DJANGO_ALLOWED_HOSTS={{XUDBIN_DOMAINS}}
   CSRF_TRUSTED_ORIGINS={{XUDBIN_ORIGINS}}
   ```

3. Redeploy.

Shortcut: **Deploy Doctor** on the **Overview** tab recognises this error, fills in the variable your `settings.py` reads in one click and redeploys. The same approach fixes "CSRF verification failed" on form submissions. Vite, Nuxt (`allowedHosts`) and Rails (`config.hosts`) also need the domain added to their allowed hosts.

## The installer says port 80 is in use

nginx, Apache or another panel is using ports 80/443. Stop and disable that service, then run the installer again:

```bash
sudo systemctl disable --now nginx   # or apache2
```

## The app doesn't open: port problems

- The **Port** on the app's **Settings** tab must match the port the app listens on inside the container. Xudbin passes a `PORT` variable to the app; if the app listens on a single different port, the setting is corrected during deploy.
- The app must listen on `0.0.0.0`, not `127.0.0.1`; otherwise you'll see a warning in the deploy log.
- "Port already in use" (`EADDRINUSE`) usually means the start command starts the server twice.
- `ports:` in a Compose file isn't exposed to the internet; from outside only 80/443 and database ports opened in the panel are reachable. Use a domain for web traffic.

## Out of memory (exit code 137)

If the container exits with code 137, or the log shows `JavaScript heap out of memory` or `MemoryError`, the app ran out of memory.

- Raise **Memory limit (MB)** on the app's **Settings** tab, or leave it empty.
- If the build runs out of memory, use a separate **Build server** or add RAM. The installer adds 2 GB of swap on servers with less than 3 GB of RAM.
- The image scan uses about 1 GB of memory; on small servers you can turn off **Scan images after deploy** on **Security > Score**.

## The HTTPS certificate isn't issued

- The domain's A record must point to the server's IP. The **Domains** tab tells you whether DNS is right.
- Ports 80 and 443 must be open to the internet (including your hosting provider's firewall/security group).
- If the domain is behind the Cloudflare proxy, set SSL mode to **Full (strict)** or turn the proxy off.
- On automatic sslip.io addresses, Let's Encrypt's shared weekly quota may be used up; use your own domain.
- A server without a public IP can't get Let's Encrypt certificates: use **Cloudflare Tunnel** or turn HTTPS off.
- To see what's happening: `docker logs xudbin-caddy`.

## I forgot my password

Generate a temporary password on the server; you set a new one on first sign-in:

```bash
xudbin user reset-password you@example.com
```

If you lost your phone, turn off two-factor authentication:

```bash
xudbin user disable-2fa you@example.com
```

## I banned myself

```bash
xudbin unban <your-ip>
```

## I lost the setup link

```bash
xudbin link
```

## The panel won't open

```bash
xudbin status
xudbin logs
xudbin restart
```

## `./data:/data` doesn't work in Compose

Relative bind mounts aren't supported in Compose apps; use a named volume.

## Am I protected against large DDoS attacks?

The WAF and rate limits stop application-level attacks. Large volumetric (L3/L4) DDoS attacks can't be stopped at the server; you need your hosting provider's protection or a layer like Cloudflare.
