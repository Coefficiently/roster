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

      const dateMatch = rest.match(/(\w+, \w+ \d{1,2}, \d{4} at \d{1,2}:\d{2}\s*[AP]M)/);
      const diffMatch = rest.match(/\b(Heroic|Mythic|Normal|LFR)\b/);
      const rlMatch = rest.match(/RL:\s*(\S+)/);
      const charMatch = rest.match(/([a-z0-9']+-[a-z0-9']+)\s*[\u2014-]\s*(Tank|Healer|Dps|DPS)/i);
      const savedMatch = rest.match(/\b(Saved|Unsaved)\b/);
      const ilvlMatch = rest.match(/(\d+)\s*ilvl/i);

      if (!dateMatch || !diffMatch || !rlMatch || !charMatch || !savedMatch) {
        errors.push(`Couldn't parse detail fields for raid #${raidId} from: "${rest}"`);
        continue;
      }

      const dateTimeStr = dateMatch[1];
      const dt = new Date(dateTimeStr.replace(" at ", " "));

      entries.push({
        raidId,
        seller: sellerFromTitle,
        title,
        dateTimeStr,
        dateTimeISO: isNaN(dt.getTime()) ? null : dt.toISOString(),
        difficulty: diffMatch[1],
        rl: rlMatch[1],
        charRealm: charMatch[1],
        role: charMatch[2],
        saved: savedMatch[1] === "Saved",
        ilvl: ilvlMatch ? parseInt(ilvlMatch[1], 10) : null,
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

  // ---------------- Rendering ----------------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDayHeader(dateTimeISO, fallback) {
    if (!dateTimeISO) return fallback;
    const d = new Date(dateTimeISO);
    return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }

  function formatTime(dateTimeISO, fallback) {
    if (!dateTimeISO) return fallback;
    const d = new Date(dateTimeISO);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function renderSummary(entries) {
    const list = Object.values(entries);
    const el = document.getElementById("raids-summary-text");
    if (list.length === 0) {
      el.textContent = "No signups added yet.";
      return;
    }
    const rostered = list.filter((e) => e.rostered).length;
    el.textContent = `${list.length} signup${list.length === 1 ? "" : "s"} \u2014 ${rostered} rostered, ${list.length - rostered} not yet`;
  }

  function renderCalendar(entries) {
    const container = document.getElementById("raids-calendar");
    const list = Object.values(entries);
    if (list.length === 0) {
      container.innerHTML = `<p class="empty-msg">No signups yet. Paste some above to get started.</p>`;
      return;
    }

    // Group by day (using the fallback raw date string as the group key
    // when a date failed to parse, so unparseable dates still get their
    // own bucket rather than silently merging).
    const groups = new Map();
    for (const entry of list) {
      const key = entry.dateTimeISO ? entry.dateTimeISO.slice(0, 10) : `unparsed:${entry.dateTimeStr}`;
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
        if (a.dateTimeISO && b.dateTimeISO) return a.dateTimeISO.localeCompare(b.dateTimeISO);
        return 0;
      });
      const headerText = dayEntries[0].dateTimeISO
        ? formatDayHeader(dayEntries[0].dateTimeISO, dayEntries[0].dateTimeStr)
        : dayEntries[0].dateTimeStr + " (date couldn't be parsed)";

      html += `<div class="raids-day-header">${escapeHtml(headerText)}</div>`;
      for (const entry of dayEntries) {
        const timeText = formatTime(entry.dateTimeISO, "");
        const savedBadgeClass = entry.saved ? "raids-badge-saved" : "raids-badge-unsaved";
        const ilvlText = entry.ilvl ? `${entry.ilvl}ilvl` : "";
        html += `
          <div class="raids-entry${entry.rostered ? " raids-entry-rostered" : ""}">
            <div class="raids-entry-time">${escapeHtml(timeText)}</div>
            <div class="raids-entry-main">
              <div class="raids-entry-top">
                <span class="raids-entry-title">${escapeHtml(entry.title)}</span>
                <span class="raids-badge">${escapeHtml(entry.difficulty)}</span>
                <span class="raids-badge ${savedBadgeClass}">${entry.saved ? "Saved" : "Unsaved"}</span>
                ${ilvlText ? `<span class="raids-badge">${escapeHtml(ilvlText)}</span>` : ""}
              </div>
              <div class="raids-entry-meta">
                Raid #${escapeHtml(entry.raidId)} \u00b7 RL: ${escapeHtml(entry.rl)} \u00b7 ${escapeHtml(entry.charRealm)} \u2014 ${escapeHtml(entry.role)}
              </div>
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
          renderSummary(entries);
          cb.closest(".raids-entry").classList.toggle("raids-entry-rostered", cb.checked);
        }
      });
    });
  }

  function render() {
    const entries = loadEntries();
    renderSummary(entries);
    renderCalendar(entries);
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
