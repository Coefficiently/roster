# Roster

A personal WoW roster dashboard that pulls character data from wowthing.org
and deploys it as a static site on GitHub Pages.

## Running it

```
python3 scripts/fetch_data.py   # pull fresh data into data.json
python3 -m http.server 8080     # view it locally
```

To force a re-scrape on the live site without waiting for the schedule,
use the "Run workflow" button under the Actions tab. (The in-page Refresh
button just reloads `data.json` -- it doesn't trigger a new scrape.)

## Private data (bags, warband bank)

Some data needs a logged-in session to fetch. If bag/warband info suddenly
goes empty, the login cookie has probably expired:

1. Log into wowthing.org
2. DevTools -> Application/Storage -> Cookies -> copy the
   `.AspNetCore.Identity.Application` value
3. Update the `WOWTHING_SESSION_COOKIE` secret in repo settings

## Encryption

The site's data is encrypted with a passphrase (the
`DATA_ENCRYPTION_PASSPHRASE` secret) so it isn't readable by anyone who
just stumbles on the repo. To change the passphrase, update that secret --
the next scrape re-encrypts with it automatically.

## Updating for a new season

A handful of values in `scripts/fetch_data.py` (crest IDs, the M+ dungeon
list, tier set IDs, etc.) are pinned to the current season and need
bumping when a new one starts. They're commented in the file itself.
