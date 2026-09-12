#!/usr/bin/env python3
"""
Fetches WoWthing profile data for a given account and produces a compact
data.json consumed by the static site.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

WOWTHING_USER = "cta"
BASE = "https://wowthing.org"

# Optional: an authenticated wowthing session cookie, which unlocks private
# data the public feed never includes at all (confirmed against wowthing's
# own backend source) -- bag/inventory contents, warband bank contents, and
# a couple of specific tracked items (Spark of Tides, Thalassian Token of
# Merit) that aren't in the public item-exposure allowlist. Set via the
# WOWTHING_SESSION_COOKIE repo secret in CI; falls back to public data if
# unset (e.g. for local runs), so this is additive, not required.
#
# This is a session cookie (.AspNetCore.Identity.Application), not a
# password -- if it ever leaked, it would expose read access to this
# wowthing account's private data, not Battle.net/account-level access.
# Session cookies expire periodically and need re-generating (log into
# wowthing.org, copy the fresh cookie value, update the repo secret).
SESSION_COOKIE = os.environ.get("WOWTHING_SESSION_COOKIE", "").strip()

# Currency IDs we care about (Midnight Season 2, as of this writing).
# These can drift each season -- update if wowthing adds a new crest tier.
#
# There are TWO sets of ids named "X Mistcrest": 3437-3441 (category 142,
# "Hidden") and 3442-3446 (category 282, literally "Crests"). We originally
# used 3437-3441 -- they returned plausible nonzero data, so the bug wasn't
# obvious -- but 3442-3446 are the ones wowthing's own UI actually displays,
# confirmed two ways: their descriptions' item-level ranges exactly match
# what we independently derived from equipped gear (e.g. Myth 321-334), and
# their per-character records have max/totalQuantity/isMovingMax properly
# populated (3437-3441's are always 0), which let a user-reported real value
# (10 current / 400 earned-this-season for a specific character) be matched
# exactly. If crest numbers on the site ever look wrong again, this
# duplicate-id trap is the first thing to re-check.
CREST_IDS = [3442, 3443, 3444, 3445, 3446]      # Adventurer..Myth Mistcrest

# Fallback only. With the correct ids above, wowthing's own `max` field is
# properly populated per character (varies: seen as high as 500, with
# Hero/Myth 100 lower than Adventurer/Veteran/Champion) and is used
# directly. This override is kept in case that field is ever 0 for some
# character/reason -- shouldn't normally be hit anymore.
CREST_MAX_OVERRIDE = {
    3442: 500,  # Adventurer Mistcrest
    3443: 500,  # Veteran Mistcrest
    3444: 500,  # Champion Mistcrest
    3445: 400,  # Hero Mistcrest
    3446: 400,  # Myth Mistcrest
}
# 2167 ("Catalyst Charges") is a Dragonflight-era id, explicitly commented
# out as unused in wowthing's own currencies.ts, and shows zero data for
# every character on this account -- it's dead. The actual current-season
# catalyst-charge currency is "Venomblight Manaflux", confirmed against a
# real in-game value the user provided.
CATALYST_IDS = [3465]                            # Venomblight Manaflux
# Two currency ids are BOTH named "Nebulous Voidcore" with identical
# description text (3418 and 3513) -- a duplicate-naming pattern that also
# shows up elsewhere in wowthing's data (see the crest note above).
# 3418 is the one confirmed correct against real in-game/addon values;
# 3513 tracked a consistently different (wrong) number for every character.
BONUS_ROLL_IDS = [3418, 3509]                    # Nebulous Voidcore, Tidal Spark Dust

MIN_LEVEL = 90
MIN_ITEM_LEVEL = 290

# Current Mythic+ season, hand-pinned (Midnight Season 2). Update each
# season: season id from apps/frontend/data/mythic-plus.ts `seasonMap`,
# dungeon map ids from the matching `order...` array + MapChallengeMode enum,
# names looked up in rawChallengeDungeons.
MYTHIC_PLUS_SEASON_ID = 18
MYTHIC_PLUS_DUNGEONS = [
    (588, "Altar of Fangs"),
    (586, "Den of Nalorakk"),
    (587, "Murder Row"),
    (584, "The Blinding Vale"),
    (585, "Voidscar Arena"),
    (399, "Ruby Life Pools"),
    (249, "Kings' Rest"),
    (250, "Temple of Sethraliss"),
]

# Expansion index into a profession's per-expansion subProfessions array
# (0=Classic ... 11=Midnight). Bump this when a new expansion launches.
CURRENT_EXPANSION_INDEX = 11

# Current-season gear-upgrade-track bonus groups, hand-pinned from
# apps/frontend/data/constants.ts `seasonItemBonusListGroups`. Multiple
# groups across seasons/sources can all display the same track name (e.g.
# "Myth") while representing different, incompatible rank curves -- without
# this filter, a rank/track pair can silently resolve to the wrong item
# level. Update this set each season.
CURRENT_SEASON_BONUS_GROUPS = {613, 614, 615, 616, 617, 618}

RAID_DIFFICULTY_SHORT = {17: "LFR", 14: "N", 15: "HC", 16: "M", 233: "N", 234: "HC", 235: "M"}
RAID_DIFFICULTY_ORDER = [17, 14, 15, 16, 233, 234, 235]

# Some raids only have as many difficulty rows as wowthing has actually seen a
# character enter (a lockout only exists once someone's killed something on
# that difficulty). For small/new raids where nobody in the account has
# touched every tier yet, hand-pin the full known difficulty list here so all
# rows show up (as dashes) even before anyone's attempted them. Difficulty
# ids for untried tiers are a best guess (sequential from the observed one);
# if wrong, the real id will just show up as an extra row once someone runs
# it, self-correcting.
RAID_DIFFICULTY_FORCE = {
    "The Tidebound Grotto": [233, 234, 235],  # Normal, Heroic, Mythic
}

SLOT_NAMES = {
    0: "Ammo", 1: "Head", 2: "Neck", 3: "Shoulders", 4: "Shirt", 5: "Chest",
    6: "Waist", 7: "Legs", 8: "Feet", 9: "Wrist", 10: "Hands", 11: "Ring 1",
    12: "Ring 2", 13: "Trinket 1", 14: "Trinket 2", 15: "Back", 16: "Main Hand",
    17: "Off Hand", 18: "Ranged", 19: "Tabard",
}

DIFFICULTY_NAMES = {
    1: "Normal", 2: "Heroic", 23: "Mythic", 8: "Mythic Keystone",
    14: "Normal", 15: "Heroic", 16: "Mythic", 17: "LFR", 24: "Timewalking",
}

QUALITY_COLORS = {
    0: "#9d9d9d", 1: "#ffffff", 2: "#1eff00", 3: "#0070dd",
    4: "#a335ee", 5: "#ff8000", 6: "#e6cc80", 7: "#00ccff",
}

# Current raid tier's class set-item ids, hand-pinned from
# apps/frontend/data/gear.ts `currentTier` (update every new raid tier).
TIER_SET_BY_CLASS = {
    6: 2055,   # Death Knight
    12: 2056,  # Demon Hunter
    11: 2057,  # Druid
    13: 2058,  # Evoker
    3: 2059,   # Hunter
    8: 2060,   # Mage
    10: 2061,  # Monk
    2: 2062,   # Paladin
    5: 2063,   # Priest
    4: 2064,   # Rogue
    7: 2065,   # Shaman
    9: 2066,   # Warlock
    1: 2067,   # Warrior
}

WOW_MARKUP_RE = re.compile(r"\|[Aa]:[^|]*\|a|\|T[^|]*\|t|\|c[0-9A-Fa-f]{8}|\|r")


def clean_wow_text(text):
    return WOW_MARKUP_RE.sub("", text).strip()


def merge_item_stacks(items):
    """Combine entries for the same item id (e.g. the same item split across
    multiple bag/bank slots as separate stacks) into one row with a summed
    count, preserving first-seen order. If merged entries span more than one
    "location" value (e.g. Bags + Bank), that field becomes a joined string
    ("Bags, Bank") rather than silently keeping just the first one seen.
    """
    merged = {}
    locations = {}
    order = []
    for item in items:
        key = item["itemId"]
        if key in merged:
            merged[key]["count"] += item["count"]
            loc = item.get("location")
            if loc:
                locations[key].add(loc)
        else:
            merged[key] = dict(item)
            locations[key] = {item["location"]} if item.get("location") else set()
            order.append(key)
    result = []
    for key in order:
        item = merged[key]
        if locations[key] and len(locations[key]) > 1:
            item["location"] = ", ".join(sorted(locations[key]))
        result.append(item)
    return result


def merge_item_stacks(items, key_fn=None):
    """Combine entries with the same key (default: itemId) into one, summing
    their counts. The same item can legitimately show up as several separate
    stacks (e.g. split across bag slots or bank tabs) -- this collapses them
    into a single row per distinct key, keeping first-seen field values
    other than count.
    """
    key_fn = key_fn or (lambda item: item["itemId"])
    merged = {}
    order = []
    for item in items:
        key = key_fn(item)
        if key in merged:
            merged[key]["count"] += item["count"]
        else:
            merged[key] = dict(item)
            order.append(key)
    return [merged[key] for key in order]


def _headers():
    headers = {"User-Agent": "wowthing-site-builder/1.0"}
    if SESSION_COOKIE:
        headers["Cookie"] = f".AspNetCore.Identity.Application={SESSION_COOKIE}"
    return headers


def fetch_json(url):
    req = urllib.request.Request(url, headers=_headers())
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_text(url):
    req = urllib.request.Request(url, headers=_headers())
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8")


def get_asset_paths(html):
    paths = {}
    for key in ["data-user", "data-static", "data-item"]:
        m = re.search(rf'{key}="([^"]+)"', html)
        if m:
            paths[key] = m.group(1).replace("&amp;", "&")
    return paths


def main():
    mode = "authenticated (private data)" if SESSION_COOKIE else "public data only"
    print(f"Fetching profile page for {WOWTHING_USER}... [{mode}]")
    html = fetch_text(f"{BASE}/user/{WOWTHING_USER}")
    paths = get_asset_paths(html)
    if "data-user" not in paths:
        print("Could not find data-user asset path in page", file=sys.stderr)
        sys.exit(1)

    print("Fetching user data...")
    if SESSION_COOKIE and "private" not in paths["data-user"]:
        print(
            "WARNING: WOWTHING_SESSION_COOKIE is set but the served data path "
            f"({paths['data-user']}) doesn't look private -- the cookie may have "
            "expired. Falling back to public data for this run; log into "
            "wowthing.org and update the WOWTHING_SESSION_COOKIE secret with a "
            "fresh value.",
            file=sys.stderr,
        )
    user_url = BASE + paths["data-user"]
    # This is often a redirect to a versioned file
    user_data = fetch_json(user_url)

    print("Fetching static data...")
    static_data = fetch_json(BASE + paths["data-static"])

    characters_raw = user_data.get("charactersRaw", [])

    # --- Build lookups from static data -------------------------------
    currency_by_id = {c[0]: {"name": c[8]} for c in static_data.get("rawCurrencies", [])}
    classes = {
        cid: {"name": c["name"].split("|")[0], "slug": c["slug"]}
        for cid, c in static_data.get("characterClasses", {}).items()
    }
    races = {
        rid: {"name": r["name"].split("|")[0], "slug": r["slug"]}
        for rid, r in static_data.get("characterRaces", {}).items()
    }
    realms = {}
    for r in static_data.get("rawRealms", []):
        realms[r[0]] = {"name": r[3], "slug": r[4], "region": r[1]}
    dungeon_name_by_id = {d[0]: d[3] for d in static_data.get("rawChallengeDungeons", [])}

    # Primary (type 0) professions only -- a character has at most 2 -- mapped
    # to their current-expansion (Midnight = index 11) subprofession id/name,
    # which is what actually tracks this season's skill level.
    profession_meta = {}
    for p in static_data.get("rawProfessions", []):
        prof_id, prof_type, prof_name = p[0], p[1], p[2]
        sub_professions = p[5]
        current_exp_sub = sub_professions[CURRENT_EXPANSION_INDEX] if len(sub_professions) > CURRENT_EXPANSION_INDEX else None
        if prof_type != 0 or not current_exp_sub:
            continue
        profession_meta[prof_id] = {
            "name": prof_name.split("|")[0],
            "subProfessionId": current_exp_sub[0],
        }

    # --- Figure out which item ids we need names for -------------------
    needed_item_ids = set()
    qualifying = []
    for c in characters_raw:
        level = c[6]
        item_level = c[10]
        if level < MIN_LEVEL or item_level < MIN_ITEM_LEVEL:
            continue
        qualifying.append(c)
        equipped = c[30] or {}
        for arr in equipped.values():
            needed_item_ids.add(arr[2])
            for gem_id in (arr[7] or []):
                needed_item_ids.add(gem_id)
        for item in (c[50] or []):
            needed_item_ids.add(item[3])

    print(f"{len(qualifying)} characters qualify (level>={MIN_LEVEL}, ilvl>={MIN_ITEM_LEVEL})")

    # Warband bank contents (account-wide, only present with an
    # authenticated session -- see SESSION_COOKIE above).
    raw_warband_items = user_data.get("rawWarbankItems") or []
    for item in raw_warband_items:
        needed_item_ids.add(item[3])

    # --- Identify raids + canonical boss order ---------------------------
    # Every distinct lockout name found is treated as its own raid, since
    # WoW dungeons don't carry a persistent weekly "lockout" the way raids
    # do (including smaller one-off raids that only have a single difficulty,
    # e.g. a 1-boss mini raid). Difficulties are grouped per raid rather than
    # assumed to always be the standard LFR/Normal/Heroic/Mythic four.
    from collections import Counter
    raid_boss_lists = {}
    raid_difficulties = {}
    for c in qualifying:
        for lo in (c[35] or {}).values():
            name = lo.get("name")
            difficulty = lo.get("difficulty")
            raid_difficulties.setdefault(name, set()).add(difficulty)
            bosses = [b.get("name") for b in lo.get("bosses", [])]
            if len(bosses) > len(raid_boss_lists.get(name, [])):
                raid_boss_lists[name] = bosses

    def difficulty_sort_key(d):
        return (RAID_DIFFICULTY_ORDER.index(d) if d in RAID_DIFFICULTY_ORDER else 99, d)

    raids = []
    for raid_name in sorted(raid_boss_lists, key=lambda n: (-len(raid_boss_lists[n]), n)):
        difficulty_ids = set(raid_difficulties[raid_name]) | set(RAID_DIFFICULTY_FORCE.get(raid_name, []))
        difficulties = sorted(difficulty_ids, key=difficulty_sort_key)
        raids.append({
            "name": raid_name,
            "bosses": raid_boss_lists[raid_name],
            "difficulties": [
                {"id": d, "label": RAID_DIFFICULTY_SHORT.get(d, f"Diff {d}")}
                for d in difficulties
            ],
        })
    print(f"Raids detected: {[(r['name'], len(r['bosses'])) for r in raids]}")

    print(f"Fetching item names for {len(needed_item_ids)} items...")

    item_data = fetch_json(BASE + paths["data-item"])
    names_array = item_data.get("names", [])
    class_lookup = item_data.get("classIdSubclassIdInventoryTypes", [])

    item_names = {}
    item_categories = {}
    if needed_item_ids:
        # rawItems is delta-encoded: running item id = sum of arr[0] so far,
        # and the item's name is names_array[arr[1]] (arr[1] is a *name index*,
        # not the item id). arr[4] indexes into classIdSubclassIdInventoryTypes
        # to get [classId, subclassId, inventoryType] -- classId is WoW's
        # broad item category (Weapon, Armor, Consumable, Trade Goods, etc).
        running_id = 0
        remaining = set(needed_item_ids)
        for arr in item_data.get("rawItems", []):
            running_id += arr[0]
            if running_id in remaining:
                name_idx = arr[1]
                if 0 <= name_idx < len(names_array) and names_array[name_idx]:
                    item_names[running_id] = names_array[name_idx]
                class_idx = arr[4] if len(arr) > 4 else None
                if class_idx is not None and 0 <= class_idx < len(class_lookup):
                    item_categories[running_id] = class_lookup[class_idx][0]
                remaining.discard(running_id)
                if not remaining:
                    break

    # Standard Blizzard item class ids (ItemClass.db2) -- stable across
    # expansions, not something that needs seasonal updates.
    ITEM_CATEGORY_NAMES = {
        0: "Consumable", 1: "Container", 2: "Weapon", 3: "Gem", 4: "Armor",
        5: "Reagent", 6: "Projectile", 7: "Trade Goods", 8: "Item Enhancement",
        9: "Recipe", 10: "Currency", 11: "Quiver", 12: "Quest Item", 13: "Key",
        14: "Permanent", 15: "Miscellaneous", 16: "Glyph", 17: "Battle Pet",
        18: "WoW Token", 19: "Profession",
    }

    def item_category_name(item_id):
        return ITEM_CATEGORY_NAMES.get(item_categories.get(item_id), "Miscellaneous")

    # --- Gear upgrade tracks (Explorer..Myth) decoded from bonus ids -----
    # itemBonusListGroups[groupId][sharedStringId] = [bonusId rank1, rank2, ...]
    # sharedStrings[sharedStringId] is the track's display name ("Hero", etc).
    # Only current-season groups are considered -- see CURRENT_SEASON_BONUS_GROUPS.
    item_bonus_to_upgrade = {}
    for group_id_str, bonus_groups in item_data.get("itemBonusListGroups", {}).items():
        if int(group_id_str) not in CURRENT_SEASON_BONUS_GROUPS:
            continue
        for shared_id_str, bonus_ids in bonus_groups.items():
            if len(bonus_ids) > 1:
                shared_id = int(shared_id_str)
                for i, bonus_id in enumerate(bonus_ids):
                    item_bonus_to_upgrade[bonus_id] = (shared_id, i + 1, len(bonus_ids))
    shared_strings = static_data.get("sharedStrings", {})

    # --- Enchant text, decoded from enchant ids ---------------------------
    # We only use this for a quick-glance label -- NOT for the actual stat
    # numbers. enchantmentValues often needs item-level-scaled curve math to
    # fill in $k1/$k2 placeholders correctly, which we don't have, so
    # substituting them produced wrong (wildly inflated) numbers. Strip any
    # unresolved $k placeholders instead of guessing at them; the Wowhead
    # tooltip (added client-side) is the source of truth for exact stats.
    enchant_name = {}
    for text, ids in static_data.get("enchantmentStrings", {}).items():
        for eid in ids:
            enchant_name[eid] = text
    for eid_str in static_data.get("enchantmentValues", {}):
        eid = int(eid_str)
        enchant_name.setdefault(eid, f"Enchant #{eid}")

    def get_enchant_text(enchant_id):
        text = enchant_name.get(enchant_id, f"Enchant #{enchant_id}")
        text = re.sub(r"\$k\d+", "", text)
        return clean_wow_text(text)

    # --- Wowhead links (mirrors wowthing's own get-item-url.ts) -----------
    # Wowhead's tooltip widget (loaded client-side) renders the full,
    # authoritative live tooltip -- icon, stats, everything -- for any link
    # built this way. We don't compute item stats ourselves.
    def wowhead_url(item_id, bonus_ids=None, enchant_ids=None, gem_ids=None, item_level=None):
        params = []
        if bonus_ids:
            params.append(f"bonus={':'.join(str(b) for b in bonus_ids)}")
        if enchant_ids:
            params.append(f"ench={enchant_ids[0]}")
        if gem_ids:
            params.append(f"gems={':'.join(str(g) for g in gem_ids)}")
        if item_level:
            params.append(f"ilvl={item_level}")
        url = f"https://www.wowhead.com/item={item_id}"
        if params:
            url += "?" + "&".join(params)
        return url

    # --- Current tier set item ids, per class -----------------------------
    item_set_by_id = {s[0]: s[2] for s in item_data.get("rawItemSets", [])}

    warband_items_out = []
    for item in raw_warband_items:
        location, bag_id, slot, item_id, count = item[0], item[1], item[2], item[3], item[4]
        item_level = item[8] if len(item) > 8 else 0
        quality = item[9] if len(item) > 9 else 1
        warband_items_out.append({
            "itemId": item_id,
            "itemName": item_names.get(item_id, f"Item #{item_id}"),
            "count": count,
            "itemLevel": item_level,
            "quality": quality,
            "category": item_category_name(item_id),
            "wowheadUrl": f"https://www.wowhead.com/item={item_id}" + (f"?ilvl={item_level}" if item_level else ""),
        })
    warband_items_out = merge_item_stacks(warband_items_out)

    # --- Build character output ----------------------------------------
    def short_currency_name(name):
        # "Adventurer Mistcrest" -> "Adventurer", etc. No-op for names that
        # don't end in a "...crest" word (Catalyst Charges, Nebulous Voidcore).
        stripped = re.sub(r"\s+\S*[Cc]rest$", "", name).strip()
        return stripped or name

    def currency_group(raw_currencies, ids):
        by_id = {rc[0]: rc for rc in (raw_currencies or [])}
        out = []
        for cid in ids:
            rc = by_id.get(cid)
            meta = currency_by_id.get(cid, {"name": f"Currency {cid}"})
            wowhead_currency_url = f"https://www.wowhead.com/currency={cid}"
            if rc:
                api_max = rc[2] if len(rc) > 2 else 0
                # Crests (and some other currencies) track a season-long
                # "total earned" separately from what's currently banked --
                # once you hit the season cap you can spend down without the
                # total resetting. wowthing exposes this as totalQuantity +
                # an isMovingMax flag; when present, show it as an extra
                # tooltip alongside the current/cap number we already show.
                total_quantity = rc[3] if len(rc) > 3 else 0
                is_moving_max = bool(rc[4]) if len(rc) > 4 else False
                out.append({
                    "id": cid,
                    "name": meta["name"],
                    "shortName": short_currency_name(meta["name"]),
                    "quantity": rc[1] if len(rc) > 1 else 0,
                    "max": api_max or CREST_MAX_OVERRIDE.get(cid, 0),
                    "totalQuantity": total_quantity,
                    "isMovingMax": is_moving_max,
                    "wowheadUrl": wowhead_currency_url,
                })
            elif cid in currency_by_id:
                out.append({
                    "id": cid, "name": meta["name"], "shortName": short_currency_name(meta["name"]),
                    "quantity": 0, "max": CREST_MAX_OVERRIDE.get(cid, 0),
                    "totalQuantity": 0, "isMovingMax": False,
                    "wowheadUrl": wowhead_currency_url,
                })
        return out

    characters_out = []
    for c in qualifying:
        (
            char_id, name, is_resting, is_war_mode, account_id, active_spec_id,
            level, level_xp, chromie_time, class_id, equipped_item_level, faction,
            gender, guild_id, played_total, race_id, realm_id, rested_xp, gold,
            bank_tabs, current_location, hearth_location, last_api_update_unix,
            last_seen_addon_unix, daily_reset_unix, weekly_reset_unix,
            scanned_currencies_unix, transferred_currencies_unix,
            configuration, auras, raw_equipped_items, garrisons, garrison_trees,
            highest_item_level, known_spells, lockouts, mythic_plus, mythic_plus_addon,
            raw_mythic_plus_seasons, paragons, patron_orders, professions,
            profession_cooldowns, profession_specializations, profession_traits,
            raider_io, reputations, shadowlands, raw_weekly, raw_currencies,
            raw_items, raw_mythic_plus_weeks, specializations, raw_statistics,
        ) = c

        tier_set_id = TIER_SET_BY_CLASS.get(class_id)
        tier_set_item_ids = set(item_set_by_id.get(tier_set_id, [])) if tier_set_id else set()

        equipped_out = []
        tier_piece_count = 0
        for slot_str, arr in sorted((raw_equipped_items or {}).items(), key=lambda kv: int(kv[0])):
            slot = int(slot_str)
            item_id = arr[2]
            bonus_ids = arr[5] or []
            enchant_ids = arr[6] or []
            gem_ids = arr[7] or []

            upgrade = None
            for bonus_id in bonus_ids:
                match = item_bonus_to_upgrade.get(bonus_id)
                if match:
                    shared_id, rank, max_rank = match
                    upgrade = {
                        "track": shared_strings.get(str(shared_id), f"Track {shared_id}"),
                        "rank": rank,
                        "maxRank": max_rank,
                    }
                    break

            is_tier_piece = item_id in tier_set_item_ids
            if is_tier_piece:
                tier_piece_count += 1

            equipped_out.append({
                "slot": slot,
                "slotName": SLOT_NAMES.get(slot, f"Slot {slot}"),
                "itemId": item_id,
                "itemName": item_names.get(item_id, f"Item #{item_id}"),
                "itemLevel": arr[3],
                "quality": arr[4],
                "context": arr[0],
                "craftedQuality": arr[1],
                "upgrade": upgrade,
                "enchant": get_enchant_text(enchant_ids[0]) if enchant_ids else None,
                "gems": [
                    {
                        "itemId": gid,
                        "name": item_names.get(gid, f"Item #{gid}"),
                        "wowheadUrl": wowhead_url(gid),
                    }
                    for gid in gem_ids
                ],
                "isTierPiece": is_tier_piece,
                "wowheadUrl": wowhead_url(
                    item_id, bonus_ids=bonus_ids, enchant_ids=enchant_ids,
                    gem_ids=gem_ids, item_level=arr[3] or None,
                ),
            })

        # Bag/bank contents. Only available with an authenticated session
        # (SESSION_COOKIE) -- wowthing's public feed never includes these
        # (only equipped bag containers), confirmed against their backend
        # source. With no cookie this list is just always empty.
        bag_items_out = []
        for item in (raw_items or []):
            location, bag_id, slot, item_id, count = item[0], item[1], item[2], item[3], item[4]
            if slot == 0:
                continue  # a bag container itself, not something inside a bag
            item_level = item[8] if len(item) > 8 else 0
            quality = item[9] if len(item) > 9 else 1
            bag_items_out.append({
                "itemId": item_id,
                "itemName": item_names.get(item_id, f"Item #{item_id}"),
                "count": count,
                "itemLevel": item_level,
                "quality": quality,
                "location": {1: "Bags", 2: "Bank", 3: "Reagent Bank", 5: "Warband Bank"}.get(location, "Bags"),
                "category": item_category_name(item_id),
                "wowheadUrl": wowhead_url(item_id, item_level=item_level or None),
            })
        bag_items_out = merge_item_stacks(bag_items_out)

        # Used internally below to build raidGrids (the actual UI-facing
        # boss-kill data); not shipped in the output itself, since raidGrids
        # already covers everything the frontend needs from it.
        lockouts_out = []
        for key, lo in (lockouts or {}).items():
            lockouts_out.append({
                "name": lo.get("name"),
                "difficulty": lo.get("difficulty"),
                "difficultyName": DIFFICULTY_NAMES.get(lo.get("difficulty"), f"Difficulty {lo.get('difficulty')}"),
                "defeatedBosses": lo.get("defeatedBosses"),
                "maxBosses": lo.get("maxBosses"),
                "resetTime": lo.get("resetTime"),
                "locked": lo.get("locked"),
                "bosses": lo.get("bosses", []),
            })
        lockouts_out.sort(key=lambda x: (x["name"] or "", x["difficulty"] or 0))

        # --- Mythic+ dungeon scores for the current season --------------
        season_key = str(MYTHIC_PLUS_SEASON_ID)
        season_scores = (raw_mythic_plus_seasons or {}).get(season_key, {})
        dungeon_scores_out = []
        total_score = 0
        for map_id, dungeon_name in MYTHIC_PLUS_DUNGEONS:
            entry = season_scores.get(str(map_id))
            if entry:
                overall_score = entry[0] or 0
                # entry[1] = fortified [level,score,duration,overTime], entry[2] = tyrannical
                fortified = entry[1] if len(entry) > 1 else None
                tyrannical = entry[2] if len(entry) > 2 else None
                best_affix = tyrannical or fortified
                dungeon_level = best_affix[0] if best_affix else 0
                total_score += overall_score
                dungeon_scores_out.append({
                    "mapId": map_id,
                    "name": dungeon_name,
                    "level": dungeon_level,
                    "score": round(overall_score),
                })
            else:
                dungeon_scores_out.append({
                    "mapId": map_id, "name": dungeon_name, "level": 0, "score": 0,
                })

        rio = (raider_io or {}).get(season_key, {})
        rating = rio.get("all") if rio.get("all") else round(total_score)

        # --- Current keystone + weekly vault -----------------------------
        current_keystone = None
        vault_raid = []
        vault_dungeon = []
        vault_world = []
        if raw_weekly:
            keystone_dungeon = raw_weekly[5] if len(raw_weekly) > 5 else 0
            keystone_level = raw_weekly[6] if len(raw_weekly) > 6 else 0
            if keystone_dungeon:
                current_keystone = {
                    "dungeonName": dungeon_name_by_id.get(keystone_dungeon, f"Dungeon #{keystone_dungeon}"),
                    "level": keystone_level,
                }

            raid_progress = raw_weekly[11] if len(raw_weekly) > 11 else []
            for slot in (raid_progress or []):
                slot_level, slot_tier, slot_progress, slot_threshold = slot[0], slot[1], slot[2], slot[3]
                met = slot_progress >= slot_threshold and slot_threshold > 0
                vault_raid.append({
                    "met": met,
                    "label": RAID_DIFFICULTY_SHORT.get(slot_level, str(slot_level)) if met else None,
                })

            dungeon_progress = raw_weekly[10] if len(raw_weekly) > 10 else []
            for slot in (dungeon_progress or []):
                slot_level, slot_tier, slot_progress, slot_threshold = slot[0], slot[1], slot[2], slot[3]
                met = slot_progress >= slot_threshold and slot_threshold > 0
                vault_dungeon.append({
                    "met": met,
                    "label": str(slot_level) if met and slot_level else None,
                })

            # World content (Delves, World Quests, etc). Unlike raid/dungeon,
            # "level" here isn't a difficulty or keystone level we can map to
            # a clean label, so we show the reward item level instead --
            # unambiguous and directly useful, rather than guessing at what
            # a raw numeric "level" means for this category.
            world_progress = raw_weekly[12] if len(raw_weekly) > 12 else []
            for slot in (world_progress or []):
                slot_item_level, slot_progress, slot_threshold = slot[4], slot[2], slot[3]
                met = slot_progress >= slot_threshold and slot_threshold > 0
                vault_world.append({
                    "met": met,
                    "label": str(slot_item_level) if met and slot_item_level else None,
                })

        # --- Raid boss-kill grids (one per detected raid, by difficulty) -
        lockouts_by_name_diff = {}
        for lo in lockouts_out:
            lockouts_by_name_diff[(lo["name"], lo["difficulty"])] = lo

        raid_grids = {}
        for raid in raids:
            grid = {}
            for diff in raid["difficulties"]:
                lo = lockouts_by_name_diff.get((raid["name"], diff["id"]))
                if lo:
                    dead_by_name = {b.get("name"): b.get("dead") for b in lo.get("bosses", [])}
                    row = [dead_by_name.get(boss_name) for boss_name in raid["bosses"]]
                else:
                    row = [None] * len(raid["bosses"])
                grid[diff["label"]] = row
            raid_grids[raid["name"]] = grid

        # --- Primary professions (current-expansion skill level) --------
        char_professions = []
        for prof_id, subs in sorted((professions or {}).items(), key=lambda kv: int(kv[0])):
            prof_id = int(prof_id)
            meta = profession_meta.get(prof_id)
            if not meta:
                continue  # secondary profession (cooking/fishing/archaeology)
            sub_data = (subs or {}).get(str(meta["subProfessionId"]))
            char_professions.append({
                "name": meta["name"],
                "currentSkill": sub_data["currentSkill"] if sub_data else 0,
                "maxSkill": sub_data["maxSkill"] if sub_data else 100,
            })
        char_professions.sort(key=lambda p: p["name"])

        characters_out.append({
            "id": char_id,
            "name": name,
            "level": level,
            "itemLevel": equipped_item_level,
            "classId": class_id,
            "raceId": race_id,
            "realmId": realm_id,
            "gender": gender,
            "faction": faction,
            "gold": gold,
            "equipped": equipped_out,
            "bagItems": bag_items_out,
            "tierPieceCount": tier_piece_count,
            "currencies": {
                "crests": currency_group(raw_currencies, CREST_IDS),
                "catalyst": currency_group(raw_currencies, CATALYST_IDS),
                "bonusRolls": currency_group(raw_currencies, BONUS_ROLL_IDS),
            },
            "mythicPlus": {
                "rating": rating,
                "currentKeystone": current_keystone,
                "dungeonScores": dungeon_scores_out,
            },
            "vault": {
                "raid": vault_raid,
                "dungeon": vault_dungeon,
                "world": vault_world,
            },
            "raidGrids": raid_grids,
            "professions": char_professions,
        })

    # --- Backfill missing item levels from other items' known track/rank --
    # The addon API sometimes reports itemLevel as 0 for a random equipped
    # item (a known wowthing/Blizzard-API quirk, not something specific to
    # any one item). Rather than guess at hardcoded per-track ranges, derive
    # the real rank->itemLevel mapping empirically from every OTHER item in
    # this same dataset that reports both its upgrade rank and a correct
    # (non-zero) item level -- then use that table to fill in the gaps.
    # Filled-in values are marked itemLevelEstimated so the UI can be
    # transparent about which numbers came directly from the API.
    track_rank_ilvl = {}
    for c_out in characters_out:
        for e in c_out["equipped"]:
            if e["itemLevel"] > 0 and e["upgrade"]:
                key = (e["upgrade"]["track"], e["upgrade"]["rank"])
                track_rank_ilvl.setdefault(key, e["itemLevel"])

    backfilled = 0
    for c_out in characters_out:
        for e in c_out["equipped"]:
            if e["itemLevel"] == 0 and e["upgrade"]:
                key = (e["upgrade"]["track"], e["upgrade"]["rank"])
                if key in track_rank_ilvl:
                    e["itemLevel"] = track_rank_ilvl[key]
                    e["itemLevelEstimated"] = True
                    backfilled += 1
    if backfilled:
        print(f"Backfilled {backfilled} missing item levels from track/rank data")

    # --- Convert World vault reward item levels into track letters --------
    # "level" doesn't map cleanly to a readable label for world content, but
    # the reward *item level* corresponds to a gear upgrade track, which
    # matches the single-letter badges used elsewhere on this page (Hero,
    # Myth, etc). Track floors are derived from this account's own equipped
    # gear where possible (same table as the item-level backfill above);
    # Veteran's floor (279) is hand-confirmed since no character currently
    # has Veteran-track gear equipped to derive it from automatically.
    TRACK_LETTER = {"Veteran": "V", "Champion": "C", "Hero": "H", "Myth": "M"}
    track_floor = {"Veteran": 279}
    for (track, rank), ilvl in track_rank_ilvl.items():
        track_floor[track] = min(track_floor.get(track, ilvl), ilvl)

    def ilvl_to_track_letter(ilvl):
        candidates = [(floor, track) for track, floor in track_floor.items() if ilvl >= floor]
        if not candidates:
            return None
        _, best_track = max(candidates)
        return TRACK_LETTER.get(best_track)

    for c_out in characters_out:
        for slot in c_out["vault"]["world"]:
            if slot["met"] and slot["label"]:
                letter = ilvl_to_track_letter(int(slot["label"]))
                if letter:
                    slot["label"] = letter

    characters_out.sort(key=lambda c: (-c["itemLevel"]))

    output = {
        "account": WOWTHING_USER,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "minLevel": MIN_LEVEL,
        "minItemLevel": MIN_ITEM_LEVEL,
        "warbandGold": user_data.get("warbankGold", 0),
        "warbandItems": warband_items_out,
        "hasPrivateData": bool(SESSION_COOKIE),
        "classes": classes,
        "races": races,
        "realms": realms,
        "qualityColors": QUALITY_COLORS,
        "raids": raids,
        "mythicPlusDungeons": [{"mapId": m, "name": n} for m, n in MYTHIC_PLUS_DUNGEONS],
        "characters": characters_out,
    }

    with open("data.json", "w") as f:
        json.dump(output, f, indent=1)

    print(f"Wrote data.json with {len(characters_out)} characters.")


if __name__ == "__main__":
    main()
