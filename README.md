# BP Web App

This replaces the Google Apps Script workflow from the original `hi.js` script with a local web app.

## What it does

- Fetches British Powerlifting entries from Sport80.
- Caches results to `data/cache.json` on disk.
- Normalizes lifter names into OpenIPF profile slugs such as `jakecazinmeyer`.
- Scrapes and caches `Best Total` and `Most Recent Total` from OpenIPF.
- Serves a browser UI for browsing by weight class.
- Avoids Google Sheets and Apps Script execution limits.

## Important constraint

This removes the Google Sheets rate limiting problem. It cannot remove any rate limiting imposed by Sport80 itself, so the server caches responses and refreshes them in one controlled pass instead of refetching on every browser view.

The Sport80 lifter list is refreshed automatically every 12 hours while the server is running. You can also force a refresh manually from the UI or with `npm run refresh`.

## Persistent override storage

The app now supports persistent storage through Postgres.

- If `DATABASE_URL` is unset, the app continues to use the local JSON files in `data/` for local development.
- If `DATABASE_URL` is set, the app stores the main entry cache, the OpenIPF cache, and manual OpenIPF overrides in Postgres.
- If your database provider requires TLS, set `DATABASE_SSL_MODE=require`.

When `DATABASE_URL` is set, the deployed app does not fall back to local cache files. All persisted state comes from Postgres.

This is the recommended setup for deploying to Render without losing manual overrides or forcing a full cache rebuild when the service restarts.

## Run it

```bash
cd /Users/jake/Desktop/bp-web-app
npm install
npm start
```

Then open `http://localhost:3000`.

Tested against Node 16 on this machine.

## Useful commands

```bash
npm run dev
npm run refresh
```