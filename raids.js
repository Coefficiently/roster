(function () {
  "use strict";

  // ---------------- Encrypted-site lock screen ----------------
  // Reused from app.js so this page shares the same passphrase/session as
  // the roster page -- if you're already unlocked there (in this browser),
  // this page won't re-prompt. See app.js for the fuller explanation of
  // the crypto approach; this only needs it to VALIDATE the passphrase
  // (by test-decrypting data.json), not to actually use the roster data.
  const PASSPHRASE_STORAGE_KEY = "roster_passphrase";

  function base64ToBuffer(b64) {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
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
      return; // can't reach data.json -- proceed unlocked rather than block the page entirely
    }
    if (!rawData || !rawData.encrypted) return; // site isn't encrypted, nothing to gate

    let saved = null;
    try { saved = localStorage.getItem(PASSPHRASE_STORAGE_KEY); } catch (err) { /* fine */ }
    if (saved) {
      try {
        await decryptEnvelope(rawData, saved);
        return; // cached passphrase is valid, proceed unlocked
      } catch (err) {
        try { localStorage.removeItem(PASSPHRASE_STORAGE_KEY); } catch (e2) { /* fine */ }
      }
    }
    await promptForPassphrase(rawData);
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
      const dateMatch = rest.match(/(\w+), (\w+) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2})\s*([AP]M)/);
      const diffMatch = rest.match(/\b(Heroic|Mythic|Normal|LFR)\b/);
      const rlMatch = rest.match(/RL:\s*(\S+)/);
      const charMatch = rest.match(/([a-z0-9']+-[a-z0-9']+)\s*[\u2014-]\s*(Tank|Healer|Dps|DPS)/i);
      const savedMatch = rest.match(/\b(Saved|Unsaved)\b/);

      if (!dateMatch || !diffMatch || !rlMatch || !charMatch || !savedMatch) {
        errors.push(`Couldn't parse detail fields for raid #${raidId} from: "${rest}"`);
        continue;
      }

      // Whatever free-text the seller put in the signup's Notes field
      // trails after the Saved/Unsaved status -- not always "###ilvl",
      // could be anything, so this is captured as-is rather than matched
      // against a specific pattern.
      const afterSaved = rest.slice(savedMatch.index + savedMatch[0].length).trim();
      const note = afterSaved.length > 0 ? afterSaved : null;

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
        charRealm: charMatch[1],
        role: charMatch[2],
        saved: savedMatch[1] === "Saved",
        note,
      });
    }
    return { entries, errors };
  }

  // ---------------- Storage ----------------
  const STORAGE_KEY = "raid_sales_entries";

  function loadEntries() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      return {};
    }
  }

  function saveEntries(entries) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (err) {
      // storage unavailable/full -- nothing we can do client-side about this
    }
  }

  function mergeParsedEntries(existing, parsed) {
    for (const entry of parsed) {
      const prior = existing[entry.raidId];
      existing[entry.raidId] = {
        ...entry,
        rostered: prior ? prior.rostered : false,
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

  // Returns a Map<raidId, string[]> of conflict messages (entries with no
  // conflicts simply aren't in the map).
  function detectConflicts(entries) {
    const list = Object.values(entries).filter((e) => e.sortKey);
    const groups = new Map();
    for (const entry of list) {
      const weekIndex = computeWeekIndex(entry);
      if (weekIndex === null) continue;
      const key = `${entry.charRealm}|${normalizeRaidName(entry.title)}|${entry.difficulty}|${weekIndex}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }

    const conflicts = new Map();
    const addConflict = (entry, message) => {
      if (!conflicts.has(entry.raidId)) conflicts.set(entry.raidId, []);
      conflicts.get(entry.raidId).push(message);
    };

    for (const groupEntries of groups.values()) {
      const unsaved = groupEntries.filter((e) => !e.saved);
      const saved = groupEntries.filter((e) => e.saved);

      if (unsaved.length > 1) {
        for (const e of unsaved) {
          addConflict(e, `${unsaved.length} Unsaved runs this week for this character/raid/difficulty (only 1 is possible)`);
        }
      }

      if (unsaved.length === 1) {
        const unsavedEntry = unsaved[0];
        const earlierOrSameSaved = saved.filter((e) => e.sortKey <= unsavedEntry.sortKey);
        for (const e of earlierOrSameSaved) {
          addConflict(e, `Scheduled as Saved before the Unsaved run (Raid #${unsavedEntry.raidId}) for this character/raid/difficulty this week`);
        }
        if (earlierOrSameSaved.length > 0) {
          addConflict(unsavedEntry, `This Unsaved run is scheduled after ${earlierOrSameSaved.length} Saved run(s) for this character/raid/difficulty this week`);
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

  function renderSummary(entries, conflicts) {
    const list = Object.values(entries);
    const el = document.getElementById("raids-summary-text");
    if (list.length === 0) {
      el.textContent = "No signups added yet.";
      return;
    }
    const rostered = list.filter((e) => e.rostered).length;
    const conflictCount = conflicts ? conflicts.size : 0;
    let text = `${list.length} signup${list.length === 1 ? "" : "s"} \u2014 ${rostered} rostered, ${list.length - rostered} not yet`;
    if (conflictCount > 0) {
      text += ` \u2014 \u26a0 ${conflictCount} with conflicts`;
    }
    el.textContent = text;
    el.classList.toggle("raids-summary-has-conflicts", conflictCount > 0);
  }

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
        const timeText = entry.timeStr ? `${entry.timeStr} CT` : "";
        const savedBadgeClass = entry.saved ? "raids-badge-saved" : "raids-badge-unsaved";
        const noteText = entry.note ? ` \u2014 ${escapeHtml(entry.note)}` : "";
        const entryConflicts = conflicts.get(entry.raidId);
        const conflictClass = entryConflicts ? " raids-entry-conflict" : "";
        const conflictBlock = entryConflicts
          ? `<div class="raids-entry-conflict-msg">\u26a0 ${entryConflicts.map(escapeHtml).join("; ")}</div>`
          : "";
        html += `
          <div class="raids-entry${entry.rostered ? " raids-entry-rostered" : ""}${conflictClass}">
            <div class="raids-entry-time">${escapeHtml(timeText)}</div>
            <div class="raids-entry-main">
              <div class="raids-entry-top">
                <span class="raids-entry-title">${escapeHtml(entry.title)}</span>
                <span class="raids-badge">${escapeHtml(entry.difficulty)}</span>
                <span class="raids-badge ${savedBadgeClass}">${entry.saved ? "Saved" : "Unsaved"}</span>
              </div>
              <div class="raids-entry-meta">
                Raid #${escapeHtml(entry.raidId)} \u00b7 RL: ${escapeHtml(entry.rl)} \u00b7 ${escapeHtml(entry.charRealm)} \u2014 ${escapeHtml(entry.role)}${noteText}
              </div>
              ${conflictBlock}
            </div>
            <label class="raids-rostered-toggle">
              <input type="checkbox" data-raid-id="${escapeHtml(entry.raidId)}" ${entry.rostered ? "checked" : ""} />
              Rostered
            </label>
          </div>`;
      }
    }
    container.innerHTML = html;

    container.querySelectorAll('input[type="checkbox"][data-raid-id]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const entries = loadEntries();
        const id = cb.dataset.raidId;
        if (entries[id]) {
          entries[id].rostered = cb.checked;
          saveEntries(entries);
          renderSummary(entries, detectConflicts(entries));
          cb.closest(".raids-entry").classList.toggle("raids-entry-rostered", cb.checked);
        }
      });
    });
  }

  function render() {
    const entries = loadEntries();
    const conflicts = detectConflicts(entries);
    renderCalendar(entries, conflicts);
    renderSummary(entries, conflicts);
  }

  // ---------------- Wiring ----------------
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
    await ensureUnlocked();
    wireAddForm();
    render();
  }

  init();
})();
