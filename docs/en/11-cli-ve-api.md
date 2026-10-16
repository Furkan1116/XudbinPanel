# CLI and API

You manage deploys from your own computer or a CI/CD pipeline with the `xb` command-line tool and API keys.

## Create an API key

Under **Settings > Account > API keys**, enter a name (e.g. GitHub Actions), choose **Expires** and click **Create**. The key starts with `xb_` and is shown only once.

- Use a key with an expiry for CI.
- Don't tick **Read-only** if you want to start deploys; a read-only key can only read.
- The key has the same permissions as you. If you're a member, it only sees apps in projects you can access.

## Installing `xb`

`xb` is a single-file Node.js script (Node.js 18 or later, no other dependencies):

```bash
sudo curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/cli/xb.mjs -o /usr/local/bin/xb
sudo chmod +x /usr/local/bin/xb
xb login https://panel.example.com xb_...
```

`xb login` saves the address and key to `~/.config/xudbin/cli.json`. You can use the `XUDBIN_URL` and `XUDBIN_TOKEN` environment variables instead.

## Commands

```bash
xb apps                       # lists apps (id, name, status, address)
xb status blog                # status, domains, last deploy
xb deploy blog                # starts a deploy
xb deploy blog --wait         # starts a deploy and follows the log; exit code 2 on failure
xb logs blog                  # live app logs
xb rollback blog 42           # rolls back to deploy #42
```

You can refer to an app by name, slug or id.

## GitHub Actions example

Store the key as a repository secret named `XUDBIN_TOKEN`:

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Xudbin
        run: |
          curl -fsSL https://raw.githubusercontent.com/Furkan1116/XudbinPanel/main/cli/xb.mjs -o xb.mjs
          node xb.mjs deploy blog --wait
        env:
          XUDBIN_URL: https://panel.example.com
          XUDBIN_TOKEN: ${{ secrets.XUDBIN_TOKEN }}
```

With `--wait`, the job fails when the deploy fails. If you use this approach, turn off the push webhook or **Deploy on push** for the same app, or every push will start two deploys.

## Using the API directly

All requests go under `https://<panel>/api` with an `Authorization: Bearer <key>` header:

```bash
# List apps
curl -H "Authorization: Bearer xb_..." https://panel.example.com/api/apps

# Start a deploy (response: {"deploymentId": ...})
curl -X POST -H "Authorization: Bearer xb_..." -H "Content-Type: application/json" -d '{}' \
  https://panel.example.com/api/apps/<id>/deploy

# Check a deploy's status
curl -H "Authorization: Bearer xb_..." https://panel.example.com/api/deployments/<deploy-id>
```

The app id appears in the app's URL in the panel and in the output of `xb apps`.
