# Domains and HTTPS

Your apps go live right away on an automatic sslip.io address; when you want, you connect your own domain, give a server a wildcard domain, or use Cloudflare Tunnel.

## Automatic address

Every new web app gets an address like `app-x7k2.1-2-3-4.sslip.io`. sslip.io is a free DNS service that returns the IP embedded in the name, so no DNS setup is needed and the HTTPS certificate is issued automatically.

Automatic addresses are built from the server's **Public IP address** (**Servers > server > Settings**). On the app's **Domains** tab, **Generate an address** creates a new one.

Let's Encrypt applies a shared weekly certificate quota to all sslip.io users. If it runs out, new automatic addresses may not get a certificate for a while; use your own domain for production sites.

## Connecting your own domain

1. In your domain's DNS settings, create an **A record** pointing to the server's IP:

   ```text
   blog.example.com.   A   203.0.113.10
   ```

2. On the app's **Domains** tab, under **Connect a domain**, enter the domain, leave HTTPS on, and click **Add**.
3. The panel checks the record using public resolvers. When it's right, the list shows "DNS points to this server"; otherwise it tells you what the record should point to.

The certificate is issued on the first visit and renewed automatically. If the domain is behind the Cloudflare proxy (orange cloud), set Cloudflare's SSL mode to **Full (strict)** or turn the proxy off.

Apps like Django, Rails or Vite may reject unknown domains. If you fill their allowed hosts with `{{XUDBIN_DOMAINS}}`, new domains are added on every deploy (see the [FAQ](12-sss.md)).

## Wildcard apps domain

To give new apps addresses under your own domain instead of sslip.io:

1. Add a wildcard A record pointing to the server's IP: `*.apps.example.com → 203.0.113.10`.
2. On **Servers > server > Settings**, enter `apps.example.com` in **Your own domain for automatic addresses (optional)**.
3. Click **Test**; the panel checks that the wildcard record points to the server. Then click **Save**.

New apps get `app.apps.example.com`; existing addresses don't change.

## HTTPS modes

The **HTTPS** option on each server's **Settings** tab has three values:

| Mode | When |
|---|---|
| **Automatic with Let's Encrypt (recommended)** | Servers reachable from the internet |
| **Self-signed certificate (internal network, testing)** | Internal networks and testing; browsers show a warning |
| **Off, HTTP only** | When another layer provides HTTPS (e.g. Cloudflare Tunnel) |

**Certificate email** is optional; Let's Encrypt writes there about certificate problems.

## Panel domain

To open the panel on your own domain, point the domain at the server's IP, then enter it in **Panel domain** under **Settings > Panel** and click **Save**. Leave it empty to keep using the sslip.io address from setup.

## Cloudflare Tunnel

For servers without a public IP or open ports (home servers, behind NAT):

1. Create a tunnel in Cloudflare Zero Trust > Networks > Tunnels and copy its token.
2. Paste the token into the **Cloudflare Tunnel** section on **Servers > server > Settings** and click **Enable tunnel**.
3. In Cloudflare, add a "Public hostname" for each domain with service `http://xudbin-caddy:80`.
4. Cloudflare provides HTTPS, so set HTTPS on this server to **Off, HTTP only**.

The tunnel status and recent logs appear in the same section.
