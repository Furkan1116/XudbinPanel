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

If the GitHub App is connected (or the app has a GitHub access token saved), the preview URL is posted as a comment on the PR. Open previews are listed under **Open PR previews** on the main app's **Overview** tab. For security, PRs from forks aren't deployed.

## Deploying from CI

To start deploys from your own CI pipeline (e.g. after tests pass), use an API key and the `xb` tool: [CLI and API](11-cli-ve-api.md).
