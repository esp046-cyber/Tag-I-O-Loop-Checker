(function () {
  "use strict";

  /* ---------------- Storage ---------------- */
  // Auto-saves to this device's local storage so your list survives closing
  // the browser or the app. Note: this only works when the file is opened
  // directly in a browser (as it will be once you download and open it, or
  // host it) — inline previews inside some chat tools sandbox storage away.

  const STORAGE_KEY = "loopchecker.tags.v1";
  const storageAvailable = (() => {
    try {
      const k = "__lc_test__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  })();

  const SEED_TAGS = [
    { tag: "FT-101", desc: "Flow transmitter — chiller header", plc: "Siemens S7", addr: "DB10.DBD24", status: "checked", notes: "Verified against BTU meter reading.", updated: "2026-09-10 08:14", photo: null },
    { tag: "PT-204", desc: "Pressure transmitter — condenser return", plc: "Rockwell CLX", addr: "N7:22", status: "fault", notes: "Reads 0 psi, physical gauge shows 42 psi. Suspect wiring.", updated: "2026-09-11 14:02", photo: null },
    { tag: "TT-118", desc: "Temp transmitter — supply header, District Cooling Plant 3", plc: "ABB AC500", addr: "%MW118", status: "forced", notes: "Forced to 6.5°C while sensor is on order.", updated: "2026-09-11 09:47", photo: null },
    { tag: "PU-301-RUN", desc: "Primary pump 1 — run feedback", plc: "Siemens S7", addr: "DB12.DBX2.0", status: "checked", notes: "", updated: "2026-09-09 16:20", photo: null },
    { tag: "PU-301-FLT", desc: "Primary pump 1 — fault relay", plc: "Siemens S7", addr: "DB12.DBX2.1", status: "unset", notes: "", updated: "", photo: null },
    { tag: "LSH-410", desc: "High level switch — cold water tank, Pumping Station 2", plc: "Rockwell CLX", addr: "N7:41", status: "unset", notes: "", updated: "", photo: null },
  ];

  function loadTags() {
    if (storageAvailable) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      } catch (e) { /* fall through to seed */ }
    }
    return SEED_TAGS.map((t) => ({ ...t }));
  }

  let saveTimer = null;
  function saveTags() {
    if (!storageAvailable) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tags));
        flashSaved();
      } catch (e) {
        // Quota exceeded (usually from large photos) — data still holds in memory this session.
        flashSaved("Storage full — export CSV to keep this");
      }
    }, 150);
  }

  function flashSaved(msg) {
    const el = document.getElementById("saveIndicator");
    if (!el) return;
    const prev = el.textContent;
    el.textContent = msg || "Saved to this device";
    el.classList.add("saved");
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => {
      el.textContent = "Tag & I/O verification";
      el.classList.remove("saved");
    }, 1400);
  }

  /* ---------------- State ---------------- */

  let tags = loadTags();
  let activeFilter = "all";
  let searchTerm = "";
  let sortMode = "default";
  let openTagId = null;
  let selectMode = false;
  let selectedTags = new Set();
  let recognizer = null;
  let listeningForTag = null;

  const el = {
    list: document.getElementById("tagList"),
    empty: document.getElementById("emptyState"),
    statusbar: document.getElementById("statusbar"),
    search: document.getElementById("searchInput"),
    chips: document.getElementById("filterChips"),
    sortSelect: document.getElementById("sortSelect"),
    toolshelf: document.getElementById("toolshelf"),
    menuToggle: document.getElementById("menuToggle"),
    csvInput: document.getElementById("csvInput"),
    exportBtn: document.getElementById("exportBtn"),
    addTagBtn: document.getElementById("addTagBtn"),
    clearBtn: document.getElementById("clearBtn"),
    handoverBtn: document.getElementById("handoverBtn"),
    handoverModal: document.getElementById("handoverModal"),
    handoverText: document.getElementById("handoverText"),
    handoverClose: document.getElementById("handoverClose"),
    handoverCopy: document.getElementById("handoverCopy"),
    handoverShare: document.getElementById("handoverShare"),
    selectModeBtn: document.getElementById("selectModeBtn"),
    bulkBar: document.getElementById("bulkBar"),
    bulkCount: document.getElementById("bulkCount"),
    bulkCancel: document.getElementById("bulkCancel"),
    photoInput: document.getElementById("photoInput"),
  };

  const STATUS_LABEL = { unset: "Unchecked", checked: "Checked", forced: "Forced", fault: "Fault" };
  const speechSupported = "webkitSpeechRecognition" in window || "SpeechRecognition" in window;

  /* ---------------- Rendering ---------------- */

  function render() {
    renderStatusbar();
    renderList();
    renderBulkBar();
  }

  function renderStatusbar() {
    const counts = { checked: 0, forced: 0, fault: 0, unset: 0 };
    tags.forEach((t) => counts[t.status]++);
    el.statusbar.innerHTML = `
      <div class="stat stat-checked"><span class="stat-num">${counts.checked}</span><span class="stat-label">Checked</span></div>
      <div class="stat stat-forced"><span class="stat-num">${counts.forced}</span><span class="stat-label">Forced</span></div>
      <div class="stat stat-fault"><span class="stat-num">${counts.fault}</span><span class="stat-label">Fault</span></div>
      <div class="stat stat-unset"><span class="stat-num">${counts.unset}</span><span class="stat-label">Unchecked</span></div>
    `;
  }

  function matchesFilter(t) { return activeFilter === "all" || t.status === activeFilter; }
  function matchesSearch(t) {
    if (!searchTerm) return true;
    return `${t.tag} ${t.desc} ${t.addr} ${t.plc}`.toLowerCase().includes(searchTerm);
  }

  function sortTags(list) {
    const arr = [...list];
    const statusRank = { fault: 0, forced: 1, unset: 2, checked: 3 };
    if (sortMode === "fault-first") arr.sort((a, b) => statusRank[a.status] - statusRank[b.status]);
    else if (sortMode === "name") arr.sort((a, b) => a.tag.localeCompare(b.tag, undefined, { numeric: true }));
    else if (sortMode === "updated") arr.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    return arr;
  }

  function renderList() {
    const visible = sortTags(tags.filter((t) => matchesFilter(t) && matchesSearch(t)));
    el.list.innerHTML = "";
    el.empty.hidden = visible.length !== 0;

    visible.forEach((t) => {
      const card = document.createElement("div");
      card.className = "card" + (openTagId === t.tag ? " open" : "") + (selectedTags.has(t.tag) ? " selected" : "");
      card.dataset.status = t.status;
      card.dataset.tag = t.tag;

      const selectBoxHtml = selectMode
        ? `<span class="card-select-box"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M5 12l4 4 10-10" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></span>`
        : `<svg class="card-chevron" viewBox="0 0 24 24" width="16" height="16"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

      card.innerHTML = `
        <button class="card-head" data-action="toggle">
          <div class="card-head-main">
            <div class="card-tag">${escapeHtml(t.tag)}</div>
            <div class="card-desc">${escapeHtml(t.desc || "No description")}</div>
          </div>
          <span class="badge badge-${t.status}">${STATUS_LABEL[t.status]}</span>
          ${selectBoxHtml}
        </button>
        <div class="card-body">
          <div class="card-meta">
            <div><span>PLC</span><strong>${escapeHtml(t.plc || "—")}</strong></div>
            <div><span>Address</span><strong>${escapeHtml(t.addr || "—")}</strong></div>
          </div>
          <div class="status-buttons">
            <button class="status-btn ${t.status === "checked" ? "active" : ""}" data-s="checked">Checked</button>
            <button class="status-btn ${t.status === "forced" ? "active" : ""}" data-s="forced">Forced</button>
            <button class="status-btn ${t.status === "fault" ? "active" : ""}" data-s="fault">Fault</button>
          </div>
          <div class="photo-row">
            ${t.photo
              ? `<div class="photo-thumb-wrap">
                   <img class="photo-thumb" src="${t.photo}" data-action="view-photo" alt="Photo for ${escapeHtml(t.tag)}" tabindex="0" role="button" aria-label="View photo for ${escapeHtml(t.tag)}">
                   <button class="photo-remove" data-action="remove-photo" aria-label="Remove photo">&times;</button>
                 </div>`
              : `<button class="photo-btn" data-action="add-photo">
                   <svg viewBox="0 0 24 24" width="15" height="15"><path d="M4 8h3l2-3h6l2 3h3v12H4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><circle cx="12" cy="14" r="3.2" stroke="currentColor" stroke-width="2" fill="none"/></svg>
                   Add photo
                 </button>`
            }
          </div>
          <div class="notes-row">
            <textarea class="notes-field" placeholder="Notes — what did you observe, what needs follow-up?">${escapeHtml(t.notes || "")}</textarea>
            ${speechSupported ? `<button class="mic-btn" data-action="mic" aria-label="Dictate note">
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3z" stroke="currentColor" stroke-width="2" fill="none"/><path d="M19 11a7 7 0 01-14 0M12 18v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
            </button>` : ""}
          </div>
          <div class="card-footer-row">
            <span class="timestamp">${t.updated ? "Updated " + t.updated : "Not yet checked"}</span>
            <button class="delete-link" data-action="delete">Remove tag</button>
          </div>
        </div>
      `;

      wireCard(card, t);
      el.list.appendChild(card);
    });
  }

  function wireCard(card, t) {
    card.querySelector('[data-action="toggle"]').addEventListener("click", () => {
      if (selectMode) {
        if (selectedTags.has(t.tag)) selectedTags.delete(t.tag);
        else selectedTags.add(t.tag);
        render();
        return;
      }
      openTagId = openTagId === t.tag ? null : t.tag;
      render();
    });

    card.querySelectorAll(".status-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = btn.dataset.s;
        t.status = t.status === s ? "unset" : s;
        touch(t);
        saveTags();
        render();
      });
    });

    const notesField = card.querySelector(".notes-field");
    if (notesField) {
      notesField.addEventListener("change", () => {
        t.notes = notesField.value;
        touch(t);
        saveTags();
      });
    }

    const deleteBtn = card.querySelector('[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => {
        tags = tags.filter((x) => x.tag !== t.tag);
        if (openTagId === t.tag) openTagId = null;
        saveTags();
        render();
      });
    }

    const addPhotoBtn = card.querySelector('[data-action="add-photo"]');
    if (addPhotoBtn) {
      addPhotoBtn.addEventListener("click", () => {
        el.photoInput.dataset.forTag = t.tag;
        el.photoInput.click();
      });
    }

    const viewPhoto = card.querySelector('[data-action="view-photo"]');
    if (viewPhoto) {
      viewPhoto.addEventListener("click", () => openLightbox(t.photo));
      viewPhoto.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openLightbox(t.photo); }
      });
    }

    const removePhoto = card.querySelector('[data-action="remove-photo"]');
    if (removePhoto) {
      removePhoto.addEventListener("click", () => {
        t.photo = null;
        touch(t);
        saveTags();
        render();
      });
    }

    const micBtn = card.querySelector('[data-action="mic"]');
    if (micBtn) {
      micBtn.addEventListener("click", () => toggleDictation(micBtn, notesField, t));
    }
  }

  function touch(t) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    t.updated = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ---------------- Search + filters + sort ---------------- */

  el.search.addEventListener("input", () => {
    searchTerm = el.search.value.trim().toLowerCase();
    renderList();
  });

  el.chips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    activeFilter = chip.dataset.filter;
    [...el.chips.children].forEach((c) => c.classList.toggle("active", c === chip));
    renderList();
  });
  el.chips.querySelector('[data-filter="all"]').classList.add("active");

  el.sortSelect.addEventListener("change", () => {
    sortMode = el.sortSelect.value;
    renderList();
  });

  /* ---------------- Tool shelf collapse (mobile) ---------------- */

  function shelfVisible() {
    return window.matchMedia("(min-width: 560px)").matches || el.toolshelf.classList.contains("force-open");
  }
  function syncShelf() {
    const show = shelfVisible();
    el.toolshelf.style.display = show ? "flex" : "none";
    el.menuToggle.setAttribute("aria-expanded", String(show));
  }
  el.menuToggle.addEventListener("click", () => {
    el.toolshelf.classList.toggle("force-open");
    syncShelf();
  });
  window.addEventListener("resize", syncShelf);
  syncShelf();

  /* ---------------- Add tag ---------------- */

  const template = document.getElementById("addFormTemplate");

  el.addTagBtn.addEventListener("click", () => {
    if (document.getElementById("addForm")) return;
    const node = template.content.cloneNode(true);
    el.list.parentNode.insertBefore(node, el.list);
    const form = document.getElementById("addForm");

    document.getElementById("f_cancel").addEventListener("click", () => form.remove());
    document.getElementById("f_save").addEventListener("click", () => {
      const tagId = document.getElementById("f_tag").value.trim();
      if (!tagId) { document.getElementById("f_tag").focus(); return; }
      if (tags.some((t) => t.tag.toLowerCase() === tagId.toLowerCase())) {
        alert(`Tag "${tagId}" already exists.`);
        return;
      }
      tags.unshift({
        tag: tagId,
        desc: document.getElementById("f_desc").value.trim(),
        plc: document.getElementById("f_plc").value.trim(),
        addr: document.getElementById("f_addr").value.trim(),
        status: "unset",
        notes: "",
        updated: "",
        photo: null,
      });
      form.remove();
      saveTags();
      render();
    });

    document.getElementById("f_tag").focus();
  });

  /* ---------------- Clear list ---------------- */

  el.clearBtn.addEventListener("click", () => {
    if (tags.length === 0) return;
    if (confirm("Remove all tags from the current list? Export a CSV first if you want to keep them.")) {
      tags = [];
      openTagId = null;
      selectedTags.clear();
      saveTags();
      render();
    }
  });

  /* ---------------- Select mode + bulk actions ---------------- */

  el.selectModeBtn.addEventListener("click", () => {
    selectMode = !selectMode;
    el.selectModeBtn.classList.toggle("active", selectMode);
    if (!selectMode) selectedTags.clear();
    render();
  });

  function renderBulkBar() {
    if (!selectMode || selectedTags.size === 0) {
      el.bulkBar.hidden = true;
      return;
    }
    el.bulkBar.hidden = false;
    el.bulkCount.textContent = `${selectedTags.size} selected`;
  }

  el.bulkBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".bulk-btn[data-s]");
    if (!btn) return;
    const s = btn.dataset.s;
    tags.forEach((t) => {
      if (selectedTags.has(t.tag)) { t.status = s; touch(t); }
    });
    selectedTags.clear();
    saveTags();
    render();
  });

  el.bulkCancel.addEventListener("click", () => {
    selectedTags.clear();
    render();
  });

  /* ---------------- Photo capture ---------------- */

  el.photoInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    const forTag = el.photoInput.dataset.forTag;
    if (!file || !forTag) return;
    const t = tags.find((x) => x.tag === forTag);
    if (!t) return;

    const reader = new FileReader();
    reader.onload = () => {
      resizeImage(reader.result, 900, 0.65).then((dataUrl) => {
        t.photo = dataUrl;
        touch(t);
        saveTags();
        render();
      });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  });

  function resizeImage(dataUrl, maxDim, quality) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { resolve(dataUrl); return; } // no 2d context available — keep the original photo
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        } catch (err) {
          // Any canvas failure falls back to the original photo rather than losing it.
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function openLightbox(src) {
    const box = document.createElement("div");
    box.className = "photo-lightbox";
    box.innerHTML = `<img src="${src}" alt="Tag photo">`;
    const close = () => {
      box.remove();
      document.removeEventListener("keydown", onKeydown);
    };
    const onKeydown = (e) => { if (e.key === "Escape") close(); };
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKeydown);
    document.body.appendChild(box);
  }

  /* ---------------- Voice notes ---------------- */

  function toggleDictation(btn, notesField, t) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Voice dictation isn't supported in this browser."); return; }

    if (recognizer && listeningForTag === t.tag) {
      recognizer.stop();
      return;
    }
    if (recognizer) recognizer.stop();

    const session = new SR();
    session.lang = "en-US";
    session.interimResults = false;
    session.maxAlternatives = 1;
    recognizer = session;
    listeningForTag = t.tag;
    btn.classList.add("listening");

    session.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      notesField.value = (notesField.value ? notesField.value + " " : "") + transcript;
      t.notes = notesField.value;
      touch(t);
      saveTags();
    };
    // Only clear the shared state if this session is still the active one —
    // otherwise a stale stop()/onend from a previous card can wipe out a
    // session that was started right after it (race when switching cards fast).
    session.onerror = () => {
      btn.classList.remove("listening");
      if (recognizer === session) { recognizer = null; listeningForTag = null; }
    };
    session.onend = () => {
      btn.classList.remove("listening");
      if (recognizer === session) { recognizer = null; listeningForTag = null; }
    };

    try {
      session.start();
    } catch (err) {
      // Some browsers throw synchronously if permission was denied or a
      // session is already starting; fail quietly instead of crashing the app.
      btn.classList.remove("listening");
      if (recognizer === session) { recognizer = null; listeningForTag = null; }
    }
  }

  /* ---------------- Shift handover note ---------------- */

  if (!navigator.share) el.handoverShare.style.display = "none";

  el.handoverBtn.addEventListener("click", () => {
    el.handoverText.value = buildHandoverNote();
    el.handoverModal.hidden = false;
  });
  el.handoverClose.addEventListener("click", () => (el.handoverModal.hidden = true));
  el.handoverModal.addEventListener("click", (e) => {
    if (e.target === el.handoverModal) el.handoverModal.hidden = true;
  });

  function buildHandoverNote() {
    const now = new Date();
    const stamp = now.toLocaleString();
    const faults = tags.filter((t) => t.status === "fault");
    const forced = tags.filter((t) => t.status === "forced");
    const unchecked = tags.filter((t) => t.status === "unset");
    const checked = tags.filter((t) => t.status === "checked");

    let out = `LOOP CHECKER — SHIFT HANDOVER\n${stamp}\n\n`;
    out += `Checked ${checked.length}  |  Forced ${forced.length}  |  Fault ${faults.length}  |  Unchecked ${unchecked.length}\n\n`;

    if (faults.length) {
      out += `FAULTS — needs attention\n`;
      faults.forEach((t) => { out += `  ${t.tag}  ${t.desc || ""}${t.notes ? " — " + t.notes : ""}\n`; });
      out += `\n`;
    }
    if (forced.length) {
      out += `FORCED — remember to un-force once resolved\n`;
      forced.forEach((t) => { out += `  ${t.tag}  ${t.desc || ""}${t.notes ? " — " + t.notes : ""}\n`; });
      out += `\n`;
    }
    if (unchecked.length) {
      out += `NOT YET CHECKED (${unchecked.length})\n`;
      out += `  ${unchecked.map((t) => t.tag).join(", ")}\n\n`;
    }
    out += `Checked and confirmed good: ${checked.length} of ${tags.length} tags.\n`;
    return out;
  }

  el.handoverCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el.handoverText.value);
      el.handoverCopy.textContent = "Copied";
      setTimeout(() => (el.handoverCopy.textContent = "Copy"), 1200);
    } catch (e) {
      el.handoverText.select();
      document.execCommand("copy");
    }
  });

  el.handoverShare.addEventListener("click", async () => {
    if (navigator.share) {
      try { await navigator.share({ title: "Loop Checker handover", text: el.handoverText.value }); }
      catch (e) { /* user cancelled */ }
    } else {
      alert("Sharing isn't supported in this browser — use Copy instead.");
    }
  });

  /* ---------------- CSV import ---------------- */

  el.csvInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = parseCsv(reader.result);
        mergeImported(imported);
        saveTags();
        render();
      } catch (err) {
        alert("Could not read that CSV file. " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  function parseCsv(text) {
    const rows = splitCsvRows(text);
    if (rows.length < 2) throw new Error("File needs a header row and at least one data row.");

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = (names) => names.map((n) => header.indexOf(n)).find((i) => i !== -1);

    const idx = {
      tag: col(["tag", "instrument tag", "tagname"]),
      desc: col(["description", "desc"]),
      plc: col(["plc", "plc type", "controller"]),
      addr: col(["address", "addr", "plc address"]),
      status: col(["status"]),
      notes: col(["notes", "note"]),
    };

    if (idx.tag === undefined) throw new Error('No "Tag" column found in the header row.');

    const validStatus = ["unset", "checked", "forced", "fault"];

    return rows.slice(1)
      .filter((r) => r.some((c) => c.trim() !== ""))
      .map((r) => {
        const rawStatus = (idx.status !== undefined ? r[idx.status] || "" : "").trim().toLowerCase();
        return {
          tag: (r[idx.tag] || "").trim(),
          desc: idx.desc !== undefined ? (r[idx.desc] || "").trim() : "",
          plc: idx.plc !== undefined ? (r[idx.plc] || "").trim() : "",
          addr: idx.addr !== undefined ? (r[idx.addr] || "").trim() : "",
          status: validStatus.includes(rawStatus) ? rawStatus : "unset",
          notes: idx.notes !== undefined ? (r[idx.notes] || "").trim() : "",
          updated: "",
          photo: null,
        };
      })
      .filter((t) => t.tag !== "");
  }

  function splitCsvRows(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
          if (c === "\r" && text[i + 1] === "\n") i++;
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        } else field += c;
      }
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length > 1 || r[0] !== "");
  }

  function mergeImported(imported) {
    let added = 0, updated = 0;
    imported.forEach((incoming) => {
      const existing = tags.find((t) => t.tag.toLowerCase() === incoming.tag.toLowerCase());
      if (existing) {
        Object.assign(existing, incoming, { tag: existing.tag, photo: existing.photo });
        updated++;
      } else {
        tags.push(incoming);
        added++;
      }
    });
    alert(`Import complete: ${added} tag${added === 1 ? "" : "s"} added, ${updated} updated.`);
  }

  /* ---------------- CSV export ---------------- */

  el.exportBtn.addEventListener("click", () => {
    const header = ["Tag", "Description", "PLC", "Address", "Status", "Notes", "Updated"];
    const lines = [header.join(",")];
    tags.forEach((t) => {
      lines.push([t.tag, t.desc, t.plc, t.addr, t.status, t.notes, t.updated].map(csvEscape).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `loop-checker-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  function csvEscape(val) {
    const s = String(val ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /* ---------------- Service worker (offline app shell) ---------------- */

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  /* ---------------- Go ---------------- */

  render();
})();
