# Monitoring and notifications

You check every minute that your sites are up, get alerted by email, Discord, Telegram, Slack or webhook when something goes wrong, and follow your visitors with cookie-free traffic analytics.

## Uptime monitoring

Every running web app with a domain is checked from outside every minute, using its real domain. If two checks in a row fail, a "site down" notification is sent; when it recovers, a "back up" notification follows with the outage duration.

- The **Monitoring** page shows all sites, the last 24 hours hour by hour, 7-day uptime, average response time, outages and server resources.
- The **Uptime** card on the app's **Overview** tab shows 24-hour / 30-day uptime and outage history.
- To turn monitoring off for one app: **Uptime monitoring** on the app's **Settings** tab.
- To turn it off entirely: **Uptime monitoring** under **Settings > Panel**.

If you set a **Health check path** (e.g. `/health`) in the app settings, it's used both for the deploy check and for monitoring.

## Notification channels

Under **Settings > Notifications**, click **Add channel** and choose a **Type**:

| Type | What you need |
|---|---|
| **Email** | SMTP server (e.g. `smtp.gmail.com`), port (587 or 465), username, password (an app password for Gmail), sender and comma-separated recipients |
| **Discord** | Webhook URL (Channel settings > Integrations > Webhooks) |
| **Telegram** | Bot token from @BotFather and the Chat ID |
| **Slack** | Slack incoming webhook URL |
| **Webhook** | Any URL; events are sent as a JSON POST request |

Under **For which events**, pick the events the channel receives. Use **Send test** to try the settings before saving, then click **Add**.

## Events

- Site down / Site back up
- Deploy succeeded / Deploy failed
- Critical vulnerability in image
- HTTPS certificate expiring
- Server disk or memory filling up
- Server unreachable
- Scheduled job failed
- Attacking IP banned
- Backup failed

## Traffic analytics

The **Analytics** page gives you Google Analytics-style site statistics without cookies and without adding any script to your site: data is computed from Caddy access logs on the panel's own server.

- Visitors, pageviews, bounce rate, average visit duration, bandwidth and visitors online now
- Pages, entry pages, referrers and UTM campaigns
- Countries, devices, browsers and operating systems
- 4xx/5xx error counts; bot requests aren't counted

Choose a site and a time range at the top. Day boundaries follow the **Time zone** under **Settings > Panel**.

Data stays on your server only: attack records are kept for 30 days and analytics summaries for 400 days; for visitor counting, IPs are hashed one-way with a key that changes daily. Whoever installs the panel is the data controller (GDPR). The panel sends no telemetry anywhere.
