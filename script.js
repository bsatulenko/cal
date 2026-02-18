const PAST_DAYS = 3;
const FUTURE_DAYS = 10;
const START_MINUTES = 7 * 60;
const END_MINUTES = 23 * 60;
const SLOT_MINUTES = 30;
const TIME_ZONE = "Europe/London";
const DAY_MS = 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;

const firebaseConfig = {
  apiKey: "AIzaSyDWFSDIbfKkKvpwnO66zRyJOl-r0libpJI",
  authDomain: "calendar-baf79.firebaseapp.com",
  projectId: "calendar-baf79",
  storageBucket: "calendar-baf79.firebasestorage.app",
  messagingSenderId: "435211468617",
  appId: "1:435211468617:web:1a27ebe07f42b11fc7e498"
};


const grid = document.getElementById("planner-grid");
const secretInput = document.getElementById("sync-code");
const connectButton = document.getElementById("sync-connect");
const syncStatus = document.getElementById("sync-status");
const dateInput = document.getElementById("base-date");
const dateDisplay = document.getElementById("date-display");
const todayOnlyButton = document.getElementById("today-only");

const cellIndex = new Map();
const eventCache = new Map();
const saveTimers = new Map();

let db = null;
let unsubscribe = null;
let cloudEnabled = false;
let sharedSecret = null;

const dateTimeParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const dateParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const headerParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  weekday: "short",
  day: "2-digit",
  month: "short",
});

let currentTodayIso = null;
let baseDateIso = null;
let lastKnownTodayIso = null;
let showTodayOnly = false;

function partsToObject(parts) {
  return parts.reduce((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = Number(part.value);
    }
    return acc;
  }, {});
}

function londonNowUtcMs() {
  const parts = partsToObject(dateTimeParts.formatToParts(new Date()));
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute
  );
}

function londonMidnightUtcMs() {
  const parts = partsToObject(dateTimeParts.formatToParts(new Date()));
  return Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0);
}

function isoDateFromUtc(utcMs) {
  const parts = partsToObject(dateParts.formatToParts(new Date(utcMs)));
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

function londonUtcMsForLocal(dateIso, hour, minute) {
  const [year, month, day] = dateIso.split("-").map(Number);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = partsToObject(dateTimeParts.formatToParts(new Date(utcGuess)));
  const actualLocalUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute
  );
  const desiredLocalUtc = Date.UTC(year, month - 1, day, hour, minute);
  const diff = actualLocalUtc - desiredLocalUtc;
  return utcGuess - diff;
}

