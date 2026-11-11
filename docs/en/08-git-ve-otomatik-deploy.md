# Git and automatic deploys

You redeploy your app automatically on every push, connect private repositories without tokens through the GitHub App, and get a separate preview address for every pull request.

## Push webhook (GitHub, GitLab, Gitea...)

Every app created from a Git repository has a webhook URL and a secret.

1. Copy the **Webhook URL** and **Secret** from the **Automatic deploy** section on the app's **Overview** tab.
2. In your Git provider's repository settings, add a webhook: paste the webhook URL into the URL field and the secret into the Secret / Secret token field, and select push events.
3. Make sure **Deploy on push** is on in the app's **Settings** tab.
4. Once the secret is in place, turn on **Require webhook signature**. Then requests not signed with the secret can't start a deploy, even if the webhook URL leaks.

Only pushes to the app's branch trigger a deploy.

## GitHub App

With the GitHub App connected, private repositories deploy without tokens, repositories are picked from a list, push and PR events arrive without setting up webhooks, and preview URLs are posted as PR comments.

### Check these first

- You must be using the panel over `https://` at an address **reachable from the internet**. GitHub sends events to that address; `localhost`, an internal network address or a panel with HTTPS off won't work.
- **Sign in to GitHub first** in the same browser. If your organization uses SSO, authorize it too.
- To create the App in an organization, you must be an owner there.

### Setup

1. Open the **Git sources** page.
2. To create the App in an organization, enter its name in **Organization (optional)**; leave it empty to create it on your personal account.
3. Click **Create GitHub App**. On the GitHub page that opens, just press **Create GitHub App**; everything is pre-filled.
4. Back in the panel, use **Grant repository access** to choose which repositories the App can access.

The App asks for these permissions: read code (`contents: read`) and PR comments (`pull_requests: write`); events: `push`, `pull_request`.

From now on, the **Git repository** step of adding an app shows a **Pick from GitHub** list. Use **Edit repositories** to change access later. **Disconnect** deletes the App's keys from the panel; to delete the App entirely, go to its settings on GitHub.

If earlier attempts left half-created Apps behind, you can delete them via **See your Apps on GitHub** on the same page.

## Pull request previews

Each PR gets its own address, is updated on new commits, and is deleted along with its data when the PR closes.

1. Turn on **Pull request previews** on the app's **Settings** tab.
2. With the GitHub App, nothing else is needed. With a manual webhook, also enable "Pull requests" events in your Git provider's webhook settings.

If the GitHub App is connected (or the app has a GitHub access token saved), the preview URL is posted as a comment on the PR. Open previews are listed under **Open PR previews** on the main app's **Overview** tab. For security, PRs from forks aren't deployed. Previews do **not** receive the main app's production environment variables: since anyone with write access to the repo can run code on a branch, the separate **Preview environment variables** list on the **Environment variables** tab is used (if empty, a preview only gets `XUDBIN_PREVIEW=1`). Put test values there. The git token is used only for cloning and is not written to the cloned repo's `.git/config`. Previews created before this version are updated with the new list on the next event for that PR (e.g. a push).

## Private image registries (GHCR, Docker Hub, GitLab...)

If your app comes from a private Docker image (e.g. `ghcr.io/mycompany/api:latest`), or the base image in its Dockerfile is private, the panel needs to log in to that registry. As an admin, open the **Image registries** section on the **Git sources** page, click **Add login** and enter:

- **Registry:** `ghcr.io`, `docker.io`, `registry.gitlab.com` or `registry.example.com:5000`. Docker Hub's other names (`index.docker.io`, `registry-1.docker.io`) are saved as `docker.io`.
- **Username** and **password or token:** we recommend a token with `read:packages` on GitHub, a read-only access token on Docker Hub, and a deploy token with `read_registry` on GitLab.

Before saving, the login is tried against the registry through Docker on the panel's own server (the same check as `docker login`), so a wrong login isn't saved. If the registry is reachable only from remote servers, you can turn off **Verify before saving**. You can re-check a saved login later with **Test** and rotate its token with **Edit**. There is one login per registry.

The panel picks the login itself based on the image address (an address without a registry means Docker Hub: `nginx`, `user/app`):

- Apps with a **Docker image** source: when the image is pulled on the app's server. This includes remote servers and replicas on extra servers; images are transferred to extra servers from the main server, so no login is needed there.
- Apps with a **Git or upload** source: during the build, if the Dockerfile's base image is in a private registry (on a separate build server too).
- **Docker Compose:** `docker compose` runs with a temporary Docker configuration that exists only for that deploy, lives outside the deploy folder, is readable only by the panel, and is deleted when the deploy ends.

The password or token is stored encrypted, is never returned by the API or shown in the UI, and is never written to deploy logs. It isn't passed to build steps (`RUN`, build arguments) or containers, and a Compose file can't read the temporary configuration file (files outside the compose folder are usable only with the "Host access" permission, which only an admin can turn on).

**What you should know:** logins apply panel-wide. Every user who can deploy apps (members included) can deploy **any image the token can access** in a registry listed here to their own app, and thereby see its contents. Nobody can see the token, but they can use its access. So use a token with read-only access, limited to the repositories of images meant to run on the panel; consider a separate account/token for more sensitive images. Only admins can access this page and its API (`/api/settings/registries`); adding, changing, deleting and testing logins are recorded in the audit log.

## Deploying from CI

To start deploys from your own CI pipeline (e.g. after tests pass), use an API key and the `xb` tool: [CLI and API](11-cli-ve-api.md).
