(function () {
  "use strict";

  // ---------------- Encrypted-site lock screen ----------------
  // Reused from app.js so this page shares the same passphrase/session as
  // the roster page -- if you're already unlocked there (in this browser),
  // this page won't re-prompt. See app.js for the fuller explanation of
  // the crypto approach; this only needs it to VALIDATE the passphrase
  // (by test-decrypting data.json), not to actually use the roster data.
  const PASSPHRASE_STORAGE_KEY = "roster_passphrase";

  // Same mapping as app.js, duplicated here since there's no module system
  // on this site to share it from.
  const CLASS_COLORS = {
    warrior: "#C79C6E", paladin: "#F58CBA", hunter: "#ABD473", rogue: "#FFF569",
    priest: "#FFFFFF", "death-knight": "#C41F3B", shaman: "#0070DE", mage: "#69CCF0",
    warlock: "#9482C9", monk: "#00FF96", druid: "#FF7D0A", "demon-hunter": "#A330C9",
    evoker: "#33937F",
  };

  // Maps a signup's charRealm text (e.g. "ctadruid-tichondrius") to
  // { displayName, classColor } by matching it against the roster data's
  // characters -- realm slugs there (e.g. "tichondrius") line up exactly
  // with what appears in the signup text. Populated once at startup from
  // whatever roster data ensureUnlocked() already fetched/decrypted; if
  // that's unavailable for any reason, lookups simply miss and the raw
  // charRealm text is shown as a fallback (see renderCalendar).
  let CHARACTER_LOOKUP = {};

  // False until the first sync-from-remote attempt of this page load has
  // completed (successfully or not). Guards against a real bug: the page
  // renders immediately with whatever's cached in local storage from a
  // possibly-stale previous session, before the sync has pulled the
  // latest shared state -- if that stale local data happens to contain
  // an expired entry, pruning it would otherwise push right away and can
  // overwrite whatever another device more recently synced, since it's
  // pushing a state that was never reconciled with the remote one. See
  // pruneExpiredEntries.
  let initialSyncDone = false;

  function buildCharacterLookup(rosterData) {
    const lookup = {};
    if (!rosterData || !rosterData.characters) return lookup;
    for (const char of rosterData.characters) {
      const realm = rosterData.realms && rosterData.realms[char.realmId];
      const cls = rosterData.classes && rosterData.classes[char.classId];
      if (!realm || !realm.slug || !char.name) continue;
      const key = `${char.name.toLowerCase()}-${realm.slug.toLowerCase()}`;
      lookup[key] = {
        displayName: char.name,
        classColor: (cls && CLASS_COLORS[cls.slug]) || null,
      };
    }
    return lookup;
  }

  function base64ToBuffer(b64) {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }

  function bufferToBase64(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)));
  }

  async function decryptEnvelope(envelope, passphrase) {
    const salt = base64ToBuffer(envelope.salt);
    const iv = base64ToBuffer(envelope.iv);
    const ciphertext = base64ToBuffer(envelope.ciphertext);
    const passKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: envelope.iterations, hash: "SHA-256" },
      passKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
    );
    const plaintextBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return JSON.parse(new TextDecoder().decode(plaintextBuf));
  }

  // The encrypt-side counterpart to decryptEnvelope -- same format/
  // algorithm/iteration count as the Python-side encryption used for
  // data.json (AES-256-GCM, PBKDF2-SHA256, 250k iterations), so it's
  // consistent even though this is a separate encryption context (the
  // raid data never touches data.json itself).
  const SYNC_PBKDF2_ITERATIONS = 250000;

  async function encryptForSync(passphrase, data) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const passKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: SYNC_PBKDF2_ITERATIONS, hash: "SHA-256" },
      passKey, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
    );
    const plaintextBuf = new TextEncoder().encode(JSON.stringify(data));
    const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintextBuf);
    return {
      encrypted: true,
      salt: bufferToBase64(salt),
      iv: bufferToBase64(iv),
      ciphertext: bufferToBase64(ciphertextBuf),
      iterations: SYNC_PBKDF2_ITERATIONS,
    };
  }

  function promptForPassphrase(envelope) {
    return new Promise((resolve) => {
      const lockScreen = document.getElementById("lock-screen");
      const form = document.getElementById("lock-form");
      const input = document.getElementById("lock-input");
      const errorEl = document.getElementById("lock-error");

      document.body.classList.add("is-locked");
      lockScreen.hidden = false;
      errorEl.hidden = true;
      input.value = "";
      input.focus();

      const onSubmit = async (e) => {
        e.preventDefault();
        try {
          const decrypted = await decryptEnvelope(envelope, input.value);
          try { localStorage.setItem(PASSPHRASE_STORAGE_KEY, input.value); } catch (err) { /* fine */ }
          form.removeEventListener("submit", onSubmit);
          lockScreen.hidden = true;
          document.body.classList.remove("is-locked");
          resolve(decrypted);
        } catch (err) {
          errorEl.hidden = false;
          input.select();
        }
      };
      form.addEventListener("submit", onSubmit);
    });
  }

  async function ensureUnlocked() {
    let rawData;
    try {
      const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
      rawData = await res.json();
    } catch (err) {
      return null; // can't reach data.json -- proceed unlocked rather than block the page entirely
    }
    if (!rawData || !rawData.encrypted) return rawData; // not encrypted -- this IS the roster data already

    let saved = null;
    try { saved = localStorage.getItem(PASSPHRASE_STORAGE_KEY); } catch (err) { /* fine */ }
    if (saved) {
      try {
        return await decryptEnvelope(rawData, saved); // cached passphrase valid
      } catch (err) {
        try { localStorage.removeItem(PASSPHRASE_STORAGE_KEY); } catch (e2) { /* fine */ }
      }
    }
    return await promptForPassphrase(rawData);
  }

  // ---------------- Signup text parser ----------------
  // Format (2 lines per raid), validated against real pasted examples:
  //   Raid #<id> — <Seller> <Title>[ Saved]
  //   <Weekday>, <Month> <Day>, <Year> at <Time> <Difficulty> • RL: <Seller>
  //     <char-realm> — <Role> | <Difficulty> •  <Saved|Unsaved> [<ilvl>ilvl]
  // Spacing between fields is inconsistent (mix of regular and full-width
  // spaces), so the regex matches on \s+ generically rather than literal
  // spaces. The title line sometimes has a trailing " Saved" with no
  // separator -- that's redundant with the detail line's own field and is
  // stripped.
  // Month name -> zero-padded number, for building a sortable key directly
  // from the parsed text (see note below on why we avoid new Date() here).
  const MONTH_NUMBERS = {
    january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  };

  // For rebuilding an entry's display fields (weekday, monthName, timeStr,
  // etc.) from a datetime-local edit -- see datetimeLocalToFields below.
  const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // Converts a datetime-local input's value ("YYYY-MM-DDTHH:MM") into the
  // full set of display fields an entry stores (weekday, monthName, day,
  // year, timeStr, dateKey, sortKey). Uses Date.UTC() purely as a
  // calendar calculator (to derive the weekday name) -- there's no real
  // timezone conversion happening, same principle as computeWeekIndex/
  // entryTimestampMs elsewhere in this file: these are plain Central-time
  // calendar values, never actually converted through any timezone.
  function datetimeLocalToFields(value) {
    const [datePart, timePart] = value.split("T");
    const [year, month, day] = datePart.split("-").map(Number);
    const [hour, minute] = timePart.split(":").map(Number);
    const weekdayIndex = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    const ampm = hour < 12 ? "AM" : "PM";
    const pad = (n) => String(n).padStart(2, "0");
    return {
      weekday: WEEKDAY_NAMES[weekdayIndex],
      monthName: MONTH_NAMES[month - 1],
      day: String(day),
      year: String(year),
      timeStr: `${hour12}:${pad(minute)} ${ampm}`,
      dateKey: `${year}-${pad(month)}-${pad(day)}`,
      sortKey: `${year}-${pad(month)}-${pad(day)}-${pad(hour)}-${pad(minute)}`,
    };
  }

  // Uses "Raid #<id>" as the entry boundary rather than assuming a fixed
  // number of lines per entry -- a raw clipboard paste from the real page
  // breaks lines differently (and into more pieces, sometimes with icon
  // glyphs on their own line) than manually-typed/reformatted text does.
  // Each entry's lines (after the title line) are joined into one string
  // and fields are pulled out by content, not position, so it doesn't
  // matter how the source broke them up.
  function parseSignupText(text) {
    const normalized = text.replace(/\r\n/g, "\n");
    const rawBlocks = normalized.split(/(?=Raid #\d+)/).map((b) => b.trim()).filter((b) => b.length > 0);
    const entries = [];
    const errors = [];

    for (const block of rawBlocks) {
      // Text before the first "Raid #..." match (e.g. a page header like
      // "Your Active Raid Signups") ends up as its own leading block that
      // doesn't itself start with "Raid #" -- skip it silently rather than
      // reporting a parse error, since it's expected boilerplate.
      if (!/^Raid #\d+/.test(block)) continue;

      const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      const titleLine = lines[0];
      const titleMatch = titleLine.match(/^Raid #(\d+)\s*[—-]\s*(\S+)\s+(.+)$/);
      if (!titleMatch) {
        errors.push(`Couldn't parse title line: "${titleLine}"`);
        continue;
      }
      const [, raidId, sellerFromTitle, titleRest] = titleMatch;
      const title = titleRest.replace(/\s+Saved$/, "").trim();

      const rest = lines.slice(1)
        .map((l) => l.replace(/^[^\w]+/u, "").trim()) // strip any leading icon/emoji glyphs
        .filter((l) => l.length > 0)
        .join(" ");

      // Captured as individual components (weekday, month name, day, year,
      // hour, minute, am/pm) rather than one date string handed to
      // new Date(). new Date() on a string with no explicit timezone gets
      // interpreted as the BROWSER'S local time, then a later
      // .toISOString() converts it to UTC -- for a late-night entry (e.g.
      // 11:30 PM) in any timezone behind UTC, that conversion can roll the
      // date to the next day, which then shifts by a further, different
      // amount when formatted back for display. That mismatch is exactly
      // what caused a Thursday entry to visually group under a Wednesday
      // header. Working entirely from the parsed components below avoids
      // any UTC round-trip, so the weekday/date/time shown always matches
      // the source text exactly, and sorting is a plain string comparison
      // on zero-padded values -- no timezone involved at any point.
      const dateMatch = rest.match(/(\w+), (\w+) (\d{1,2}), (\d{4})\s*(?:at\s+)?(\d{1,2}):(\d{2})\s*([AP]M)/);
      const diffMatch = rest.match(/\b(Heroic|Mythic|Normal|LFR)\b/);
      const rlMatch = rest.match(/RL:\s*(\S+)/);

      // A single raid signup can list MORE THAN ONE character -- applying
      // with either one, whichever ends up picked. Each looks like
      // "<char-realm> — <Role> | <Difficulty> • [icon] <Saved|Unsaved>",
      // repeated once per candidate character, so this matches all of them
      // rather than just the first.
      const CHAR_LINE_REGEX = /([a-z0-9']+-[a-z0-9']+)\s*[\u2014-]\s*(Tank|Healer|Dps|DPS)\s*\|\s*(\w+)\s*\u2022\s*[^\w]*(Saved|Unsaved)/gi;
      const characters = [];
      let charMatch;
      let lastCharEnd = 0;
      while ((charMatch = CHAR_LINE_REGEX.exec(rest)) !== null) {
        characters.push({
          charRealm: charMatch[1],
          role: charMatch[2],
          saved: charMatch[4] === "Saved",
        });
        lastCharEnd = CHAR_LINE_REGEX.lastIndex;
      }

      if (!dateMatch || !diffMatch || !rlMatch || characters.length === 0) {
        errors.push(`Couldn't parse detail fields for raid #${raidId} from: "${rest}"`);
        continue;
      }

      // Whatever free-text the seller put in the signup's Notes field
      // trails after the LAST character's Saved/Unsaved status -- not
      // always "###ilvl", could be anything, so this is captured as-is
      // rather than matched against a specific pattern.
      const afterLastChar = rest.slice(lastCharEnd).trim();
      const note = afterLastChar.length > 0 ? afterLastChar : null;

      const [, weekday, monthName, dayStr, yearStr, hourStr, minuteStr, ampm] = dateMatch;
      const monthNum = MONTH_NUMBERS[monthName.toLowerCase()];
      let hour24 = parseInt(hourStr, 10) % 12;
      if (ampm.toUpperCase() === "PM") hour24 += 12;
      const day = dayStr.padStart(2, "0");
      const hour = String(hour24).padStart(2, "0");
      const minute = minuteStr.padStart(2, "0");

      entries.push({
        raidId,
        seller: sellerFromTitle,
        title,
        weekday,
        monthName,
        day: dayStr,
        year: yearStr,
        // Times in the source signup text are always Central Time -- this
        // is stored as plain text and displayed with a "CT" label at
        // render time (see renderCalendar), never converted to/from any
        // other timezone.
        timeStr: `${hourStr}:${minuteStr} ${ampm.toUpperCase()}`,
        dateKey: monthNum ? `${yearStr}-${monthNum}-${day}` : null,
        sortKey: monthNum ? `${yearStr}-${monthNum}-${day}-${hour}-${minute}` : null,
        difficulty: diffMatch[1],
        rl: rlMatch[1],
        characters,
        note,
      });
    }
    return { entries, errors };
  }

  // ---------------- Storage ----------------
  const STORAGE_KEY = "raid_sales_entries";
  const HISTORY_STORAGE_KEY = "raid_sales_history";

  // Migrates entries saved before multi-character signups were supported
  // (single top-level charRealm/role/saved + boolean rostered) into the
  // current shape (characters: [...] + rosteredCharRealm), so existing
  // saved data and rostered picks aren't lost by this update.
  function migrateEntry(entry) {
    if (entry.characters) return entry; // already current shape
    const { charRealm, role, saved, rostered, ...rest } = entry;
    return {
      ...rest,
      characters: charRealm ? [{ charRealm, role, saved }] : [],
      rosteredCharRealm: rostered && charRealm ? charRealm : null,
    };
  }

  function loadEntries() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const migrated = {};
      for (const [id, entry] of Object.entries(parsed)) {
        migrated[id] = migrateEntry(entry);
      }
      return pruneExpiredEntries(migrated);
    } catch (err) {
      return {};
    }
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      return [];
    }
  }

  function saveHistoryLocal(history) {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
    } catch (err) {
      // storage unavailable/full -- nothing we can do client-side about this
    }
  }

  // Local-only write, no remote sync -- used when writing data that just
  // came FROM the remote (see syncFromRemote), so that doesn't immediately
  // trigger a redundant push right back to the same bin.
  function saveEntriesLocal(entries) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (err) {
      // storage unavailable/full -- nothing we can do client-side about this
    }
  }

  // Normal write path: saves locally (so the UI/offline case always works
  // immediately) and fires off a remote push in the background. The push
  // is fire-and-forget -- callers don't wait on it, since local storage is
  // the source of truth for the current tab and network issues shouldn't
  // block the UI. History syncs bundled in with entries (see
  // pushRemoteEntries) rather than as a separate call, so a single push
  // covers whatever just changed -- calling saveEntries() after touching
  // history alone (with entries unchanged) is the correct way to sync a
  // history-only change too.
  function saveEntries(entries) {
    saveEntriesLocal(entries);
    pushRemoteEntries(entries).catch(() => { /* see pushRemoteEntries for handling */ });
  }

  // ---------------- Cross-device sync (JSONBin) ----------------
  // The signup data is encrypted client-side with the same passphrase
  // used to unlock the roster page (see encryptForSync/decryptEnvelope)
  // before it's ever sent to JSONBin, so the remote bin only ever holds
  // an opaque encrypted blob -- anyone who found the API key embedded in
  // this public JS file could read/write the blob, but not its contents
  // without the passphrase. This is the same privacy model as data.json.
  //
  // JSONBIN_BIN_ID is the one shared bin every device/browser syncs with.
  // It was auto-created by the first real push (the code below still
  // handles an empty id by creating a bin and surfacing its id in an
  // on-page notice, which is how this one was obtained) -- if the bin is
  // ever deleted or a fresh one is wanted, clear this to "" and reload
  // once to re-run that setup.
  const JSONBIN_ACCESS_KEY = "$2a$10$8xzRy4CIE0RmppjXg5MKV.9GN.GfKkXqcCgpgWHavTTEC.7jnb/ku";
  const JSONBIN_BIN_ID = "6aa91b57ffd5d1605309391a";
  const JSONBIN_BASE_URL = "https://api.jsonbin.io/v3/b";

  function getSavedPassphrase() {
    try {
      return localStorage.getItem(PASSPHRASE_STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  // Shown once, on-page, when a bin gets auto-created -- this id needs to
  // be reported back and hardcoded into JSONBIN_BIN_ID so all
  // devices/browsers share the same bin afterward. Not using alert()
  // since that's a blocking, dismiss-and-forget pattern; this stays
  // visible until the page is reloaded (by which point, once the id is
  // hardcoded, it won't show again).
  function showBinCreatedNotice(binId) {
    if (document.getElementById("raids-sync-notice")) return; // already shown
    const el = document.createElement("div");
    el.id = "raids-sync-notice";
    el.className = "raids-sync-notice";
    el.textContent = `Cross-device sync set up for the first time -- send this bin ID to Claude so it can be saved: ${binId}`;
    const main = document.querySelector("main.page");
    if (main) main.insertBefore(el, main.firstChild);
  }

  async function pushRemoteEntries(entries) {
    const passphrase = getSavedPassphrase();
    if (!passphrase) return; // not unlocked yet, nothing to sync with
    // Bundles history in alongside entries so both sync together as one
    // payload -- see syncFromRemote for the backward-compat handling of
    // bins that still hold the old shape (entries only, no wrapper).
    const payload = { entries, history: loadHistory() };
    let envelope;
    try {
      envelope = await encryptForSync(passphrase, payload);
    } catch (err) {
      return; // encryption failed, skip this push
    }
    try {
      if (!JSONBIN_BIN_ID) {
        const res = await fetch(JSONBIN_BASE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Access-Key": JSONBIN_ACCESS_KEY },
          body: JSON.stringify(envelope),
        });
        if (!res.ok) return;
        const data = await res.json();
        const newBinId = data && data.metadata && data.metadata.id;
        if (newBinId) showBinCreatedNotice(newBinId);
        return;
      }
      await fetch(`${JSONBIN_BASE_URL}/${JSONBIN_BIN_ID}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Access-Key": JSONBIN_ACCESS_KEY },
        body: JSON.stringify(envelope),
      });
    } catch (err) {
      // network failure -- local save already happened; the next save
      // (or the next page load's sync) will try again
    }
  }

  // Called once at startup (see init) to pull in whatever the latest
  // synced state is before the first render. Last-write-wins: if the
  // remote fetch succeeds, it replaces local storage outright. This has
  // one known edge case -- reloading the page in the same second as a
  // save, before that save's push has finished propagating, could
  // momentarily show the pre-save state until the next successful sync.
  // Given single-user, mostly-one-device-at-a-time usage, this is an
  // acceptable tradeoff for the simplicity of not needing real
  // conflict resolution.
  async function syncFromRemote() {
    if (!JSONBIN_BIN_ID) return;
    const passphrase = getSavedPassphrase();
    if (!passphrase) return;
    try {
      const res = await fetch(`${JSONBIN_BASE_URL}/${JSONBIN_BIN_ID}`, {
        headers: { "X-Access-Key": JSONBIN_ACCESS_KEY },
      });
      if (!res.ok) return;
      const data = await res.json();
      const envelope = data && data.record;
      if (!envelope || !envelope.encrypted) return;
      const remotePayload = await decryptEnvelope(envelope, passphrase);
      // Bins synced before history existed hold entries as the top-level
      // object directly (keyed by raid id), not wrapped in {entries,
      // history}. Detect the wrapper shape explicitly rather than assuming
      // it, so old synced data keeps working without needing a re-push.
      const hasWrapper = remotePayload && typeof remotePayload === "object" &&
        "entries" in remotePayload && "history" in remotePayload;
      const remoteEntries = hasWrapper ? remotePayload.entries : remotePayload;
      const remoteHistory = hasWrapper ? remotePayload.history : [];
      const migrated = {};
      for (const [id, entry] of Object.entries(remoteEntries || {})) {
        migrated[id] = migrateEntry(entry);
      }
      saveHistoryLocal(remoteHistory || []);
      saveEntriesLocal(pruneExpiredEntries(migrated, { skipRemotePush: true }));
    } catch (err) {
      // network/decrypt failure -- fall back to whatever's already local
    }
  }

  function mergeParsedEntries(existing, parsed) {
    for (const entry of parsed) {
      const prior = existing[entry.raidId];
      // Keep a prior rostered pick only if that character is still among
      // this entry's candidates (a re-paste could in principle change who
      // applied) -- otherwise treat it as not-yet-rostered again.
      const priorPick = prior ? prior.rosteredCharRealm : null;
      const stillValid = priorPick && entry.characters.some((c) => c.charRealm === priorPick);
      existing[entry.raidId] = {
        ...entry,
        rosteredCharRealm: stillValid ? priorPick : null,
      };
    }
    return existing;
  }

  // ---------------- Conflict detection ----------------
  // Rules (as described): a character can only be genuinely "Unsaved" to a
  // given raid+difficulty once per reset week; if they're doing both an
  // Unsaved run and Saved runs for that raid+difficulty that week, the
  // Unsaved one must happen first (you get your own clear, then sell saves
  // afterward -- a Saved run before the Unsaved one, or two Unsaved runs
  // the same week, both indicate a scheduling mistake).

  // Sept 1, 2026 10:00 is a real Tuesday reset moment, used purely as an
  // arbitrary fixed reference point for bucketing weeks -- any Tuesday
  // 10am works equally well here, this one isn't special otherwise.
  const REF_RESET_UTC_MS = Date.UTC(2026, 8, 1, 10, 0);
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // Computed via Date.UTC() with explicit numeric components (not by
  // parsing a string with new Date()), which does NOT consult the
  // browser's local timezone at all -- it just does calendar arithmetic on
  // the numbers given. That keeps this consistent with the rest of the
  // date handling here: entries are treated as plain Central-time
  // calendar values, never converted through any actual timezone.
  function computeWeekIndex(entry) {
    if (!entry.sortKey) return null;
    const [year, month, day, hour, minute] = entry.sortKey.split("-").map(Number);
    const ms = Date.UTC(year, month - 1, day, hour, minute);
    return Math.floor((ms - REF_RESET_UTC_MS) / WEEK_MS);
  }

  // Reduces "The Venomous Abyss 9/9H + Group 2 Ula'tek" and
  // "The Venomous Abyss 9/9N" down to the same "The Venomous Abyss" key --
  // the lockout is per raid zone, not per specific sell package/progress
  // count, and difficulty is already tracked separately.
  function normalizeRaidName(title) {
    return title
      .replace(/\s*\+\s*Group\s*\d+.*/i, "")
      .replace(/\s*\d+\/\d+[A-Za-z]+\s*$/, "")
      .trim();
  }

  // Numeric ms value for an entry's start time, via Date.UTC() with
  // explicit numeric components (same technique as computeWeekIndex) --
  // pure arithmetic on the parsed numbers, no timezone/Date-string-parsing
  // involved, so this stays consistent across any viewer's browser.
  function entryTimestampMs(entry) {
    if (!entry.sortKey) return null;
    const [year, month, day, hour, minute] = entry.sortKey.split("-").map(Number);
    return Date.UTC(year, month - 1, day, hour, minute);
  }

  // The "now" equivalent of entryTimestampMs(): the current moment,
  // expressed as the same kind of naive Date.UTC() value built from
  // Central Time's wall-clock Y/M/D/H/M -- NOT a real UTC timestamp,
  // since entry timestamps aren't real UTC either (see entryTimestampMs).
  // Comparing actual UTC epoch time against entry timestamps directly
  // would be off by Central's offset from UTC (5 or 6 hours depending on
  // DST); this keeps both sides of the comparison in the same units.
  // Uses the same offset-conversion technique as the roster page's weekly
  // reset countdown, which has been verified correct across DST
  // transitions.
  function nowAsCentralNaiveMs() {
    const now = new Date();
    const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
    const centralStr = now.toLocaleString("en-US", { timeZone: "America/Chicago" });
    const offsetMin = (new Date(centralStr) - new Date(utcStr)) / 60000;
    const centralNow = new Date(now.getTime() + offsetMin * 60000);
    return Date.UTC(
      centralNow.getUTCFullYear(), centralNow.getUTCMonth(), centralNow.getUTCDate(),
      centralNow.getUTCHours(), centralNow.getUTCMinutes(), centralNow.getUTCSeconds()
    );
  }

  const EXPIRE_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours past start time

  function fmtNumber(n) {
    return (n || 0).toLocaleString("en-US");
  }

  // Turns an expiring entry into a history record -- only the rostered
  // character's info matters here (the other candidate(s), if any, never
  // actually got played and aren't part of the sales record).
  function buildHistoryRecord(entry) {
    const rosteredChar = (entry.characters || []).find((c) => c.charRealm === entry.rosteredCharRealm);
    return {
      raidId: entry.raidId,
      title: entry.title,
      difficulty: entry.difficulty,
      rl: entry.rl,
      charRealm: entry.rosteredCharRealm,
      role: rosteredChar ? rosteredChar.role : null,
      saved: rosteredChar ? rosteredChar.saved : null,
      weekday: entry.weekday,
      monthName: entry.monthName,
      day: entry.day,
      year: entry.year,
      timeStr: entry.timeStr,
      sortKey: entry.sortKey,
      // Manually entered by the user afterward -- the payment/commit
      // confirmation bot uses its own unrelated ID scheme, different from
      // this raid's signup id, so there's nothing to auto-fill this from.
      paymentId: null,
      // Gold cut from the payment confirmation -- also nothing to
      // auto-fill from, entered by hand alongside the payment id.
      cut: null,
      // Free-text note, entered by hand -- only shown in the view line
      // when it's actually set, so a blank one doesn't clutter every row.
      note: null,
    };
  }

  // Drops any signup more than 4 hours past its start time -- by then the
  // raid is long over and it's just clutter. Persists the pruned list
  // immediately so this doesn't re-check the same already-expired entries
  // on every subsequent load.
  //
  // The remote push is skipped (local save still happens either way) in
  // two cases: skipRemotePush is passed explicitly when this runs right
  // after syncFromRemote() pulls fresh data, where pushing straight back
  // out would be a redundant GET-then-PUT; and, more importantly,
  // whenever initialSyncDone is still false, meaning this page load
  // hasn't yet reconciled with the remote bin at all -- pushing in that
  // window would risk overwriting a genuinely newer remote state with
  // this browser's own stale, pre-sync local cache. Either way, it
  // reaches the remote bin the next time the user does something that
  // triggers a genuine save after the initial sync has completed.
  function pruneExpiredEntries(entries, { skipRemotePush = false } = {}) {
    const nowMs = nowAsCentralNaiveMs();
    let entriesChanged = false;
    let historyChanged = false;
    const kept = {};
    const history = loadHistory();
    const existingHistoryIds = new Set(history.map((h) => h.raidId));
    for (const [id, entry] of Object.entries(entries)) {
      const entryMs = entryTimestampMs(entry);
      if (entryMs !== null && nowMs - entryMs > EXPIRE_AFTER_MS) {
        entriesChanged = true;
        // Only rostered (actually-played) raids become a history record --
        // an expired signup nobody got picked for isn't a sale, and just
        // disappears the same as before. Guard against double-archiving
        // the same raid id if this runs more than once before a sync
        // catches up (see the sync-layer comment on last-write-wins).
        if (entry.rosteredCharRealm && !existingHistoryIds.has(entry.raidId)) {
          history.push(buildHistoryRecord(entry));
          existingHistoryIds.add(entry.raidId);
          historyChanged = true;
        }
        continue;
      }
      kept[id] = entry;
    }
    if (historyChanged) saveHistoryLocal(history);
    if (entriesChanged || historyChanged) {
      if (skipRemotePush || !initialSyncDone) {
        saveEntriesLocal(kept);
      } else {
        saveEntries(kept);
      }
    }
    return kept;
  }

  const MIN_GAP_MINUTES = 90;

  // Returns a Map<raidId, string[]> of conflict messages (entries with no
  // conflicts simply aren't in the map).
  // Groups every character-candidate across all entries by (character,
  // raid, difficulty, week) -- the natural unit for lockout-related
  // reasoning, since that's exactly the scope a real WoW lockout covers.
  // Shared by detectConflicts (which checks for problems within each
  // group) and computeUnsavedNeeded (which checks for a specific kind of
  // gap: no Unsaved candidate at all yet, in the CURRENT week only).
  function buildLockoutGroups(entries) {
    const list = Object.values(entries).filter((e) => e.sortKey && e.characters && e.characters.length > 0);
    const candidates = [];
    for (const entry of list) {
      const weekIndex = computeWeekIndex(entry);
      if (weekIndex === null) continue;
      for (const char of entry.characters) {
        candidates.push({ entry, charRealm: char.charRealm, saved: char.saved, weekIndex });
      }
    }
    const groups = new Map();
    for (const c of candidates) {
      const key = `${c.charRealm}|${normalizeRaidName(c.entry.title)}|${c.entry.difficulty}|${c.weekIndex}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    return groups;
  }

  // For the CURRENT reset week only: every (character, difficulty) that
  // has an Unsaved run actually scheduled -- these are the ones that need
  // protecting: if that character gets saved to that difficulty by
  // anything else (a different signup, a casual personal run) before the
  // scheduled Unsaved run happens, the sale is ruined. Deduped by
  // character+difficulty (not per-raid) to keep this a short, simple
  // list -- if the same character has Unsaved runs on the same
  // difficulty across two different raids this week, that's still one
  // line, not two.
  function computeUnsavedNeeded(entries) {
    const currentWeekIndex = computeWeekIndex({ sortKey: nowAsSortKey() });
    const nowMs = nowAsCentralNaiveMs();
    const groups = buildLockoutGroups(entries);
    const seen = new Set();
    const needed = [];
    for (const groupCandidates of groups.values()) {
      const first = groupCandidates[0];
      if (first.weekIndex !== currentWeekIndex) continue;
      // Only an Unsaved run that hasn't happened yet still needs
      // protecting -- one already in the past has presumably either
      // already happened (nothing left to protect) or is still sitting
      // as an active signup regardless of what this dashboard says, so
      // there's no value in continuing to warn about it here.
      const hasUpcomingUnsaved = groupCandidates.some((c) => !c.saved && entryTimestampMs(c.entry) > nowMs);
      if (!hasUpcomingUnsaved) continue;
      const key = `${first.charRealm}|${first.entry.difficulty}`;
      if (seen.has(key)) continue;
      seen.add(key);
      needed.push({ charRealm: first.charRealm, difficulty: first.entry.difficulty });
    }
    // Stable, readable order: by character name, then difficulty.
    needed.sort((a, b) =>
      characterName(a.charRealm).localeCompare(characterName(b.charRealm)) ||
      a.difficulty.localeCompare(b.difficulty)
    );
    return needed;
  }

  // sortKey-shaped string for right now, so it can be fed through the same
  // computeWeekIndex() used for entries -- keeps "which week is now in"
  // computed exactly the same way as "which week is this entry in".
  function nowAsSortKey() {
    const ms = nowAsCentralNaiveMs();
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}`;
  }

  function detectConflicts(entries) {
    const groups = buildLockoutGroups(entries);
    const list = Object.values(entries).filter((e) => e.sortKey && e.characters && e.characters.length > 0);

    const conflicts = new Map();
    const addConflict = (raidId, message) => {
      if (!conflicts.has(raidId)) conflicts.set(raidId, []);
      if (!conflicts.get(raidId).includes(message)) conflicts.get(raidId).push(message);
    };

    // Mythic has no ID-extension mechanic the way Heroic/Normal do -- once
    // a character gets their own Mythic kill that week they're locked to
    // it, full stop, so there's no such thing as a legitimate "Saved"
    // Mythic sale. A Mythic entry marked Saved in the data is always a
    // mistake (typo, mislabeled signup, etc.), not a valid state.
    for (const entry of list) {
      if (entry.difficulty !== "Mythic") continue;
      for (const char of entry.characters) {
        if (char.saved) {
          addConflict(entry.raidId, `${characterName(char.charRealm)}: Mythic can't be a Saved run -- Mythic has no ID-extension, so this is likely a mistake`);
        }
      }
    }

    // Start-time proximity check: across ALL signups regardless of
    // character, raid, or difficulty -- this isn't about a lockout, it's
    // about whether the same person can realistically be in two raids that
    // close together. O(n^2) pairwise comparison, but n here is a
    // personal signup list (tens, not thousands), so this is negligible.
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const aMs = entryTimestampMs(a);
      if (aMs === null) continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const bMs = entryTimestampMs(b);
        if (bMs === null) continue;
        const gapMinutes = Math.abs(aMs - bMs) / 60000;
        if (gapMinutes <= MIN_GAP_MINUTES) {
          addConflict(a.raidId, `Starts only ${Math.round(gapMinutes)} min from Raid #${b.raidId}`);
          addConflict(b.raidId, `Starts only ${Math.round(gapMinutes)} min from Raid #${a.raidId}`);
        }
      }
    }

    for (const groupCandidates of groups.values()) {
      const charName = characterName(groupCandidates[0].charRealm);
      const unsaved = groupCandidates.filter((c) => !c.saved);
      const saved = groupCandidates.filter((c) => c.saved);

      if (unsaved.length > 1) {
        for (const c of unsaved) {
          addConflict(c.entry.raidId, `${charName}: ${unsaved.length} Unsaved runs this week for this raid/difficulty (only 1 is possible)`);
        }
      }

      if (unsaved.length === 1) {
        const unsavedCandidate = unsaved[0];
        const earlierOrSameSaved = saved.filter((c) => c.entry.sortKey <= unsavedCandidate.entry.sortKey);
        for (const c of earlierOrSameSaved) {
          addConflict(c.entry.raidId, `${charName}: Scheduled as Saved before the Unsaved run (Raid #${unsavedCandidate.entry.raidId}) for this raid/difficulty this week`);
        }
        if (earlierOrSameSaved.length > 0) {
          addConflict(unsavedCandidate.entry.raidId, `${charName}: This Unsaved run is scheduled after ${earlierOrSameSaved.length} Saved run(s) for this raid/difficulty this week`);
        }
      }
    }

    return conflicts;
  }

  // ---------------- Rendering ----------------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const CONFIRM_ACTION_TIMEOUT_MS = 4000;

  // Wires a two-click "are you sure" pattern onto a button: the first
  // click shows confirmLabel for a few seconds (auto-reverting to
  // normalLabel if it isn't clicked again), and the second click runs
  // onConfirm. Shared by every delete/mark-complete style action on this
  // page that shouldn't fire on a single accidental click.
  function wireConfirmButton(btn, normalLabel, confirmLabel, onConfirm) {
    btn.addEventListener("click", () => {
      if (btn.dataset.confirming === "true") {
        clearTimeout(btn._revertTimer);
        btn.dataset.confirming = "false";
        onConfirm();
      } else {
        btn.dataset.confirming = "true";
        btn.textContent = confirmLabel;
        btn.classList.add("raids-delete-btn-confirm");
        btn._revertTimer = setTimeout(() => {
          btn.dataset.confirming = "false";
          btn.textContent = normalLabel;
          btn.classList.remove("raids-delete-btn-confirm");
        }, CONFIRM_ACTION_TIMEOUT_MS);
      }
    });
  }

  // Just the display name (no color, no HTML) -- used in plain-text
  // contexts like conflict messages. Shares the same lookup/fallback logic
  // as characterDisplay.
  function characterName(charRealm) {
    const match = CHARACTER_LOOKUP[(charRealm || "").toLowerCase()];
    return match ? match.displayName : charRealm;
  }

  // Shows just the character name (no realm), colored by class when the
  // character matches one on the roster. Falls back to the raw
  // "name-realm" text, uncolored, if there's no match (e.g. roster data
  // wasn't available, or it's a character not tracked on the roster).
  function characterDisplay(charRealm) {
    const match = CHARACTER_LOOKUP[(charRealm || "").toLowerCase()];
    if (!match) return escapeHtml(charRealm);
    const style = match.classColor ? ` style="color:${match.classColor}"` : "";
    return `<span${style}>${escapeHtml(match.displayName)}</span>`;
  }

  function renderSummary(entries, conflicts) {
    const list = Object.values(entries);
    const el = document.getElementById("raids-summary-text");
    if (list.length === 0) {
      el.textContent = "No signups added yet.";
      return;
    }
    const rostered = list.filter((e) => e.rosteredCharRealm).length;
    const conflictCount = conflicts ? conflicts.size : 0;
    let text = `${list.length} signup${list.length === 1 ? "" : "s"} \u2014 ${rostered} rostered, ${list.length - rostered} not yet`;
    if (conflictCount > 0) {
      text += ` \u2014 \u26a0 ${conflictCount} with conflicts`;
    }
    el.textContent = text;
    el.classList.toggle("raids-summary-has-conflicts", conflictCount > 0);
  }

  // Which active signups currently have their edit form open, keyed by
  // raid id. Module-level so an in-progress edit survives a re-render
  // triggered by something else (e.g. the periodic conflict recompute).
  const entryEditingIds = new Set();

  function renderCalendar(entries, conflicts) {
    const container = document.getElementById("raids-calendar");
    const list = Object.values(entries);
    if (list.length === 0) {
      container.innerHTML = `<p class="empty-msg">No signups yet. Paste some above to get started.</p>`;
      return;
    }

    // Grouped and sorted using the naive dateKey/sortKey built directly
    // from the parsed text components (see parseSignupText) -- no Date
    // object or UTC conversion involved, so this can't drift from what
    // the source text actually said.
    const groups = new Map();
    for (const entry of list) {
      const key = entry.dateKey || `unparsed:${entry.weekday || ""} ${entry.monthName || ""} ${entry.day || ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    const sortedKeys = [...groups.keys()].sort((a, b) => {
      if (a.startsWith("unparsed:") && b.startsWith("unparsed:")) return a.localeCompare(b);
      if (a.startsWith("unparsed:")) return 1;
      if (b.startsWith("unparsed:")) return -1;
      return a.localeCompare(b);
    });

    let html = "";
    for (const key of sortedKeys) {
      const dayEntries = groups.get(key).slice().sort((a, b) => {
        if (a.sortKey && b.sortKey) return a.sortKey.localeCompare(b.sortKey);
        return 0;
      });
      const first = dayEntries[0];
      const headerText = first.dateKey
        ? `${first.weekday}, ${first.monthName} ${first.day}, ${first.year}`
        : `${first.weekday || "?"}, ${first.monthName || "?"} ${first.day || "?"} (date couldn't be parsed)`;

      html += `<div class="raids-day-header">${escapeHtml(headerText)}</div>`;
      for (const entry of dayEntries) {
        if (entryEditingIds.has(entry.raidId)) {
          // sortKey is "YYYY-MM-DD-HH-MM"; datetime-local needs
          // "YYYY-MM-DDTHH:MM" -- same conversion as history's edit mode.
          let datetimeLocalValue = "";
          if (entry.sortKey) {
            const [year, month, day, hour, minute] = entry.sortKey.split("-");
            datetimeLocalValue = `${year}-${month}-${day}T${hour}:${minute}`;
          }
          const charRows = (entry.characters || []).map((c, idx) => `
            <div class="raids-entry-edit-char-row" data-idx="${idx}">
              <input type="text" class="raids-entry-edit-char-realm" value="${escapeHtml(c.charRealm)}" placeholder="char-realm" />
              <input type="text" class="raids-entry-edit-char-role" value="${escapeHtml(c.role)}" placeholder="role" />
              <label class="raids-entry-edit-char-saved-label">
                <input type="checkbox" class="raids-entry-edit-char-saved" ${c.saved ? "checked" : ""} /> Saved
              </label>
            </div>`).join("");
          html += `
            <div class="raids-entry raids-entry-editing" data-orig-raid-id="${escapeHtml(entry.raidId)}">
              <div class="raids-entry-edit-fields">
                <input type="text" class="raids-entry-edit-raidid" value="${escapeHtml(entry.raidId)}" placeholder="raid id" />
                <input type="text" class="raids-entry-edit-title" value="${escapeHtml(entry.title)}" placeholder="title" />
                <input type="text" class="raids-entry-edit-difficulty" value="${escapeHtml(entry.difficulty)}" placeholder="difficulty" />
                <input type="text" class="raids-entry-edit-rl" value="${escapeHtml(entry.rl)}" placeholder="RL" />
                <input type="datetime-local" class="raids-entry-edit-date" value="${datetimeLocalValue}" />
                <input type="text" class="raids-entry-edit-note" value="${escapeHtml(entry.note || "")}" placeholder="note" />
              </div>
              <div class="raids-entry-edit-chars">${charRows}</div>
              <div class="raids-entry-edit-actions">
                <button class="page-btn raids-entry-save-btn" type="button">Save</button>
                <button class="page-btn raids-entry-cancel-btn" type="button">Cancel</button>
              </div>
            </div>`;
          continue;
        }

        const timeText = entry.timeStr ? `${entry.timeStr} CT` : "";
        const noteText = entry.note ? ` \u2014 ${escapeHtml(entry.note)}` : "";
        const entryConflicts = conflicts.get(entry.raidId);
        const conflictClass = entryConflicts ? " raids-entry-conflict" : "";
        const conflictBlock = entryConflicts
          ? `<div class="raids-entry-conflict-msg">\u26a0 ${entryConflicts.map(escapeHtml).join("; ")}</div>`
          : "";
        const isRostered = !!entry.rosteredCharRealm;
        const characters = entry.characters || [];
        const hasMultipleCandidates = characters.length > 1;

        // Once a character has actually been picked as rostered, only
        // that one is shown -- the other candidate(s) aren't relevant
        // anymore. Before a pick is made (or for single-candidate
        // signups, which have nothing to pick between), all candidates
        // show.
        const displayCharacters = isRostered
          ? characters.filter((c) => c.charRealm === entry.rosteredCharRealm)
          : characters;

        const characterLines = displayCharacters.map((c) => {
          const isThisRostered = entry.rosteredCharRealm === c.charRealm;
          const savedBadgeClass = c.saved ? "raids-badge-saved" : "raids-badge-unsaved";
          return `
            <div class="raids-char-line${isThisRostered ? " raids-char-line-rostered" : ""}">
              ${characterDisplay(c.charRealm)} \u2014 ${escapeHtml(c.role)}
              <span class="raids-badge ${savedBadgeClass}">${c.saved ? "Saved" : "Unsaved"}</span>
              ${isThisRostered ? '<span class="raids-rostered-badge">\u2713 Rostered</span>' : ""}
            </div>`;
        }).join("");

        // The picker exists only to make the pick -- once Rostered is
        // checked AND a specific character has been chosen, there's
        // nothing left to choose, so it goes away along with the other
        // candidates. It only ever appears for multi-candidate signups
        // that haven't been decided yet; checking the box alone doesn't
        // commit to a choice (see the checkbox handler below), so the
        // picker starts on an explicit "choose one" placeholder rather
        // than defaulting to the first candidate.
        const charOptions = characters.map((c) => {
          return `<option value="${escapeHtml(c.charRealm)}">${escapeHtml(characterName(c.charRealm))}</option>`;
        }).join("");
        const charPicker = (hasMultipleCandidates && !isRostered)
          ? `<select class="raids-rostered-char-select" data-raid-id="${escapeHtml(entry.raidId)}" hidden>
               <option value="" selected disabled>Choose character\u2026</option>
               ${charOptions}
             </select>`
          : "";

        html += `
          <div class="raids-entry${isRostered ? " raids-entry-rostered" : ""}${conflictClass}">
            <div class="raids-entry-time">${escapeHtml(timeText)}</div>
            <div class="raids-entry-main">
              <div class="raids-entry-top">
                <span class="raids-entry-title">${escapeHtml(entry.title)}</span>
                <span class="raids-badge">${escapeHtml(entry.difficulty)}</span>
              </div>
              <div class="raids-entry-meta">Raid #${escapeHtml(entry.raidId)} \u00b7 RL: ${escapeHtml(entry.rl)}${noteText}</div>
              <div class="raids-entry-characters">${characterLines}</div>
              ${conflictBlock}
            </div>
            <div class="raids-entry-actions">
              <label class="raids-rostered-toggle">
                <input type="checkbox" class="raids-rostered-checkbox" data-raid-id="${escapeHtml(entry.raidId)}" ${isRostered ? "checked" : ""} />
                Rostered
              </label>
              ${charPicker}
              ${isRostered ? `<button class="raids-entry-action-btn raids-complete-btn" type="button" data-raid-id="${escapeHtml(entry.raidId)}">Mark Complete</button>` : ""}
              <div class="raids-entry-btn-row">
                <button class="raids-entry-action-btn raids-entry-edit-btn" type="button" data-raid-id="${escapeHtml(entry.raidId)}">Edit</button>
                <button class="raids-entry-action-btn raids-delete-btn" type="button" data-raid-id="${escapeHtml(entry.raidId)}">Delete</button>
              </div>
            </div>
          </div>`;
      }
    }
    container.innerHTML = html;

    container.querySelectorAll(".raids-rostered-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        const entries = loadEntries();
        const id = cb.dataset.raidId;
        const entry = entries[id];
        if (!entry) return;
        if (!cb.checked) {
          entry.rosteredCharRealm = null;
          saveEntries(entries);
          render();
        } else if (entry.characters && entry.characters.length === 1) {
          entry.rosteredCharRealm = entry.characters[0].charRealm;
          saveEntries(entries);
          render();
        } else {
          // Multiple candidates: checking the box alone doesn't commit to
          // a choice -- just reveal the (still-undecided) picker so the
          // user can pick one. Nothing is saved until they actually do
          // (see the picker's own handler below), so this is a purely
          // visual, unsaved state; reloading before picking loses it,
          // which is fine since no decision was actually made.
          const picker = cb.closest(".raids-entry").querySelector(".raids-rostered-char-select");
          if (picker) picker.hidden = false;
        }
      });
    });

    container.querySelectorAll(".raids-rostered-char-select").forEach((sel) => {
      sel.addEventListener("change", () => {
        const entries = loadEntries();
        const id = sel.dataset.raidId;
        const entry = entries[id];
        if (!entry) return;
        entry.rosteredCharRealm = sel.value || null;
        saveEntries(entries);
        render();
      });
    });

    container.querySelectorAll(".raids-complete-btn").forEach((btn) => {
      wireConfirmButton(btn, "Mark Complete", "Confirm?", () => {
        const entries = loadEntries();
        const id = btn.dataset.raidId;
        const entry = entries[id];
        if (!entry) return;
        const history = loadHistory();
        if (!history.some((h) => h.raidId === entry.raidId)) {
          history.push(buildHistoryRecord(entry));
          saveHistoryLocal(history);
        }
        lastUndoableAction = { type: "markComplete", entryId: id, entry, raidId: entry.raidId };
        delete entries[id];
        saveEntries(entries);
        showHistoryUndoRow();
        const historyPanel = document.getElementById("raids-history-panel");
        if (historyPanel) historyPanel.hidden = false; // so the undo option is actually visible
        render();
      });
    });

    container.querySelectorAll(".raids-delete-btn").forEach((btn) => {
      wireConfirmButton(btn, "Delete", "Confirm delete?", () => {
        const entries = loadEntries();
        delete entries[btn.dataset.raidId];
        saveEntries(entries);
        render();
      });
    });

    container.querySelectorAll(".raids-entry-edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        entryEditingIds.add(btn.dataset.raidId);
        render();
      });
    });

    container.querySelectorAll(".raids-entry-cancel-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const div = btn.closest(".raids-entry-editing");
        entryEditingIds.delete(div.dataset.origRaidId);
        render();
      });
    });

    container.querySelectorAll(".raids-entry-save-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const div = btn.closest(".raids-entry-editing");
        const origRaidId = div.dataset.origRaidId;
        const entries = loadEntries();
        const entry = entries[origRaidId];
        if (!entry) return;

        const newRaidId = div.querySelector(".raids-entry-edit-raidid").value.trim() || origRaidId;
        entry.raidId = newRaidId;
        entry.title = div.querySelector(".raids-entry-edit-title").value.trim();
        entry.difficulty = div.querySelector(".raids-entry-edit-difficulty").value.trim();
        entry.rl = div.querySelector(".raids-entry-edit-rl").value.trim();
        const newNote = div.querySelector(".raids-entry-edit-note").value.trim();
        entry.note = newNote || null;

        const dateVal = div.querySelector(".raids-entry-edit-date").value;
        if (dateVal) Object.assign(entry, datetimeLocalToFields(dateVal));

        const newCharacters = [];
        div.querySelectorAll(".raids-entry-edit-char-row").forEach((row) => {
          const charRealm = row.querySelector(".raids-entry-edit-char-realm").value.trim();
          const role = row.querySelector(".raids-entry-edit-char-role").value.trim();
          const saved = row.querySelector(".raids-entry-edit-char-saved").checked;
          if (charRealm) newCharacters.push({ charRealm, role, saved });
        });
        // If every character row got cleared, keep the original list
        // rather than leaving the entry with no candidates at all --
        // clearing all of them was very likely accidental.
        entry.characters = newCharacters.length > 0 ? newCharacters : entry.characters;
        // A rostered pick that no longer matches any candidate (edited
        // away, or that row removed) doesn't make sense to keep.
        if (entry.rosteredCharRealm && !entry.characters.some((c) => c.charRealm === entry.rosteredCharRealm)) {
          entry.rosteredCharRealm = null;
        }

        if (newRaidId !== origRaidId) {
          delete entries[origRaidId];
          entries[newRaidId] = entry;
        }

        entryEditingIds.delete(origRaidId);
        saveEntries(entries);
        render();
      });
    });
  }

  // Which history records currently have their edit form open, keyed by
  // the record's raid id at the time editing started. Module-level (not
  // reset by re-renders) so an in-progress edit survives renderHistory()
  // being called again for unrelated reasons (e.g. adding a new signup).
  const historyEditingIds = new Set();

  // Which individual N/A fields (payment id / cut) currently show an
  // inline input, keyed as "raidId:field". Separate from
  // historyEditingIds since this is a much narrower, single-field edit
  // that only ever applies to a field that's still empty.
  const historyInlineEditingKeys = new Set();

  function renderHistory() {
    const list = document.getElementById("raids-history-list");
    if (!list) return;
    const history = loadHistory();
    if (history.length === 0) {
      list.innerHTML = `<li class="empty-msg">No completed sales recorded yet.</li>`;
      return;
    }
    // Most recent first -- the natural order for a sales log.
    const sorted = history.slice().sort((a, b) => (b.sortKey || "").localeCompare(a.sortKey || ""));
    list.innerHTML = sorted.map((h) => {
      // sortKey is "YYYY-MM-DD-HH-MM". Reformatted for display as
      // MM/DD/YY HH:MM; reformatted for the edit form's datetime-local
      // input (which needs "YYYY-MM-DDTHH:MM") separately below.
      let dateText = "";
      let datetimeLocalValue = "";
      if (h.sortKey) {
        const [year, month, day, hour, minute] = h.sortKey.split("-");
        dateText = `${month}/${day}/${year.slice(2)} ${hour}:${minute}`;
        datetimeLocalValue = `${year}-${month}-${day}T${hour}:${minute}`;
      }

      if (historyEditingIds.has(h.raidId)) {
        return `
          <li class="raids-history-item raids-history-item-editing" data-orig-raid-id="${escapeHtml(h.raidId)}">
            <input type="text" class="raids-hist-edit-raidid" value="${escapeHtml(h.raidId)}" placeholder="raid id" />
            <input type="text" class="raids-hist-edit-rl" value="${escapeHtml(h.rl || "")}" placeholder="RL" />
            <input type="text" class="raids-hist-edit-char" value="${escapeHtml(h.charRealm || "")}" placeholder="char-realm" />
            <input type="datetime-local" class="raids-hist-edit-date" value="${datetimeLocalValue}" />
            <input type="text" class="raids-hist-edit-payment" value="${escapeHtml(h.paymentId || "")}" placeholder="payment id" />
            <input type="text" class="raids-hist-edit-cut" value="${h.cut ? fmtNumber(h.cut) : ""}" placeholder="cut" />
            <input type="text" class="raids-hist-edit-note" value="${escapeHtml(h.note || "")}" placeholder="note" />
            <button class="page-btn raids-hist-save-btn" type="button">Save</button>
          </li>`;
      }

      const isPaymentInline = historyInlineEditingKeys.has(`${h.raidId}:paymentId`);
      const isCutInline = historyInlineEditingKeys.has(`${h.raidId}:cut`);

      const paymentDisplay = h.paymentId
        ? escapeHtml(h.paymentId)
        : isPaymentInline
          ? `<input type="text" class="raids-hist-inline-input" data-raid-id="${escapeHtml(h.raidId)}" data-field="paymentId" placeholder="payment id" />`
          : `<span class="raids-hist-inline-na" data-raid-id="${escapeHtml(h.raidId)}" data-field="paymentId">N/A</span>`;
      const cutDisplay = h.cut
        ? escapeHtml(fmtNumber(h.cut))
        : isCutInline
          ? `<input type="text" class="raids-hist-inline-input" data-raid-id="${escapeHtml(h.raidId)}" data-field="cut" placeholder="cut" />`
          : `<span class="raids-hist-inline-na" data-raid-id="${escapeHtml(h.raidId)}" data-field="cut">N/A</span>`;
      const noteDisplay = h.note ? escapeHtml(h.note) : "";
      return `
        <li class="raids-history-item" data-orig-raid-id="${escapeHtml(h.raidId)}">
          <span class="raids-hist-col raids-hist-col-raidid">#${escapeHtml(h.raidId)}</span>
          <span class="raids-hist-col raids-hist-col-rl">${escapeHtml(h.rl)}</span>
          <span class="raids-hist-col raids-hist-col-char">${characterDisplay(h.charRealm)}</span>
          <span class="raids-hist-col raids-hist-col-date">${escapeHtml(dateText)}</span>
          <span class="raids-hist-col raids-hist-col-payment">${paymentDisplay}</span>
          <span class="raids-hist-col raids-hist-col-cut">${cutDisplay}</span>
          <span class="raids-hist-col raids-hist-col-note">${noteDisplay}</span>
          <button class="page-btn raids-hist-edit-btn" type="button">Edit</button>
          <button class="raids-delete-btn raids-hist-delete-btn" type="button">Delete</button>
        </li>`;
    }).join("");

    // Click an "N/A" (only ever shown when the field is genuinely empty)
    // to turn just that one field into an inline input -- for the common
    // case of filling in payment info once it's posted, without a detour
    // through full Edit mode and its four other, usually-unrelated
    // fields. Once a field actually has a value, it's no longer
    // clickable this way; changing an existing value goes through Edit
    // instead, so a stray click can't accidentally alter something
    // already correct.
    list.querySelectorAll(".raids-hist-inline-na").forEach((span) => {
      span.addEventListener("click", () => {
        historyInlineEditingKeys.add(`${span.dataset.raidId}:${span.dataset.field}`);
        renderHistory();
        const input = list.querySelector(
          `.raids-hist-inline-input[data-raid-id="${CSS.escape(span.dataset.raidId)}"][data-field="${CSS.escape(span.dataset.field)}"]`
        );
        if (input) input.focus();
      });
    });

    list.querySelectorAll(".raids-hist-inline-input").forEach((input) => {
      const commit = () => {
        const raidId = input.dataset.raidId;
        const field = input.dataset.field;
        historyInlineEditingKeys.delete(`${raidId}:${field}`);
        const history = loadHistory();
        const record = history.find((h) => h.raidId === raidId);
        if (record) {
          if (field === "paymentId") {
            record.paymentId = input.value.trim() || null;
          } else if (field === "cut") {
            const digitsOnly = input.value.replace(/[^\d]/g, "");
            record.cut = digitsOnly ? parseInt(digitsOnly, 10) : null;
          }
          saveHistoryLocal(history);
          saveEntries(loadEntries());
        }
        renderHistory();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur(); // triggers commit via the blur handler above
      });
    });

    list.querySelectorAll(".raids-hist-edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const li = btn.closest(".raids-history-item");
        historyEditingIds.add(li.dataset.origRaidId);
        renderHistory();
      });
    });

    list.querySelectorAll(".raids-hist-delete-btn").forEach((btn) => {
      wireConfirmButton(btn, "Delete", "Confirm?", () => {
        const li = btn.closest(".raids-history-item");
        const raidId = li.dataset.origRaidId;
        const history = loadHistory();
        const idx = history.findIndex((h) => h.raidId === raidId);
        if (idx === -1) return;
        lastUndoableAction = { type: "delete", record: history[idx] };
        history.splice(idx, 1);
        saveHistoryLocal(history);
        saveEntries(loadEntries());
        showHistoryUndoRow();
        renderHistory();
      });
    });

    list.querySelectorAll(".raids-hist-save-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const li = btn.closest(".raids-history-item");
        const origRaidId = li.dataset.origRaidId;
        const history = loadHistory();
        const record = history.find((h) => h.raidId === origRaidId);
        if (!record) return;

        const newRaidId = li.querySelector(".raids-hist-edit-raidid").value.trim() || origRaidId;
        record.raidId = newRaidId;
        record.rl = li.querySelector(".raids-hist-edit-rl").value.trim();
        record.charRealm = li.querySelector(".raids-hist-edit-char").value.trim();

        const newDateVal = li.querySelector(".raids-hist-edit-date").value; // "YYYY-MM-DDTHH:MM"
        if (newDateVal) {
          const [datePart, timePart] = newDateVal.split("T");
          const [year, month, day] = datePart.split("-");
          const [hour, minute] = timePart.split(":");
          record.sortKey = `${year}-${month}-${day}-${hour}-${minute}`;
        }

        const newPaymentId = li.querySelector(".raids-hist-edit-payment").value.trim();
        record.paymentId = newPaymentId || null;
        const newCutDigits = li.querySelector(".raids-hist-edit-cut").value.replace(/[^\d]/g, "");
        record.cut = newCutDigits ? parseInt(newCutDigits, 10) : null;
        const newNote = li.querySelector(".raids-hist-edit-note").value.trim();
        record.note = newNote || null;

        historyEditingIds.delete(origRaidId);
        saveHistoryLocal(history);
        // History-only change -- entries themselves are unchanged, but
        // saveEntries() is still the correct way to sync it: it bundles
        // in whatever loadHistory() currently returns (see
        // pushRemoteEntries), so this pushes the whole edit too.
        saveEntries(loadEntries());
        renderHistory();
      });
    });
  }

  function renderUnsavedNeeded(entries) {
    const section = document.getElementById("raids-unsaved-dashboard");
    const list = document.getElementById("raids-unsaved-list");
    if (!section || !list) return;
    const needed = computeUnsavedNeeded(entries);
    if (needed.length === 0) {
      section.hidden = true;
      list.innerHTML = "";
      return;
    }
    section.hidden = false;
    list.innerHTML = needed.map((n) => `
      <li class="raids-unsaved-item">${characterDisplay(n.charRealm)} \u2014 ${escapeHtml(n.difficulty)}</li>`).join("");
  }

  function render() {
    const entries = loadEntries();
    const conflicts = detectConflicts(entries);
    renderHistory();
    renderUnsavedNeeded(entries);
    renderCalendar(entries, conflicts);
    renderSummary(entries, conflicts);
  }

  // ---------------- Wiring ----------------
  // The most recently undoable action -- either deleting a history entry
  // ({ type: "delete", record }) or marking a signup complete
  // ({ type: "markComplete", entryId, entry, raidId }). A single slot,
  // not a stack, so only the very last action can be undone; taking
  // another undoable action overwrites this. Kept in memory only, not
  // persisted -- a page reload loses the ability to undo.
  let lastUndoableAction = null;

  function showHistoryUndoRow() {
    const row = document.getElementById("raids-history-undo-row");
    if (row) row.hidden = false;
  }

  function hideHistoryUndoRow() {
    const row = document.getElementById("raids-history-undo-row");
    if (row) row.hidden = true;
  }

  function addEmptyHistoryEntry() {
    const history = loadHistory();
    const newId = `manual-${Date.now()}`;
    const nowSortKey = nowAsSortKey();
    history.push({
      raidId: newId,
      title: "",
      difficulty: "",
      rl: "",
      charRealm: "",
      role: null,
      saved: null,
      weekday: "",
      monthName: "",
      day: "",
      year: "",
      timeStr: "",
      sortKey: nowSortKey,
      paymentId: null,
      cut: null,
      note: null,
    });
    historyEditingIds.add(newId);
    saveHistoryLocal(history);
    saveEntries(loadEntries());
    renderHistory();
  }

  function wireHistoryToggle() {
    const toggleBtn = document.getElementById("raids-history-toggle");
    const panel = document.getElementById("raids-history-panel");
    if (!toggleBtn || !panel) return;
    toggleBtn.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
    });

    const addBtn = document.getElementById("raids-history-add-btn");
    if (addBtn) addBtn.addEventListener("click", () => { addEmptyHistoryEntry(); });

    const undoBtn = document.getElementById("raids-history-undo-btn");
    if (undoBtn) {
      undoBtn.addEventListener("click", () => {
        if (!lastUndoableAction) return;
        if (lastUndoableAction.type === "delete") {
          const history = loadHistory();
          history.push(lastUndoableAction.record);
          saveHistoryLocal(history);
          saveEntries(loadEntries());
        } else if (lastUndoableAction.type === "markComplete") {
          // Remove the history record that mark-complete just created,
          // and restore the original full entry (characters, note,
          // everything) back into active entries under its original id.
          const history = loadHistory().filter((h) => h.raidId !== lastUndoableAction.raidId);
          saveHistoryLocal(history);
          const entries = loadEntries();
          entries[lastUndoableAction.entryId] = lastUndoableAction.entry;
          saveEntries(entries);
        }
        lastUndoableAction = null;
        hideHistoryUndoRow();
        render(); // full re-render -- markComplete's undo affects the calendar, not just history
      });
    }
  }

  function wireAddForm() {
    const toggleBtn = document.getElementById("raids-add-toggle");
    const formEl = document.getElementById("raids-add-form");
    const parseBtn = document.getElementById("raids-parse-btn");
    const textarea = document.getElementById("raids-input");
    const resultEl = document.getElementById("raids-parse-result");

    toggleBtn.addEventListener("click", () => {
      formEl.hidden = !formEl.hidden;
      if (!formEl.hidden) textarea.focus();
    });

    parseBtn.addEventListener("click", () => {
      const { entries: parsed, errors } = parseSignupText(textarea.value);
      const existing = loadEntries();
      mergeParsedEntries(existing, parsed);
      saveEntries(existing);
      render();
      textarea.value = "";
      if (errors.length > 0) {
        resultEl.textContent = `Added ${parsed.length}, but ${errors.length} line(s) couldn't be parsed -- see console for details.`;
        resultEl.classList.add("raids-parse-error");
        console.warn("Raid signup parse errors:", errors);
      } else {
        resultEl.textContent = `Added/updated ${parsed.length} signup${parsed.length === 1 ? "" : "s"}.`;
        resultEl.classList.remove("raids-parse-error");
      }
    });
  }

  async function init() {
    // If a passphrase is already cached (the common case on a repeat
    // visit), start the JSONBin sync immediately in the background --
    // it only needs the cached passphrase value, not anything
    // ensureUnlocked() produces, so there's no reason to wait for that
    // to finish first. On a genuinely first visit (no cached
    // passphrase), there's nothing to start early with; syncPromise
    // stays null and gets created after unlocking instead.
    let syncPromise = getSavedPassphrase() ? syncFromRemote() : null;

    const rosterData = await ensureUnlocked();
    CHARACTER_LOOKUP = buildCharacterLookup(rosterData);

    wireAddForm();
    wireHistoryToggle();

    // Render immediately with whatever's already cached in local storage
    // from a previous visit, rather than waiting for the sync (in flight
    // above, or about to start) to finish first. Local storage isn't
    // encrypted the way the JSONBin copy is, so this only happens after
    // ensureUnlocked() has actually validated the passphrase -- but once
    // that's done, there's no reason to also make the person wait on a
    // second network round-trip just to see their own last-known data
    // again. If nothing changed on another device since last time (the
    // common case), this is the only render that happens.
    render();

    if (!syncPromise) syncPromise = syncFromRemote();
    await syncPromise;
    initialSyncDone = true;
    render(); // picks up anything that changed remotely since the first render

    // The "Keep Unsaved" dashboard depends on the current time (it drops
    // an entry once its scheduled time passes -- see computeUnsavedNeeded),
    // but render() otherwise only runs in response to an action. Without
    // this, a run's time could pass while the page just sits open, and
    // the dashboard would keep showing its now-stale state (including
    // staying visible with nothing actually left to list) until
    // something else happened to trigger a re-render.
    setInterval(() => { renderUnsavedNeeded(loadEntries()); }, 60000);
  }

  init();
})();
