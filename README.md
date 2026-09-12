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

## Season-specific constants (scripts/fetch_data.py) -- bump these when stale

| Constant | Update when | How |
|---|---|---|
| `CREST_IDS` | New crest tier | `rawCurrencies` in `.../api/static-*.json`, match by name |
| `CATALYST_IDS`, `BONUS_ROLL_IDS` | New season renames these | Same, but verify against a real known value -- duplicate-name ids happen (see code comments) |
| `MYTHIC_PLUS_SEASON_ID`, `MYTHIC_PLUS_DUNGEONS` | New M+ season | wowthing's `seasonMap` / matching `order...` array |
| `CURRENT_SEASON_BONUS_GROUPS` | New season | wowthing's `seasonItemBonusListGroups` |
| `TIER_SET_BY_CLASS` | New raid tier | wowthing's `currentTier` in `data/gear.ts` |
| `CURRENT_EXPANSION_INDEX` | New expansion | +1 |
