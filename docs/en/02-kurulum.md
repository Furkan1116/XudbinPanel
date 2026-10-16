# Installation

You install Xudbin on your server with one command, create the admin account with the setup link, and manage the panel with the `xudbin` command on the server.

## Requirements

- Ubuntu, Debian or AlmaLinux/Rocky; at least 2 GB of RAM
- Ports 80 and 443 must be free
- Root access

## One-command install

```bash
curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/install.sh | sudo bash
```

The script shows every step in the terminal:

1. Checks the system; adds 2 GB of swap if RAM is under 3 GB.
2. Installs Docker if it's missing.
3. Downloads Xudbin to `/opt/xudbin` and installs the `xudbin` command.
4. Opens only SSH, 80 and 443 in the firewall and installs fail2ban for SSH.
5. Pulls the prebuilt image (`ghcr.io/furkan1116/xudbin`); if it can't, builds from source.
6. Generates a panel address from the server's IP, like `xudbin.1-2-3-4.sslip.io`, and gets an HTTPS certificate.
7. Prints the setup link and a QR code.

### Install options

You can customize the script with environment variables:

```bash
# With your own domain (its A record must already point to the server)
curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/install.sh | sudo XUDBIN_DOMAIN=panel.example.com ACME_EMAIL=you@example.com bash

# On a LAN/test server with no public IP, with HTTPS off
curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/install.sh | sudo XUDBIN_HTTPS=0 bash
```

Set `XUDBIN_HARDEN=0` to skip the firewall and fail2ban setup.

## First admin account

At the end of the install a **setup link** is shown (`...?setup=<key>`). The admin account can only be created with the setup key in this link, so nobody can take over the panel before you the moment it goes online.

1. Open the link in a browser (or scan the QR code with your phone).
2. On **Create the admin account**, enter your name, email and a password of at least 10 characters. The **Setup key** field is filled in from the link.
3. Click **Create account**.

If you missed the link, show it again on the server:

```bash
xudbin link
```

Don't share the link. After creating the account, turn on two-factor authentication under **Settings > Account**.

## The `xudbin` command

```bash
xudbin link                                       # panel address (setup link on first install), with QR code
xudbin status                                     # counts of servers, apps, databases, users and banned IPs
xudbin user list                                  # users
xudbin user create ali@example.com Ali --member   # adds a user (admin without --member), prints a temporary password
xudbin user reset-password ali@example.com        # new temporary password, signs out all sessions
xudbin user disable-2fa ali@example.com           # turns off 2FA if the phone is lost
xudbin user delete ali@example.com
xudbin unban 203.0.113.7                          # removes an IP ban
sudo xudbin restore /root/xudbin-panel-....xbk    # restores a panel backup
sudo xudbin update                                # updates Xudbin
xudbin restart                                    # restarts the panel
xudbin logs                                       # follows the panel logs
```

## Updating

When a new version is out, the panel shows a notice. Go to **Settings > Panel** and click **Update**; the panel restarts within a few minutes and the page reloads on its own.

You can also update from the server:

```bash
sudo xudbin update
```

Updating doesn't touch your apps, databases or panel data. Security fixes only ship in the latest version.

## Verifying the images

Prebuilt images are built in GitHub Actions and signed with Sigstore (cosign); an SBOM and provenance are published with the image. To verify the signature:

```bash
cosign verify ghcr.io/furkan1116/xudbin:latest \
  --certificate-identity-regexp '^https://github.com/Furkan1116/XudbinPanel/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Adding a remote server

1. Click **Servers > Add server** and enter a name, IP address, SSH port and user (root is recommended; another user needs passwordless sudo).
2. On the **Setup** tab, run the shown command on the server to add the panel's SSH key.
3. Click **Test connection**, then **Start setup**. Docker and Caddy are installed automatically; the first setup can take 3–6 minutes.
