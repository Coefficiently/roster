(function () {
  "use strict";

  let DATA = null;
  let currentPage = 0;
  let charsPerPage = 4; // always recomputed at the top of render(), this is just the pre-first-render placeholder

  const theadEl = document.getElementById("roster-thead");
  const tbodyEl = document.getElementById("roster-tbody");
  const detailPanel = document.getElementById("detail-panel");

  const CLASS_COLORS = {
    warrior: "#C79C6E", paladin: "#F58CBA", hunter: "#ABD473", rogue: "#FFF569",
    priest: "#FFFFFF", "death-knight": "#C41F3B", shaman: "#0070DE", mage: "#69CCF0",
    warlock: "#9482C9", monk: "#00FF96", druid: "#FF7D0A", "demon-hunter": "#A330C9",
    evoker: "#33937F",
  };

  function fmtNumber(n) {
    return (n || 0).toLocaleString("en-US");
  }

  function classInfo(char) {
    return DATA.classes[char.classId] || { name: "Unknown", slug: "" };
  }

  function classColor(char) {
    return CLASS_COLORS[classInfo(char).slug] || "#c99a44";
  }

  function realmName(char) {
    const realm = DATA.realms[char.realmId];
    return realm ? realm.name : "\u2014";
  }

  function raceName(char) {
    const race = DATA.races[char.raceId];
    return race ? race.name : "\u2014";
  }

  const FACTION_NAMES = { 0: "Alliance", 1: "Horde" };
  function factionName(char) {
    return FACTION_NAMES[char.faction] || "\u2014";
  }

  function qualityColor(quality) {
    return (DATA.qualityColors && DATA.qualityColors[quality]) || "#3a3427";
  }

  // ---------------- Grid header ----------------

  function renderHeader(chars) {
    theadEl.innerHTML = `
      <tr class="row-character">
        <th class="row-label"></th>
        ${chars.map((c) => `
          <th class="char-col" data-char-id="${c.id}" tabindex="0" role="button">
            <span class="char-col-name" style="color:${classColor(c)}">${c.name}</span>
          </th>`).join("")}
      </tr>
    `;
  }

  // ---------------- Grid body rows ----------------

  function rowRealm(chars) {
    return `<tr>
      <td class="row-label">Realm</td>
      ${chars.map((c) => `<td class="cell-dim">${realmName(c)}</td>`).join("")}
    </tr>`;
  }

  function rowFaction(chars) {
    return `<tr>
      <td class="row-label">Faction</td>
      ${chars.map((c) => `<td class="cell-dim">${factionName(c)}</td>`).join("")}
    </tr>`;
  }

  function rowRace(chars) {
    return `<tr>
      <td class="row-label">Race</td>
      ${chars.map((c) => `<td class="cell-dim">${raceName(c)}</td>`).join("")}
    </tr>`;
  }

  // Interpolates red -> yellow -> green (or reverse) across t in [0, 1].
  function gradientColor(t, lowColor, highColor) {
    const YELLOW = [255, 205, 30];
    t = Math.max(0, Math.min(1, t));
    const [c1, c2, localT] = t < 0.5
      ? [lowColor, YELLOW, t / 0.5]
      : [YELLOW, highColor, (t - 0.5) / 0.5];
    const mix = (i) => Math.round(c1[i] + (c2[i] - c1[i]) * localT);
    return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
  }

  const RED = [255, 60, 50];
  const GREEN = [70, 240, 70];

  // Red (291) -> Yellow (mid) -> bright green (331), clamped at the ends.
  function itemLevelColor(ilvl) {
    const min = 291, max = 331;
    return gradientColor((ilvl - min) / (max - min), RED, GREEN);
  }

  // Inverted: green when nothing earned yet this season (plenty of
  // headroom), red when the season-earn cap is fully hit (crests about to
  // go to waste until next week's cap increase).
  function crestFillColor(totalQuantity, max) {
    if (!max) return null;
    return gradientColor(totalQuantity / max, GREEN, RED);
  }

  function rowItemLevel(chars) {
    return `<tr>
      <td class="row-label">Item Level</td>
      ${chars.map((c) => `<td class="cell-strong" style="color:${itemLevelColor(c.itemLevel)}">${c.itemLevel}</td>`).join("")}
    </tr>`;
  }

  function rowProfession(index, chars) {
    return `<tr>
      <td class="row-label">Profession ${index + 1}</td>
      ${chars.map((c) => {
        const p = c.professions[index];
        if (!p) return `<td class="cell-dim">\u2014</td>`;
        return `<td class="cell-profession">${p.name} <span class="profession-skill">${p.currentSkill}/${p.maxSkill}</span></td>`;
      }).join("")}
    </tr>`;
  }

  function rowCurrencySectionHeader(chars) {
    return `<tr class="section-row">
      <td class="row-label section-label">Currencies</td>
      <td class="section-fill" colspan="${chars.length}"></td>
    </tr>`;
  }

  // Full-red flag (not a gradient) for currencies where the interesting
  // signal is simply "did this cap out and start going to waste" --
  // Venomblight Manaflux (catalyst) and Tidal Spark Dust.
  const RED_AT_MAX_IDS = new Set([3465, 3509]);
  const FULL_RED = "rgb(255, 60, 50)";

  function rowCurrency(label, items, chars, colorize) {
    return `<tr>
      <td class="row-label row-label-sub">${label}</td>
      ${chars.map((c) => {
        const cur = items(c);
        if (!cur) return `<td class="cell-dim">\u2014</td>`;
        const qty = cur.max > 0 ? `${fmtNumber(cur.quantity)}/${fmtNumber(cur.max)}` : fmtNumber(cur.quantity);
        const empty = cur.quantity === 0 && cur.max === 0;
        const showsTotal = cur.isMovingMax && cur.totalQuantity > 0;
        const tooltipAttr = showsTotal
          ? ` data-tooltip="Earned this season: ${fmtNumber(cur.totalQuantity)}/${fmtNumber(cur.max)}" aria-label="Earned this season: ${fmtNumber(cur.totalQuantity)} of ${fmtNumber(cur.max)}"`
          : "";
        const cellClass = `${empty ? "cell-dim" : "cell-currency"}${showsTotal ? " cell-currency-tooltip" : ""}`;
        // Color by how much of the season-earn cap has been used up --
        // green (nothing earned yet, plenty of headroom) to red (fully
        // capped, earning nothing more until next week's cap increase).
        // Restricted to crests specifically (colorize=true), even though
        // isMovingMax also appears on some other currencies (e.g. Tidal
        // Spark Dust) that shouldn't get this treatment.
        let fillColor = colorize && cur.isMovingMax ? crestFillColor(cur.totalQuantity, cur.max) : null;
        if (!fillColor && RED_AT_MAX_IDS.has(cur.id) && cur.max > 0 && cur.quantity >= cur.max) {
          fillColor = FULL_RED;
        }
        const linkStyle = fillColor ? `color:${fillColor}` : null;
        return `<td class="${cellClass}"${tooltipAttr}>${wowheadLink({ wowheadUrl: cur.wowheadUrl, name: qty }, "currency-cell-link", linkStyle)}</td>`;
      }).join("")}
    </tr>`;
  }

  function rowRating(chars) {
    return `<tr>
      <td class="row-label">Rating</td>
      ${chars.map((c) => `<td class="cell-rating">${fmtNumber(c.mythicPlus.rating)}</td>`).join("")}
    </tr>`;
  }

  function rowKeystone(chars) {
    return `<tr>
      <td class="row-label">Current Keystone</td>
      ${chars.map((c) => {
        const k = c.mythicPlus.currentKeystone;
        if (!k) return `<td class="cell-dim">\u2014</td>`;
        return `<td class="cell-keystone"><span class="keystone-level">+${k.level}</span> ${k.dungeonName}</td>`;
      }).join("")}
    </tr>`;
  }

  function vaultTotalMet(char) {
    const rows = [char.vault.raid, char.vault.dungeon, char.vault.world];
    return rows.reduce((sum, slots) => sum + (slots || []).filter((s) => s.met).length, 0);
  }

  function vaultCellHtml(slots, status) {
    if (!slots || slots.length === 0) return `<div class="vault-row"><span class="vault-slot vault-empty">\u2014</span></div>`;
    const metClass = status === "full" ? "vault-met-full" : "vault-met";
    const spans = slots
      .map((s) => `<span class="vault-slot ${s.met ? metClass : "vault-empty"}">${s.met ? s.label : "\u2014"}</span>`)
      .join("");
    return `<div class="vault-row">${spans}</div>`;
  }

  function rowVault(chars) {
    // Aggregate vault health across all 3 categories (9 slots total) per
    // character: fully capped (9/9) highlights met slots light blue instead
    // of green; below one full category's worth (<3) flags the whole 3x3
    // grid red as a "not vault-ready" warning, regardless of which
    // individual slots are met.
    const statusFor = (char) => {
      const total = vaultTotalMet(char);
      if (total >= 9) return "full";
      if (total < 3) return "low";
      return "normal";
    };

    const rowHtml = (label, getSlots) => `
      <tr>
        <td class="row-label">${label}</td>
        ${chars.map((c) => {
          const status = statusFor(c);
          const cellClass = status === "low" ? "vault-cell-low" : "";
          return `<td class="${cellClass}">${vaultCellHtml(getSlots(c), status)}</td>`;
        }).join("")}
      </tr>`;

    return (
      rowHtml("Vault: Raid", (c) => c.vault.raid) +
      rowHtml("Vault: Dungeons", (c) => c.vault.dungeon) +
      rowHtml("Vault: World", (c) => c.vault.world)
    );
  }

  function rowMythicPlusSectionHeader(chars) {
    return `<tr class="section-row">
      <td class="row-label section-label">Mythic+</td>
      <td class="section-fill" colspan="${chars.length}"></td>
    </tr>`;
  }

  function rowDungeon(dungeon, chars) {
    return `<tr>
      <td class="row-label row-label-sub">${dungeon.name}</td>
      ${chars.map((c) => {
        const d = c.mythicPlus.dungeonScores.find((x) => x.mapId === dungeon.mapId);
        if (!d || d.level === 0) return `<td class="cell-dim">\u2014</td>`;
        return `<td class="cell-dungeon"><span class="dungeon-level">${d.level}</span><span class="dungeon-score">${fmtNumber(d.score)}</span></td>`;
      }).join("")}
    </tr>`;
  }

  function rowRaidSectionHeader(raidName, chars) {
    return `<tr class="section-row">
      <td class="row-label section-label">${raidName}</td>
      <td class="section-fill" colspan="${chars.length}"></td>
    </tr>`;
  }

  function escapeHtml(str) {
    const div = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(str).replace(/[&<>"']/g, (ch) => div[ch]);
  }

  function rowRaidDifficulty(raidName, difficultyLabel, bosses, chars) {
    return `<tr>
      <td class="row-label row-label-sub">${difficultyLabel}</td>
      ${chars.map((c) => {
        const row = (c.raidGrids[raidName] || {})[difficultyLabel];
        if (!row) return `<td>\u2014</td>`;
        const squares = row
          .map((dead, i) => {
            let cls = "boss-square boss-unknown";
            let status = "Unsaved";
            if (dead === true) { cls = "boss-square boss-dead"; status = "Saved"; }
            else if (dead === false) { cls = "boss-square boss-alive"; }
            const bossName = bosses[i] || `Boss ${i + 1}`;
            const tooltipText = escapeHtml(`${bossName} \u2014 ${status}`);
            return `<span class="${cls}" data-tooltip="${tooltipText}" aria-label="${tooltipText}"></span>`;
          })
          .join("");
        return `<td><div class="boss-row">${squares}</div></td>`;
      }).join("")}
    </tr>`;
  }

  // ---------------- Pagination ----------------
  // These must match the .row-label / .char-col fixed widths in CSS exactly
  // -- with table-layout:fixed, the table no longer auto-sizes, so if these
  // drift out of sync with the CSS the page-size math will be wrong.
  const CHAR_COLUMN_WIDTH = 150;
  const ROW_LABEL_WIDTH = 240;

  function computeCharsPerPage() {
    // Deliberately NOT measuring .table-scroll here: it has width:fit-content
    // so it shrinks to whatever was rendered last render, which would make
    // this circular (each render measures a container sized by the
    // previous render, spiraling toward 1 column). .page doesn't
    // shrink-wrap -- it's max-width:1400px and fills available space up to
    // that cap -- so it's a stable, non-circular measurement.
    const PAGE_HORIZONTAL_PADDING = 48; // matches .page's CSS padding (1.5rem each side)
    const pageEl = document.querySelector(".page");
    const containerWidth = pageEl && pageEl.clientWidth
      ? pageEl.clientWidth - PAGE_HORIZONTAL_PADDING
      : window.innerWidth - PAGE_HORIZONTAL_PADDING;
    const available = containerWidth - ROW_LABEL_WIDTH - 4;
    return Math.max(1, Math.floor(available / CHAR_COLUMN_WIDTH));
  }

  function renderPaginationControls(totalChars, totalPages) {
    const controls = document.getElementById("page-controls");
    if (!controls) return;
    if (totalPages <= 1) {
      controls.hidden = true;
      return;
    }
    controls.hidden = false;
    document.getElementById("page-indicator").textContent =
      `Page ${currentPage + 1} of ${totalPages} (${totalChars} characters)`;
    document.getElementById("page-prev").disabled = currentPage === 0;
    document.getElementById("page-next").disabled = currentPage >= totalPages - 1;
  }

  function wirePaginationControls() {
    const prev = document.getElementById("page-prev");
    const next = document.getElementById("page-next");
    if (prev) prev.addEventListener("click", () => { currentPage -= 1; render(); });
    if (next) next.addEventListener("click", () => { currentPage += 1; render(); });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (computeCharsPerPage() !== charsPerPage) {
          currentPage = 0;
          render();
        }
      }, 150);
    });
  }

  function render() {
    if (!DATA) return;
    charsPerPage = computeCharsPerPage();
    const allChars = DATA.characters;
    const totalPages = Math.max(1, Math.ceil(allChars.length / charsPerPage));
    currentPage = Math.min(Math.max(currentPage, 0), totalPages - 1);
    const start = currentPage * charsPerPage;
    const chars = allChars.slice(start, start + charsPerPage);

    renderHeader(chars);

    let rows = "";
    rows += rowRealm(chars);
    rows += rowFaction(chars);
    rows += rowRace(chars);
    rows += rowItemLevel(chars);
    rows += rowRating(chars);
    rows += rowKeystone(chars);
    rows += rowVault(chars);
    rows += rowProfession(0, chars);
    rows += rowProfession(1, chars);

    rows += rowCurrencySectionHeader(chars);
    const crestCount = Math.max(...chars.map((c) => c.currencies.crests.length), 0);
    for (let i = 0; i < crestCount; i++) {
      const label = chars.find((c) => c.currencies.crests[i])?.currencies.crests[i]?.shortName || "Crest";
      rows += rowCurrency(label, (c) => c.currencies.crests[i], chars, true);
    }
    const catalystCount = Math.max(...chars.map((c) => c.currencies.catalyst.length), 0);
    for (let i = 0; i < catalystCount; i++) {
      const label = chars.find((c) => c.currencies.catalyst[i])?.currencies.catalyst[i]?.shortName || "Catalyst";
      rows += rowCurrency(label, (c) => c.currencies.catalyst[i], chars);
    }
    const bonusRollCount = Math.max(...chars.map((c) => c.currencies.bonusRolls.length), 0);
    for (let i = 0; i < bonusRollCount; i++) {
      const label = chars.find((c) => c.currencies.bonusRolls[i])?.currencies.bonusRolls[i]?.shortName || "Bonus Roll";
      rows += rowCurrency(label, (c) => c.currencies.bonusRolls[i], chars);
    }

    rows += rowMythicPlusSectionHeader(chars);
    for (const dungeon of DATA.mythicPlusDungeons) {
      rows += rowDungeon(dungeon, chars);
    }
    for (const raid of DATA.raids || []) {
      rows += rowRaidSectionHeader(raid.name, chars);
      for (const diff of raid.difficulties) {
        rows += rowRaidDifficulty(raid.name, diff.label, raid.bosses, chars);
      }
    }

    tbodyEl.innerHTML = rows;

    document.querySelectorAll(".char-col").forEach((th) => {
      const charId = Number(th.dataset.charId);
      const open = () => openDetail(charId);
      th.addEventListener("click", open);
      th.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    });

    renderPaginationControls(allChars.length, totalPages);
    refreshWowheadLinks();
  }

  // ---------------- Detail panel (gear / currencies / bags) ----------------

  // Wowhead's tooltip widget (power.js, iconizelinks:true in index.html)
  // auto-injects a small icon directly into any wowhead item link's own
  // text -- confirmed working. A separate attempt at a larger, standalone
  // icon-only link (its own <a><ins class="iconlarge"></ins></a>, with no
  // text) did NOT get picked up by the same auto-injection and rendered as
  // an empty box, so that approach was dropped -- the auto-icon on the
  // text link itself is the one confirmed mechanism. refreshWowheadLinks()
  // re-triggers the widget's scan after every dynamic render, since it
  // only scans automatically once on initial page load.
  function refreshWowheadLinks() {
    if (window.$WowheadPower && typeof window.$WowheadPower.refreshLinks === "function") {
      window.$WowheadPower.refreshLinks();
    }
  }

  function wowheadLink(item, extraCls, extraStyle) {
    const cls = extraCls || "";
    const styleAttr = extraStyle ? ` style="${extraStyle}"` : "";
    return `<a href="${item.wowheadUrl}" class="wh-item-link ${cls}"${styleAttr} target="_blank" rel="noopener">${item.name}</a>`;
  }

  function renderGearRow(item) {
    const border = qualityColor(item.quality);
    const ilvlTxt = item.itemLevel > 0
      ? (item.itemLevelEstimated ? `~${item.itemLevel}` : item.itemLevel)
      : "\u2014";
    const ilvlTooltip = item.itemLevelEstimated
      ? ` data-tooltip="Not reported by the API directly -- inferred from this item's upgrade rank" aria-label="Estimated item level"`
      : "";
    const slotTxt = item.slotName || `Bag ${item.bagId}`;

    const upgradeTxt = item.upgrade
      ? `<span class="item-upgrade">${item.upgrade.track} ${item.upgrade.rank}/${item.upgrade.maxRank}</span>`
      : "";
    const craftedTxt = item.craftedQuality > 0
      ? `<span class="item-crafted">Crafted Q${item.craftedQuality}</span>`
      : "";
    const tierTxt = item.isTierPiece ? `<span class="item-tier-badge" data-tooltip="Tier set piece" aria-label="Tier set piece">T</span>` : "";

    const enchantLine = item.enchant
      ? `<div class="item-subline item-enchant">${item.enchant}</div>`
      : "";
    const gemsLine = (item.gems && item.gems.length > 0)
      ? `<div class="item-subline item-gems">${item.gems.map((g) => `\u25c6 ${wowheadLink({ wowheadUrl: g.wowheadUrl, name: g.name }, "gem-link")}`).join(" &nbsp; ")}</div>`
      : "";

    return `<li class="gear-row" style="border-left-color:${border}">
      <div class="gear-row-main">
        <div class="gear-row-top">
          <span class="slot">${slotTxt}</span>
          <span class="item-name">${wowheadLink({ wowheadUrl: item.wowheadUrl, name: item.itemName }, "item-name-link iconlarge")}${tierTxt}</span>
          <span class="item-ilvl"${ilvlTooltip}>${ilvlTxt}</span>
        </div>
        <div class="gear-row-meta">${upgradeTxt}${craftedTxt}</div>
        ${enchantLine}
        ${gemsLine}
      </div>
    </li>`;
  }

  function renderBagItemRow(item) {
    const border = qualityColor(item.quality);
    const countTxt = item.count > 1 ? ` \u00d7${item.count}` : "";
    const ilvlTxt = item.itemLevel > 0 ? item.itemLevel : "\u2014";
    return `<li class="gear-row" style="border-left-color:${border}">
      <div class="gear-row-main">
        <div class="gear-row-top">
          <span class="slot">${item.location || "Bags"}</span>
          <span class="item-name">${wowheadLink({ wowheadUrl: item.wowheadUrl, name: item.itemName }, "item-name-link iconlarge")}${countTxt}</span>
          <span class="item-ilvl">${ilvlTxt}</span>
        </div>
      </div>
    </li>`;
  }

  function fillList(id, items, renderFn, emptyText) {
    const el = document.getElementById(id);
    if (!items || items.length === 0) {
      el.innerHTML = `<li class="empty-msg">${emptyText}</li>`;
      return;
    }
    el.innerHTML = items.map(renderFn).join("");
  }

  // Only one of these three panels should be open at a time -- opening any
  // one closes the other two.
  const EXCLUSIVE_PANEL_IDS = ["detail-panel", "warband-panel", "allitems-panel"];
  function closeOtherPanels(exceptId) {
    for (const id of EXCLUSIVE_PANEL_IDS) {
      if (id !== exceptId) {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      }
    }
  }

  function openDetail(charId) {
    const char = DATA.characters.find((c) => c.id === charId);
    if (!char) return;

    document.getElementById("detail-name").textContent = char.name;
    document.getElementById("detail-name").style.color = classColor(char);
    document.getElementById("detail-meta").textContent =
      `${classInfo(char).name} \u00b7 ${realmName(char)} \u00b7 level ${char.level} \u00b7 ilvl ${char.itemLevel} \u00b7 tier ${char.tierPieceCount}pc`;

    fillList("detail-equipped", char.equipped, renderGearRow, "No equipped gear data.");
    fillList(
      "detail-bags", char.bagItems, renderBagItemRow,
      DATA.hasPrivateData ? "Bags are empty." : "Not available -- bag/bank contents require an authenticated session (see README)."
    );
    refreshWowheadLinks();

    closeOtherPanels("detail-panel");
    detailPanel.hidden = false;
    if (typeof detailPanel.scrollIntoView === "function") {
      detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  document.getElementById("detail-close").addEventListener("click", () => {
    detailPanel.hidden = true;
  });

  // ---------------- Warband Bank panel ----------------

  // Consolidates the finer-grained item categories from data.json into the
  // 5 buckets requested for the Warband Bank view specifically. Detail
  // panels (equipped gear, per-character bags) aren't affected by this --
  // only where this bucket function is actually used.
  const WARBAND_BUCKET_MAP = {
    "Weapon": "Gear",
    "Armor": "Gear",
    "Gem": "Gear",
    "Combat Consumable": "Combat Consumables",
    "Miscellaneous": "Account Bound Currencies",
    "Quest Item": "Quest Items",
  };
  const WARBAND_BUCKET_ORDER = ["Gear", "Combat Consumables", "Account Bound Currencies", "Quest Items", "Other"];

  function warbandBucket(category) {
    return WARBAND_BUCKET_MAP[category] || "Other";
  }

  function renderWarbandList(items) {
    renderGroupedItemList("warband-list", items, renderBagItemRow, "Warband bank is empty.");
  }

  function wireWarbandPanel() {
    const btn = document.getElementById("warband-btn");
    const panel = document.getElementById("warband-panel");
    const closeBtn = document.getElementById("warband-close");
    if (!btn || !panel) return;

    btn.addEventListener("click", () => {
      renderWarbandList(DATA.warbandItems);
      closeOtherPanels("warband-panel");
      panel.hidden = false;
      if (typeof panel.scrollIntoView === "function") {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    if (closeBtn) closeBtn.addEventListener("click", () => { panel.hidden = true; });
  }

  // ---------------- "All Items" aggregate view (bags + warband) ----------

  function escapeAttr(str) {
    return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  function buildAllItemsAggregate() {
    const byId = new Map();

    const addSource = (item, sourceName) => {
      let entry = byId.get(item.itemId);
      if (!entry) {
        entry = {
          itemId: item.itemId,
          itemName: item.itemName,
          quality: item.quality,
          itemLevel: item.itemLevel,
          category: item.category,
          craftingQuality: item.craftingQuality || 0,
          wowheadUrl: item.wowheadUrl,
          totalCount: 0,
          bySource: new Map(),
        };
        byId.set(item.itemId, entry);
      }
      entry.totalCount += item.count;
      entry.bySource.set(sourceName, (entry.bySource.get(sourceName) || 0) + item.count);
    };

    for (const item of DATA.warbandItems || []) {
      addSource(item, "Warband Bank");
    }
    for (const char of DATA.characters || []) {
      for (const item of char.bagItems || []) {
        addSource(item, char.name);
      }
    }

    return [...byId.values()].map((entry) => {
      const breakdown = [...entry.bySource.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([source, count]) => `${fmtNumber(count)} ${source}`)
        .join(", ");
      return { ...entry, count: entry.totalCount, breakdown };
    });
  }

  function renderAllItemsRow(item) {
    const border = qualityColor(item.quality);
    return `<li class="gear-row" style="border-left-color:${border}">
      <div class="gear-row-main">
        <div class="gear-row-top">
          <span class="item-name">${wowheadLink({ wowheadUrl: item.wowheadUrl, name: item.itemName }, "item-name-link iconlarge")}</span>
          <span class="item-count-breakdown" data-tooltip="${escapeAttr(item.breakdown)}" aria-label="${escapeAttr(item.breakdown)}">\u00d7${fmtNumber(item.count)}</span>
        </div>
      </div>
    </li>`;
  }

  function renderGroupedItemList(listElId, items, rowRenderFn, emptyText) {
    const listEl = document.getElementById(listElId);
    if (!items || items.length === 0) {
      listEl.innerHTML = `<li class="empty-msg">${emptyText}</li>`;
      return;
    }

    const groups = new Map();
    for (const item of items) {
      const bucket = warbandBucket(item.category);
      if (!groups.has(bucket)) groups.set(bucket, []);
      groups.get(bucket).push(item);
    }

    const orderedBuckets = [...groups.keys()].sort((a, b) => {
      const ia = WARBAND_BUCKET_ORDER.indexOf(a);
      const ib = WARBAND_BUCKET_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    let html = "";
    for (const bucket of orderedBuckets) {
      const bucketItems = groups.get(bucket).slice().sort((a, b) => a.itemName.localeCompare(b.itemName));
      html += `<li class="warband-category-header">${bucket} <span class="warband-category-count">(${bucketItems.length})</span></li>`;
      html += bucketItems.map(rowRenderFn).join("");
    }
    listEl.innerHTML = html;
    refreshWowheadLinks();
  }

  function wireAllItemsPanel() {
    const btn = document.getElementById("allitems-btn");
    const panel = document.getElementById("allitems-panel");
    const closeBtn = document.getElementById("allitems-close");
    if (!btn || !panel) return;

    btn.addEventListener("click", () => {
      const items = buildAllItemsAggregate();
      renderGroupedItemList("allitems-list", items, renderAllItemsRow, "No items found.");
      closeOtherPanels("allitems-panel");
      panel.hidden = false;
      if (typeof panel.scrollIntoView === "function") {
        panel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    if (closeBtn) closeBtn.addEventListener("click", () => { panel.hidden = true; });
  }

  // ---------------- Header stats + init ----------------

  // Weekly reset: Tuesday 10:00 AM America/Chicago. Vault progress and raid
  // saved/unsaved status all reset at this moment -- everything shown here
  // is "as of" whatever the most recent one was.
  function getTimeZoneOffsetMinutes(date, timeZone) {
    const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
    const tzStr = date.toLocaleString("en-US", { timeZone });
    return (new Date(tzStr) - new Date(utcStr)) / 60000;
  }

  function nextWeeklyReset(now) {
    now = now || new Date();
    const TARGET_WEEKDAY = 2; // Tuesday
    const TARGET_HOUR = 10;
    const offsetMin = getTimeZoneOffsetMinutes(now, "America/Chicago");
    const chiNow = new Date(now.getTime() + offsetMin * 60000);
    const chiWeekday = chiNow.getUTCDay();
    let daysUntil = (TARGET_WEEKDAY - chiWeekday + 7) % 7;
    const candidate = new Date(Date.UTC(
      chiNow.getUTCFullYear(), chiNow.getUTCMonth(), chiNow.getUTCDate() + daysUntil, TARGET_HOUR, 0, 0
    ));
    if (daysUntil === 0 && chiNow.getUTCHours() >= TARGET_HOUR) {
      candidate.setUTCDate(candidate.getUTCDate() + 7);
    }
    const realOffsetMin = getTimeZoneOffsetMinutes(new Date(candidate.getTime() - offsetMin * 60000), "America/Chicago");
    return new Date(candidate.getTime() - realOffsetMin * 60000);
  }

  function renderResetCountdown() {
    const el = document.getElementById("reset-countdown");
    if (!el) return;
    const reset = nextWeeklyReset();
    const diffMs = reset - new Date();
    const days = Math.floor(diffMs / 86400000);
    const hours = Math.floor((diffMs % 86400000) / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    parts.push(`${hours}h`, `${minutes}m`);
    el.textContent = `Vault/raid saves reset in ${parts.join(" ")} (Tue 10am Central)`;
  }

  function renderTopStats() {
    const generated = new Date(DATA.generatedAt);
    document.getElementById("generated-at").textContent =
      "Last updated " + generated.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    renderResetCountdown();

    const warbandBtn = document.getElementById("warband-btn");
    if (warbandBtn) warbandBtn.hidden = !DATA.hasPrivateData;
    const allItemsBtn = document.getElementById("allitems-btn");
    if (allItemsBtn) allItemsBtn.hidden = !DATA.hasPrivateData;
  }

  // ---------------- Encrypted data.json support ----------------
  // data.json is optionally encrypted (AES-256-GCM, key derived via PBKDF2)
  // so the raw file is unreadable to anyone without the passphrase, even
  // though the repo/site are public. See scripts/fetch_data.py's
  // encrypt_output() for the matching Python-side implementation -- the
  // envelope format there must stay in sync with what's decoded here.
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
          try { localStorage.setItem(PASSPHRASE_STORAGE_KEY, input.value); } catch (err) { /* storage unavailable, fine */ }
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

  async function resolveData(rawData) {
    if (!rawData || !rawData.encrypted) {
      return rawData;
    }
    let saved = null;
    try { saved = localStorage.getItem(PASSPHRASE_STORAGE_KEY); } catch (err) { /* storage unavailable, fine */ }
    if (saved) {
      try {
        return await decryptEnvelope(rawData, saved);
      } catch (err) {
        try { localStorage.removeItem(PASSPHRASE_STORAGE_KEY); } catch (e2) { /* fine */ }
      }
    }
    return promptForPassphrase(rawData);
  }

  async function loadAndRender() {
    let rawData;
    try {
      // Cache-bust with a timestamp query param so a manual refresh always
      // hits the network, even on browsers that ignore cache:"no-store".
      const res = await fetch(`data.json?t=${Date.now()}`, { cache: "no-store" });
      rawData = await res.json();
    } catch (err) {
      tbodyEl.innerHTML = `<tr><td class="empty-msg">Could not load character data. Try again shortly.</td></tr>`;
      console.error(err);
      return false;
    }
    try {
      DATA = await resolveData(rawData);
    } catch (err) {
      tbodyEl.innerHTML = `<tr><td class="empty-msg">Could not decrypt character data.</td></tr>`;
      console.error(err);
      return false;
    }
    // Close any open panel rather than let it keep showing now-possibly-
    // stale data -- the table underneath is about to be fully rebuilt with
    // fresh data, and re-opening any of these is one click away.
    closeOtherPanels(null);
    renderTopStats();
    render();
    return true;
  }

  function wireRefreshButton() {
    const btn = document.getElementById("refresh-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.classList.add("is-refreshing");
      await loadAndRender();
      btn.classList.remove("is-refreshing");
      btn.disabled = false;
    });
  }

  async function init() {
    wireRefreshButton();
    wirePaginationControls();
    wireWarbandPanel();
    wireAllItemsPanel();
    await loadAndRender();
    setInterval(renderResetCountdown, 60000);
  }

  init();
})();
