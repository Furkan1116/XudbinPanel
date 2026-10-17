# Databases and backups

You create databases in one click, take scheduled and verified backups, send them to S3-compatible storage, and can even restore the panel itself when needed.

## Creating a database

1. On the project page click **Add database**.
2. Choose the **Engine** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis), **Version** and **Server**.
3. Leave **Public port** empty (recommended) so only apps on the same server can reach it.
4. Click **Create**. A username and a strong password are generated automatically.

Connection details are on the database's **Connection** tab. Add the address under **Connect from apps** to your app's environment variables, for example:

```env
DATABASE_URL=postgresql://user:password@xb-db-blog:5432/blog
```

Inside a container `localhost` is the app itself, so never use `localhost` as the database host. If you need to connect from outside, open a port on the **Settings** tab.

## Automatic backups

On the database's **Backups** tab, turn on **Automatic backups**, enter how often (in hours) and how many backups to keep, and click **Save schedule**. **Back up now** takes a backup at any time. Each backup can be managed with **Download**, **Verify**, **Restore** or **Delete**.

Restoring replaces the database's current data with the backup; take a backup of the current state first.

The **Backups** page shows the status of all database and folder backups in one place.

## Backup encryption

Database and persistent-folder (volume) backups are **encrypted by default** (AES-256-GCM, streamed; it can't be turned off). Files end in `.xbe` (for example `blog-2026-10-17T10-00-00.sql.gz.xbe`); no plain data is left on disk or in off-site storage (S3). A separate key per file is derived (HKDF) from the panel's `secret.key`; no extra passphrase is asked, so scheduled backups stay encrypted on their own. Restore and **Verify** work with encrypted files; a corrupt or truncated file is rejected before anything is restored. Older `.gz` backups taken before this feature are unencrypted; they can still be restored, but take a new backup and delete the old ones if that matters.

**Important:** the key that opens backups is the panel's `secret.key`. If you lose it together with the panel's data (for example the server is gone), the encrypted database/volume backups can't be opened either. So set up the **Panel backup**: it carries `secret.key`, and after `xudbin restore` on a new server the backups in off-site storage can be opened again. If you lose the panel backup passphrase and the server too, the backups are unrecoverable. This also means anyone with access to `secret.key` (for example root on the server) can open backups; the goal is protecting backup files that sit on disk or in S3 if they are stolen.

### Opening a downloaded backup

You can't feed a downloaded `.xbe` file straight to a database. Copy it to the server running the panel and convert it to plain gzip:

```bash
sudo xudbin backup decrypt blog-2026-10-17T10-00-00.sql.gz.xbe   # creates blog-...sql.gz
gunzip blog-2026-10-17T10-00-00.sql.gz                           # the .sql file
```

The output is named after the input without `.xbe`; give a different name as a last argument if you prefer. It runs in the container with the panel's own `secret.key`. To open it on another machine you need a copy of `secret.key`: `docker exec xudbin node dist/cli.js backup decrypt /path/file.xbe --key-file /path/secret.key --out out.gz` (files must be inside the container).

## Off-site storage (S3)

So backups survive if the server is lost entirely, turn on **Also upload backups to off-site storage** under **Settings > Backups > Off-site storage**. AWS S3, Cloudflare R2, Backblaze B2 and MinIO are supported. Enter the Endpoint, Bucket, Access key, Secret key, Region (`auto` for R2) and an optional Folder (prefix); **Test connection** checks write access.

## Backup verification

To know a backup can really be restored, set an interval (in hours) in **Verify backups**. One of the automatic backups is regularly restored into a temporary, network-less database and tested, and the backup is marked "verified". 0 turns this off. Verification covers database backups only; volume and panel backups are not verified. To test a single backup by hand, click **Verify**.

## Volume backups

Apps with persistent storage folders (volumes) have a **Volume backups** card on their **Overview** tab. Set up an automatic schedule there, take a backup with **Back up now**, and bring a folder back with **Restore** (the app is stopped for a few seconds). Backups also go to off-site storage if it's configured. For folders holding database files, prefer a database backup.

## Panel backup

The panel's own data (servers, apps, environment variables, users) and its encryption key are backed up encrypted.

1. Under **Settings > Backups > Panel backup**, set a **Backup passphrase** of at least 12 characters. Without it the backup can't be opened, so write it down.
2. Set the interval and how many backups to keep (default: every 24 hours, keep the last 7).
3. Take the first one with **Back up now**; you can also save it to your computer with **Download**.

### Restoring on a new server

If the server is lost, install Xudbin on a new server, copy the backup file onto it, and run:

```bash
sudo xudbin restore /root/xudbin-panel-....xbk
```

If the backup is in off-site storage, you can restore straight from there:

```bash
sudo xudbin restore s3://bucket/key --endpoint https://... --access-key ... --secret-key ... --region auto
```

You're asked for the backup passphrase and the panel restarts from the backup. Then redeploy your apps and restore your databases from their backups.
