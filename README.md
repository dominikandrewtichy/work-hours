# Kofi Scraper

`kofi-scraper` is a TypeScript Cloudflare Worker that monitors the KOFI-KOFI internal shift exchange (`Burza směn`) and sends Discord notifications when new shifts become available for the logged-in user.

It runs every minute, keeps a session alive with `PHPSESSID`, parses the target page with `cheerio`, filters out shifts that are not actually claimable, and posts new matches to a Discord webhook.

## What It Monitors

The worker is currently tailored to the KOFI-KOFI information system page at:

- `https://is.kofikofi.cz/index.php`

It looks for the table whose caption is exactly `Burza směn` and extracts rows with these fields:

- `Datum`
- `Den`
- `Truck`
- `Pozice`
- `Od`
- `Do`
- `Nabízející`
- `Zájemce`

## Which Shifts Trigger Notifications

The scraper does not alert on every row in the table. It only keeps rows that are:

- Marked with a submit action labeled `Beru`
- Not disabled
- Showing `Žádný` in the `Zájemce` column

It then excludes rows that should not notify the current user:

- Shifts already taken by the logged-in user
- Shifts posted by the logged-in user

In other words, notifications are only sent for shifts that appear to be newly available and claimable by the account used for scraping.

## How It Works

1. The Cloudflare Worker runs every minute via cron.
2. It reads `PHPSESSID` from Cloudflare KV.
3. If no session exists, it logs in and stores the session id in KV.
4. It fetches the target page with the session cookie.
5. If the returned HTML looks like the login form, it assumes the session expired, logs in again, and retries.
6. It parses the `Burza směn` table and builds a filtered list of relevant shifts.
7. It compares the current list with the previous list stored in KV.
8. It sends a Discord webhook notification for rows that are new in the current snapshot.
9. It stores the latest snapshot back into KV.

## State Stored In Cloudflare KV

The worker stores two keys in the `SCRAPER_STATE` namespace:

- `PHPSESSID`
  Used to avoid logging in on every run.
- `PREVIOUS_DATA`
  A JSON snapshot of the previously seen relevant shifts, used for change detection.

## Requirements

- Node.js and npm
- A Cloudflare account
- Cloudflare `wrangler`

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Log in to Cloudflare:
   ```bash
   npx wrangler login
   ```

3. Create a KV namespace for scraper state:
   ```bash
   npx wrangler kv namespace create SCRAPER_STATE
   ```
   Copy the returned namespace id into `wrangler.toml` under the `[[kv_namespaces]]` binding.

4. Configure worker vars in `wrangler.toml`:
   ```toml
   [vars]
   WP_LOGIN_URL = "https://is.kofikofi.cz/index.php"
   WP_TARGET_URL = "https://is.kofikofi.cz/index.php"
   ```

5. Set secrets for authentication and Discord:
   ```bash
   npx wrangler secret put WP_USERNAME
   npx wrangler secret put WP_PASSWORD
   npx wrangler secret put DISCORD_WEBHOOK_URL
   ```

## Deployment

Deploy the worker:

```bash
npx wrangler deploy
```

The worker is configured to run every minute:

```toml
[triggers]
crons = ["* * * * *"]
```

## Local Development

Run the worker locally:

```bash
npx wrangler dev
```

Then trigger a scrape by opening the local worker URL in your browser or sending a request to it manually. The worker exposes an HTTP endpoint that runs the same scraping process as the scheduled job.

## Discord Notifications

When new eligible shifts are detected, the worker sends Discord embeds containing:

- truck / location
- date and day
- time range
- position
- offering user
- interested user
- current status

Embeds are sent in batches of up to 10 per webhook request.

## Notes And Limitations

- The scraper is not generic. It is written against the current KOFI-KOFI page structure and Czech form labels.
- Login uses the fields `login`, `heslo`, and `ok=Přihlásit se`.
- Session expiry is detected by checking whether the fetched page contains the login form markup.
- If the HTML structure or labels on the target page change, `parseData()` in `src/index.ts` will likely need to be updated.
