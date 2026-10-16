# Security

You protect your apps with a WAF, rate limits and IP lists, watch attacks, close gaps in the security score in one click, and secure your panel account with two-factor authentication.

## Per-app protection

The app's **Security** tab has these settings; click **Save and apply** after changing them:

- **Web application firewall (WAF):** blocks SQL injection, XSS, path traversal and malicious scanners with the OWASP Core Rule Set. On for new apps.
- **Rate limit:** how many requests per minute one IP may send. Default: 600 requests / minute / IP.
- **Security headers:** adds headers against clickjacking and MIME sniffing and hides server details.
- **Password protection:** asks for a username and password (at least 8 characters) to open the site. Handy for staging.
- **Allow only these IPs:** empty means everyone. One IP or CIDR per line (e.g. `10.0.0.0/8`).
- **Block these IPs:** IPs to block for this app.

## Attack dashboard and IP bans

The **Security** page (admins only) reads Caddy logs from every server every 20 seconds:

- **Attacks:** a timeline of blocked requests, the most blocked IPs, and the most targeted paths and sites. Click **Ban** next to an IP to ban it immediately.
- **Events:** WAF, rate limit, banned IP, IP rule, wrong password and panel sign-in events.
- **Banned IPs:** use **Ban IP** to ban an IP or CIDR, optionally for a limited time; **Unban** removes it. Banned IPs can't reach any app on any server, or the panel.

**Automatic ban** is on by default: an IP with 30 blocked requests within 10 minutes is banned on every server for 24 hours. You can change these values on the same tab.

If you banned yourself by accident, run on the server:

```bash
xudbin unban 203.0.113.7
```

## Security score

The **Security > Score** tab lists checks for the panel, servers and apps: 2FA for admins, panel backup, backups stored off the server, database backups, firewall, fail2ban, Docker ports bound to the firewall, SSH settings, automatic security updates, WAF, rate limit, memory limit, webhook signature, debug mode and critical vulnerabilities in images.

Checks that can be fixed automatically have a one-click button next to them: turning on the WAF or security headers, limiting the app to 600 requests per minute, turning on automatic updates, applying the Docker firewall rules, or turning off `DEBUG` and redeploying. The others link to the setting you need to change. **Re-check** runs the checks again.

## Image scanning

When **Scan images after deploy** (on **Security > Score**) is on, the image is scanned with Trivy for known vulnerabilities (CVEs) after every successful deploy (it uses about 1 GB of memory while scanning). Results appear on the **Security scan** card on the app's **Overview** tab:

- Vulnerabilities are split into **Base image** and **App** dependencies.
- **What should you do?** tells you step by step what to do (update the base image, upgrade a specific package...).
- **Scan** / **Rescan** starts a scan by hand.

## Server firewall

The installer opens only SSH, 80 and 443 in the firewall and installs fail2ban (5 failed SSH logins in 10 minutes means a 1-hour ban). Docker is also prevented from bypassing the firewall: from outside, containers can only be reached on 80/443 and on database ports you open in the panel.

You can see each server's state in the **Server security** section of **Servers > server > Status**; **Harden** sets up the firewall and fail2ban.

## Panel account and 2FA

On **Settings > Account**:

- Under **Two-factor authentication**, click **Turn on**, scan the QR code with an app like Google Authenticator, 1Password or Bitwarden, enter the 6-digit code and click **Verify and turn on**.
- Under **Active sessions** you can end sessions on other devices.

A panel admin effectively has root on your servers, so always turn on 2FA for admin accounts. If you lose your phone, run `xudbin user disable-2fa <email>` on the server.

If you find a security vulnerability, don't open a public issue; use **Security > Report a vulnerability** on GitHub.