function timeLabel(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const suffix = hour24 >= 12 ? "pm" : "am";
  const displayHour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${String(displayHour).padStart(2, "0")}:${String(minute).padStart(2, "0")}${suffix}`;
}

function timeKey(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function storageKey(dateISO, time) {
  return `event-${dateISO}-${time}`;
}

function eventKey(dateISO, time) {
  return `${dateISO}|${time}`;
}

function formatDisplayDate(dateIso) {
  const [year, month, day] = dateIso.split("-").map(Number);
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

function getVisibleOffsets() {
  if (showTodayOnly) {
    return { start: 0, end: 0 };
  }
  return { start: -PAST_DAYS, end: FUTURE_DAYS };
}

function setSyncStatus(text, variant = "") {
  if (!syncStatus) return;
  syncStatus.textContent = text;
  syncStatus.classList.remove("good", "warn", "bad");
  if (variant) syncStatus.classList.add(variant);
}

function firebaseConfigReady() {
  return Object.values(firebaseConfig).every(
    (value) => value && !String(value).startsWith("YOUR_")
  );
}

function initFirebase() {
  if (!firebaseConfigReady()) {
    setSyncStatus("Add Firebase config", "warn");
    return false;
  }
  if (typeof firebase === "undefined") {
    setSyncStatus("Firebase script missing", "bad");
    return false;
  }
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }
  db = firebase.firestore();
  return true;
}

function applyEventToCell(key, data) {
  const cell = cellIndex.get(key);
  if (!cell) return;
  const active = document.activeElement;
  if (active && active.classList.contains("event-text") && active.closest(".cell.event") === cell) {
    return;
  }
  const textEl = cell.querySelector(".event-text");
  const checkbox = cell.querySelector(".event-check");
  const text = data.text || "";
  const done = Boolean(data.done);
  if (textEl) textEl.textContent = text;
  if (checkbox) checkbox.checked = done;
  setCellState(cell, text, done);
}

function refreshCloudSubscription() {
  if (!cloudEnabled || !db || !sharedSecret) return;
  if (unsubscribe) unsubscribe();

  const baseMidnightUtc = londonUtcMsForLocal(baseDateIso, 0, 0);
  const offsets = getVisibleOffsets();
  const startIso = isoDateFromUtc(baseMidnightUtc + offsets.start * DAY_MS);
  const endIso = isoDateFromUtc(baseMidnightUtc + offsets.end * DAY_MS);

  const query = db
    .collection("schedules")
    .doc(sharedSecret)
    .collection("events")
    .where("date", ">=", startIso)
    .where("date", "<=", endIso);

  unsubscribe = query.onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const data = change.doc.data() || {};
        const date = data.date;
        const time = data.time;
        if (!date || !time) return;
        const key = eventKey(date, time);
        if (change.type === "removed") {
          eventCache.delete(key);
          applyEventToCell(key, { text: "", done: false });
        } else {
          const text = typeof data.text === "string" ? data.text : "";
          const done = Boolean(data.done);
          eventCache.set(key, { text, done });
          applyEventToCell(key, { text, done });
        }
      });
      setSyncStatus("Synced", "good");
    },
    () => {
      setSyncStatus("Sync error", "bad");
    }
  );
}

function writeEventToCloud(dateIso, time, text, done) {
  if (!cloudEnabled || !db || !sharedSecret) return;
  const docId = `${dateIso}_${time.replace(":", "")}`;
  const ref = db
    .collection("schedules")
    .doc(sharedSecret)
    .collection("events")
    .doc(docId);

  if (text) {
    ref.set(
      {
        date: dateIso,
        time,
        text,
        done,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    ).catch(() => {
      setSyncStatus("Sync error", "bad");
    });
  } else {
    ref.delete().catch(() => {
      setSyncStatus("Sync error", "bad");
    });
  }
}

function scheduleCloudSave(dateIso, time, text, done) {
  const key = eventKey(dateIso, time);
  const timer = saveTimers.get(key);
  if (timer) clearTimeout(timer);
  saveTimers.set(
    key,
    setTimeout(() => {
      saveTimers.delete(key);
      writeEventToCloud(dateIso, time, text, done);
    }, SAVE_DEBOUNCE_MS)
  );
}

function migrateLocalToCloud() {
  if (!cloudEnabled || !db || !sharedSecret) return;
  if (localStorage.getItem("planner-migrated") === "1") return;
  const keys = Object.keys(localStorage);
  keys.forEach((key) => {
    const match = key.match(/^event-(\\d{4}-\\d{2}-\\d{2})-(\\d{2}:\\d{2})$/);
    if (!match) return;
    const dateIso = match[1];
    const time = match[2];
    const saved = localStorage.getItem(key);
    if (!saved) return;
    let text = "";
    let done = false;
    try {
      const parsed = JSON.parse(saved);
      text = typeof parsed.text === "string" ? parsed.text : "";
      done = Boolean(parsed.done);
    } catch {
      text = saved;
      done = false;
    }
    if (text) {
      writeEventToCloud(dateIso, time, text, done);
    }
  });
  localStorage.setItem("planner-migrated", "1");
}

function getCellText(cell) {
  const textEl = cell.querySelector(".event-text");
  return textEl ? textEl.innerText.trim() : "";
}

function loadStoredEvent(dateIso, time) {
  if (cloudEnabled) {
    return eventCache.get(eventKey(dateIso, time)) || { text: "", done: false };
  }
  const saved = localStorage.getItem(storageKey(dateIso, time));
  if (!saved) return { text: "", done: false };
  try {
    const parsed = JSON.parse(saved);
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      done: Boolean(parsed.done),
    };
  } catch {
    return { text: saved, done: false };
  }
}

function setCellState(cell, text, done) {
  const hasText = Boolean(text);
  const checkbox = cell.querySelector(".event-check");
  const textEl = cell.querySelector(".event-text");

  cell.classList.toggle("empty", !hasText);
  cell.classList.toggle("has-event", hasText);
  cell.classList.toggle("done", hasText && done);

  if (!hasText) {
    if (checkbox) checkbox.checked = false;
    if (textEl) textEl.textContent = "";
  }
}

function saveCell(cell) {
  const dateIso = cell.dataset.date;
  const time = cell.dataset.time;
  const text = getCellText(cell);
  const checkbox = cell.querySelector(".event-check");
  const done = Boolean(checkbox && checkbox.checked);

  if (cloudEnabled) {
    if (text) {
      eventCache.set(eventKey(dateIso, time), { text, done });
    } else {
      eventCache.delete(eventKey(dateIso, time));
    }
    scheduleCloudSave(dateIso, time, text, done);
  } else {
    if (text) {
      localStorage.setItem(storageKey(dateIso, time), JSON.stringify({ text, done }));
    } else {
      localStorage.removeItem(storageKey(dateIso, time));
    }
  }

  setCellState(cell, text, done);
}

function buildGrid() {
  grid.innerHTML = "";
  cellIndex.clear();

  const offsets = getVisibleOffsets();
  const totalDays = offsets.end - offsets.start + 1;
  grid.style.gridTemplateColumns = `110px repeat(${totalDays}, minmax(160px, 1fr))`;

  const todayMidnightUtc = londonMidnightUtcMs();
  if (!baseDateIso) {
    baseDateIso = isoDateFromUtc(todayMidnightUtc);
    if (dateInput) dateInput.value = baseDateIso;
    if (dateDisplay) dateDisplay.textContent = formatDisplayDate(baseDateIso);
  }
  const todayIso = isoDateFromUtc(todayMidnightUtc);
  if (showTodayOnly) {
    baseDateIso = todayIso;
    if (dateInput) dateInput.value = todayIso;
    if (dateDisplay) dateDisplay.textContent = formatDisplayDate(todayIso);
  }
  const baseMidnightUtc = londonUtcMsForLocal(baseDateIso, 0, 0);
  currentTodayIso = todayIso;

  const corner = document.createElement("div");
  corner.className = "cell corner header";
  corner.textContent = "UK time";
  grid.appendChild(corner);

  for (let dayOffset = offsets.start; dayOffset <= offsets.end; dayOffset += 1) {
    const dateUtc = baseMidnightUtc + dayOffset * DAY_MS;
    const dateIso = isoDateFromUtc(dateUtc);
    const header = document.createElement("div");
    header.className = "cell header";
    if (dateIso === todayIso) {
      header.classList.add("today");
    }
    header.textContent = headerParts.format(new Date(dateUtc));
    header.dataset.date = dateIso;
    grid.appendChild(header);
  }

  for (let minutes = START_MINUTES; minutes <= END_MINUTES; minutes += SLOT_MINUTES) {
    const timeCell = document.createElement("div");
    timeCell.className = "cell time";
    timeCell.textContent = timeLabel(minutes);
    grid.appendChild(timeCell);

    for (let dayOffset = offsets.start; dayOffset <= offsets.end; dayOffset += 1) {
      const dateUtc = baseMidnightUtc + dayOffset * DAY_MS;
      const dateIso = isoDateFromUtc(dateUtc);
      const time = timeKey(minutes);

      const cell = document.createElement("div");
      cell.className = "cell event";
      cell.dataset.date = dateIso;
      cell.dataset.time = time;
      cell.classList.add("empty");

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "event-check";
      checkbox.setAttribute("aria-label", "Mark as done");

      const text = document.createElement("div");
      text.className = "event-text";
      text.contentEditable = "true";
      text.dataset.placeholder = "Add event";
      text.spellcheck = false;

      const stored = loadStoredEvent(dateIso, time);
      if (stored.text) {
        text.textContent = stored.text;
      }
      checkbox.checked = stored.done;
      setCellState(cell, stored.text, stored.done);

      cell.appendChild(checkbox);
      cell.appendChild(text);

      cellIndex.set(eventKey(dateIso, time), cell);
      grid.appendChild(cell);
    }
  }

  refreshCloudSubscription();
}

function updatePastCells() {
  const nowUtc = londonNowUtcMs();
  const todayIso = isoDateFromUtc(londonMidnightUtcMs());
  if (todayIso !== currentTodayIso) {
    if (showTodayOnly) {
      baseDateIso = todayIso;
      if (dateInput) dateInput.value = todayIso;
      if (dateDisplay) dateDisplay.textContent = formatDisplayDate(todayIso);
    } else if (dateInput.value === lastKnownTodayIso) {
      dateInput.value = todayIso;
      baseDateIso = todayIso;
      if (dateDisplay) dateDisplay.textContent = formatDisplayDate(todayIso);
    }
    lastKnownTodayIso = todayIso;
    buildGrid();
  }

  const cells = grid.querySelectorAll(".cell.event");
  cells.forEach((cell) => {
    const dateIso = cell.dataset.date;
    const [year, month, day] = dateIso.split("-").map(Number);
    const [hour, minute] = cell.dataset.time.split(":").map(Number);
    const cellUtc = Date.UTC(year, month - 1, day, hour, minute);
    const ratio = Math.min(
      1,
      Math.max(0, (nowUtc - cellUtc) / (SLOT_MINUTES * 60 * 1000))
    );
    cell.style.setProperty(
      "--past-percent",
      `${Math.round(ratio * 100)}%`
    );
    if (ratio >= 1) {
      cell.classList.add("past");
    } else {
      cell.classList.remove("past");
    }
  });
}

function setupDatePicker() {
  if (!dateInput) return;
  const todayIso = isoDateFromUtc(londonMidnightUtcMs());
  lastKnownTodayIso = todayIso;
  baseDateIso = todayIso;
  dateInput.value = todayIso;
  if (dateDisplay) dateDisplay.textContent = formatDisplayDate(todayIso);

  dateInput.addEventListener("change", () => {
    const selected = dateInput.value || todayIso;
    if (showTodayOnly) {
      showTodayOnly = false;
      if (todayOnlyButton) todayOnlyButton.classList.remove("is-active");
      dateInput.disabled = false;
    }
    baseDateIso = selected;
    if (dateDisplay) dateDisplay.textContent = formatDisplayDate(selected);
    buildGrid();
    updatePastCells();
  });
}

function setupTodayOnly() {
  if (!todayOnlyButton) return;
  todayOnlyButton.addEventListener("click", () => {
    showTodayOnly = !showTodayOnly;
    todayOnlyButton.classList.toggle("is-active", showTodayOnly);
    if (showTodayOnly) {
      const todayIso = isoDateFromUtc(londonMidnightUtcMs());
      baseDateIso = todayIso;
      if (dateInput) {
        dateInput.value = todayIso;
        dateInput.disabled = true;
      }
      if (dateDisplay) dateDisplay.textContent = formatDisplayDate(todayIso);
    } else if (dateInput) {
      dateInput.disabled = false;
    }
    buildGrid();
    updatePastCells();
  });
}

function setupSync() {
  if (!secretInput || !connectButton) return;

  const stored = localStorage.getItem("planner-secret");
  if (stored) {
    secretInput.value = stored;
  }

  connectButton.addEventListener("click", () => {
    const value = secretInput.value.trim();
    if (value.length < 4) {
      setSyncStatus("Code too short", "warn");
      return;
    }
    if (!initFirebase()) return;
    sharedSecret = value;
    localStorage.setItem("planner-secret", value);
    cloudEnabled = true;
    eventCache.clear();
    setSyncStatus("Connecting...", "warn");
    refreshCloudSubscription();
    migrateLocalToCloud();
  });

  secretInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      connectButton.click();
    }
  });

  if (stored) {
    connectButton.click();
  }
}

function setupPersistence() {
  grid.addEventListener("input", (event) => {
    const cell = event.target.closest(".cell.event");
    if (!cell) return;
    if (!event.target.classList.contains("event-text")) return;
    saveCell(cell);
  });

  grid.addEventListener("change", (event) => {
    const cell = event.target.closest(".cell.event");
    if (!cell) return;
    if (!event.target.classList.contains("event-check")) return;
    saveCell(cell);
  });

  grid.addEventListener(
    "blur",
    (event) => {
      const cell = event.target.closest(".cell.event");
      if (!cell) return;
      if (!event.target.classList.contains("event-text")) return;
      const textEl = cell.querySelector(".event-text");
      if (textEl) textEl.textContent = textEl.innerText.trim();
      saveCell(cell);
    },
    true
  );
}

setupDatePicker();
setupSync();
setupTodayOnly();
buildGrid();
setupPersistence();
updatePastCells();
setInterval(updatePastCells, 60 * 1000);
