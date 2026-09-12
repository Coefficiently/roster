# Current Roster

Personal dashboard: pulls [wowthing.org/user/cta](https://wowthing.org/user/cta),
writes `data.json`, deployed to GitHub Pages. Level 90+ / ilvl 290+ characters only.

## Commands

```
python3 scripts/fetch_data.py   # regenerate data.json
python3 -m http.server 8080     # serve locally
```

Manual re-scrape: Actions tab -> "Update roster data and deploy" -> Run workflow.
(The in-page Refresh button only re-fetches `data.json`; it doesn't re-scrape wowthing.)

## Private data (bag/bank contents, Warband Bank)

wowthing's public feed never includes bag/bank contents or a couple of
specific tracked items (Spark of Tides, Thalassian Token of Merit) for any
account -- confirmed in their backend source, not a setting. To get this
data, `fetch_data.py` optionally uses an authenticated session cookie
(`WOWTHING_SESSION_COOKIE` repo secret) if set; without it, everything just
falls back to public data as before.

**This cookie expires periodically and needs manual rotation:**
1. Log into wowthing.org.
2. DevTools -> Application/Storage -> Cookies -> `wowthing.org` ->
   `.AspNetCore.Identity.Application` -> copy the value.
3. Repo Settings -> Secrets and variables -> Actions -> update
   `WOWTHING_SESSION_COOKIE` with the new value.

If the site's bag/warband data suddenly goes empty again, this is why --
check the "Fetch latest WoWthing data" Action log for a cookie-expired
warning before assuming something else broke.

## Encrypted data.json

The repo and site are public, but `data.json` is encrypted (AES-256-GCM, key
derived via PBKDF2) so the raw file itself is unreadable without the
passphrase -- set via the `DATA_ENCRYPTION_PASSPHRASE` repo secret. The
browser decrypts it client-side (Web Crypto API) and remembers the
passphrase in that browser's localStorage after the first correct entry, so
it won't ask again on that device/browser. Clearing browser data, or using
a different browser/device, means entering it once more there.

This is genuinely enough to stop passive discovery (search engines,
casually finding the repo, someone fetching data.json directly expecting
plain JSON) -- but it's static-site crypto with no rate-limiting on guesses,
so it rests entirely on the passphrase being strong. It is not intended to
resist a determined, resourced attacker. To rotate the passphrase: generate
a new one, update the `DATA_ENCRYPTION_PASSPHRASE` secret, done -- next
fetch re-encrypts with it, and any browser with the old one cached will
just fail to decrypt and re-prompt.

If `DATA_ENCRYPTION_PASSPHRASE` is unset, `data.json` is written as plain
JSON as before (this is purely additive, not required).

## Season-specific constants (scripts/fetch_data.py) -- bump these when stale

| Constant | Update when | How |
|---|---|---|
| `CREST_IDS` | New crest tier | `rawCurrencies` in `.../api/static-*.json`, match by name |
| `CATALYST_IDS`, `BONUS_ROLL_IDS` | New season renames these | Same, but verify against a real known value -- duplicate-name ids happen (see code comments) |
| `MYTHIC_PLUS_SEASON_ID`, `MYTHIC_PLUS_DUNGEONS` | New M+ season | wowthing's `seasonMap` / matching `order...` array |
| `CURRENT_SEASON_BONUS_GROUPS` | New season | wowthing's `seasonItemBonusListGroups` |
| `TIER_SET_BY_CLASS` | New raid tier | wowthing's `currentTier` in `data/gear.ts` |
| `CURRENT_EXPANSION_INDEX` | New expansion | +1 |
