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
