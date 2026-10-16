# Introduction

Xudbin is an open-source, self-hosted panel that lets you run your apps, databases and servers from a single web interface on your own machine.

## What is Xudbin?

Xudbin is inspired by self-hosted panels like Dokploy and Coolify. You give it a Git repository, an uploaded folder, a Docker image or a Docker Compose file; it builds it, runs it, puts it behind an address and gets an HTTPS certificate. Besides the server the panel runs on, you can manage as many remote servers as you like over SSH.

Source code: [github.com/Furkan1116/XudbinPanel](https://github.com/Furkan1116/XudbinPanel) (MIT license). These docs describe version 1.3.0.

## What makes it different

- **An address without buying a domain.** Every app automatically gets an address like `app-x7k2.1-2-3-4.sslip.io`. No DNS setup is needed; the server's IP is embedded in the address.
- **Automatic HTTPS.** Caddy issues and renews Let's Encrypt certificates for both automatic addresses and your own domains.
- **Built-in attack protection.** Every app has a WAF (Coraza + OWASP Core Rule Set), per-IP rate limiting and security headers turned on by default. IPs that get blocked too often are banned automatically on every server, and you can watch attacks live on the **Security** page.
- **Deploy Doctor.** When a deploy fails, it explains known errors in the logs (Django ALLOWED_HOSTS, a missing secret key, database connection, out of memory...) and fixes the ones it can in one click.
- **Zero-downtime deploys.** Traffic stays on the old version until the new one answers a request to the real domain successfully.

## What you can do

- Deploy from Git, uploaded files, a Docker image or Compose; deploy frameworks like Django, Next.js, Laravel, Rails, Go and Spring Boot without writing a Dockerfile
- Run PostgreSQL, MySQL, MariaDB, MongoDB and Redis with scheduled, verified backups
- Uptime monitoring, cookie-free traffic analytics, and notifications via email, Discord, Telegram and Slack
- Add teammates to projects with roles, sign in with SSO, and use API keys and the `xb` command-line tool

The interface is available in Turkish and English, with light and dark themes.

## Requirements

- A Linux server running Ubuntu, Debian or AlmaLinux/Rocky
- At least 2 GB of RAM (with less than 3 GB the installer adds 2 GB of swap; the post-deploy image scan uses about 1 GB of memory)
- Ports 80 and 443 free (stop nginx, Apache or any other web server first)
- Root access (`sudo`)
- For automatic HTTPS, a public IP reachable from the internet. Servers without one can use [Cloudflare Tunnel](04-alan-adi-ve-https.md) or install with HTTPS turned off.

Next: [Installation](02-kurulum.md).
