# Team and access

You add teammates to the panel, give them the admin or member role, assign members to projects as developers or viewers, keep an audit log, and enable single sign-on.

## Adding users

Under **Settings > Users**, click **Add user** and enter a name, email and role. The panel generates a temporary password; it isn't shown again, so you pass it on yourself. The user sets their own password on first sign-in.

On the same tab you can change roles, generate a new temporary password with **Reset password**, or delete a user. You can also do this on the server:

```bash
xudbin user create ali@example.com Ali --member
xudbin user reset-password ali@example.com
```

## Roles

| Role | Access |
|---|---|
| **Admin** | Everything: servers, security, settings, users and all projects |
| **Member** | Only the projects, apps and databases they're added to; intended to have no access to servers, security or settings (see the warning below) |

Because admins control Docker, they effectively have root on your servers; give this role only to people you trust and make them turn on 2FA. Compose settings that grant host access (privileged, host path mounts, host network) need admin approval: an admin enables them per app with **Host access** on the app's **Settings** tab.

> **Warning:** The member role is not yet a strong security boundary. An independent code review on 2026-10-17 found gaps that could let a member reach other projects or the panel; they are being worked on. Until they are fixed, give the member role only to people you trust. Details: [SECURITY.md](../../SECURITY.md).

## Project roles

Members only see the projects they're added to. In the **Members** section of the project page, **Choose member**, pick a role and click **Add**:

- **Developer:** can create, deploy and configure the project's apps and databases.
- **Viewer:** can see everything but change nothing.

A member who creates a project is added to it as a developer automatically.

## Audit log

The **Settings > Audit log** tab shows who changed what, when and from which IP. You can search by user, action, path or IP.

## API keys

Create keys for CI/CD or the `xb` tool under **Settings > Account > API keys**. A key acts with your permissions.

- **Expires:** 30 days, 90 days, 1 year or permanent.
- **Read-only:** can only read; can't start deploys or change anything.

The key is shown only once, right after creation; copy it immediately. Usage: [CLI and API](11-cli-ve-api.md).

## Single sign-on (SSO)

You can enable sign-in with an OpenID Connect provider such as Google Workspace, Microsoft Entra, Keycloak, Authentik or GitLab. The setting is in the **Single sign-on (SSO)** section of **Settings > Panel**.

1. Create an OIDC client at your provider and enter the **Redirect URI** shown in the panel (`https://<panel>/api/auth/oidc/callback`).
2. In the panel, enter the **Issuer URL** (e.g. `https://accounts.google.com`), **Client ID**, **Client secret** and the **Button label** for the sign-in screen.
3. With **Create new users automatically** off, only emails already registered in the panel can sign in via SSO. If you turn it on, users from the **Allowed email domains** (e.g. `mycompany.com`) are created as members; you add them to projects.
4. Click **Save**.

For SSO users, two-factor authentication is handled by the provider. To turn it off, click **Turn off SSO**.
