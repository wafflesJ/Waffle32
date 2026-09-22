// Waffle32 — browser front end for the esp-relay build service.
//
// This file has no build step: it's loaded directly as an ES module by
// index.html. It talks to two things over the network:
//   1. Your Cloudflare Worker (compiles code via GitHub Actions)
//   2. The board itself, over Web Serial (flashing, via esptool-js)

import {
  ESPLoader,
  Transport,
} from "https://unpkg.com/esptool-js@0.7.0/bundle.js";
import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

// ---- point this at your own Worker if you fork this project ----
const RELAY_URL = "https://esp-relay.waffle32.workers.dev";

// Boards the relay accepts, and whether they have a "USB CDC on boot" option.
// (The classic ESP32 has no native USB, so it has no such setting.)
const BOARDS = [
  { id: "esp32", label: "ESP32 Dev Module", cdc: false },
  { id: "esp32s2", label: "ESP32-S2 Dev Module", cdc: true },
  { id: "esp32s3", label: "ESP32-S3 Dev Module", cdc: true },
  { id: "esp32c3", label: "ESP32-C3 Dev Module", cdc: true },
  { id: "esp32c6", label: "ESP32-C6 Dev Module", cdc: true },
  { id: "esp32h2", label: "ESP32-H2 Dev Module", cdc: true },
];

const DEFAULT_SKETCH = `void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
  Serial.println("hello from Waffle32");
  delay(500);
}
`;

const STORAGE_KEY = "waffle32:project";

// ---------------------------------------------------------------------
// Project state. Kept as one plain object and written to localStorage
// on every change, so a page refresh never loses work.
// ---------------------------------------------------------------------
let project = loadProject() || {
  name: "my-project",
  board: "esp32",
  cdc: false,
  partition: "default",
  libs: [],
  files: [{ name: "sketch.ino", content: DEFAULT_SKETCH }],
  activeFile: "sketch.ino",
};

let firmware = null; // { bytes: Uint8Array, board: string } once a build finishes
let espLoader = null; // connected ESPLoader instance, once "Connect" succeeds
let monitorPort = null; // raw SerialPort, while the monitor is open
let monitorAbort = null;

function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // corrupted or blocked storage — start fresh rather than crash
  }
}

function saveProject() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
  } catch (err) {
    log("Could not save to browser storage: " + err.message, "error");
  }
}

function activeFile() {
  return project.files.find((f) => f.name === project.activeFile) || project.files[0];
}

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const projectNameInput = el("project-name");
const boardSelect = el("board-select");
const cdcRow = el("cdc-row");
const cdcCheck = el("cdc-check");
const cdcHint = el("cdc-hint");
const partitionSelect = el("partition-select");
const libInput = el("lib-input");
const libList = el("lib-list");
const fileList = el("file-list");
const newFileNameInput = el("new-file-name");
const tabsEl = el("tabs");
const editor = el("editor");
const gutter = el("gutter");
const consoleEl = el("console");
const buildLight = el("build-light");
const progressWrap = el("progress");
const progressFill = el("progress-fill");
const btnCompile = el("btn-compile");
const btnConnect = el("btn-connect");
const btnFlash = el("btn-flash");
const btnMonitor = el("btn-monitor");

// ---------------------------------------------------------------------
// Console log
// ---------------------------------------------------------------------
function log(text, kind) {
  const line = document.createElement("div");
  if (kind) line.className = "line-" + kind;
  line.textContent = text;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}
el("btn-clear-log").addEventListener("click", () => (consoleEl.textContent = ""));

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function renderBoards() {
  boardSelect.innerHTML = BOARDS.map((b) => `<option value="${b.id}">${b.label}</option>`).join("");
  boardSelect.value = project.board;
  applyBoardCdcRules();
}

function applyBoardCdcRules() {
  const board = BOARDS.find((b) => b.id === project.board);
  const supportsCdc = board ? board.cdc : false;
  cdcCheck.disabled = !supportsCdc;
  cdcRow.style.opacity = supportsCdc ? "1" : ".45";
  cdcCheck.checked = supportsCdc && project.cdc;
  cdcHint.textContent = supportsCdc
    ? "Turn this on if your sketch's Serial output should appear over the same USB port used to program the board."
    : "This board has no native USB, so this setting doesn't apply.";
}

function renderLibs() {
  libList.innerHTML = "";
  project.libs.forEach((lib, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(lib)}</span>`;
    const btn = document.createElement("button");
    btn.textContent = "×";
    btn.title = "Remove library";
    btn.addEventListener("click", () => {
      project.libs.splice(i, 1);
      renderLibs();
      saveProject();
    });
    li.appendChild(btn);
    libList.appendChild(li);
  });
}

function renderFiles() {
  fileList.innerHTML = "";
  project.files.forEach((f) => {
    const li = document.createElement("li");
    li.className = "file-item" + (f.name === project.activeFile ? " active" : "");
    const nameSpan = document.createElement("span");
    nameSpan.textContent = f.name;
    li.appendChild(nameSpan);
    if (project.files.length > 1) {
      const btn = document.createElement("button");
      btn.textContent = "×";
      btn.title = "Delete file";
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        deleteFile(f.name);
      });
      li.appendChild(btn);
    }
    li.addEventListener("click", () => switchFile(f.name));
    fileList.appendChild(li);
  });
  renderTabs();
}

function renderTabs() {
  tabsEl.innerHTML = "";
  project.files.forEach((f) => {
    const tab = document.createElement("div");
    tab.className = "tab" + (f.name === project.activeFile ? " active" : "");
    tab.textContent = f.name;
    tab.addEventListener("click", () => switchFile(f.name));
    tabsEl.appendChild(tab);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------
// Editor (a textarea with a synced line-number gutter, kept deliberately
// simple rather than pulling in a full editor component)
// ---------------------------------------------------------------------
function loadFileIntoEditor() {
  const f = activeFile();
  editor.value = f ? f.content : "";
  updateGutter();
}

function updateGutter() {
  const lines = editor.value.split("\n").length;
  let out = "";
  for (let i = 1; i <= lines; i++) out += i + "\n";
  gutter.textContent = out;
}

editor.addEventListener("scroll", () => (gutter.scrollTop = editor.scrollTop));

editor.addEventListener("keydown", (ev) => {
  if (ev.key === "Tab") {
    ev.preventDefault();
    const start = editor.selectionStart, end = editor.selectionEnd;
    editor.value = editor.value.slice(0, start) + "  " + editor.value.slice(end);
    editor.selectionStart = editor.selectionEnd = start + 2;
    updateGutter();
    scheduleSave();
  }
});

let saveTimer = null;
editor.addEventListener("input", () => {
  updateGutter();
  const f = activeFile();
  if (f) f.content = editor.value;
  scheduleSave();
});
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 400);
}

function switchFile(name) {
  const f = activeFile();
  if (f) f.content = editor.value; // capture edits before switching away
  project.activeFile = name;
  loadFileIntoEditor();
  renderFiles();
  saveProject();
}

function deleteFile(name) {
  if (project.files.length <= 1) return;
  if (!confirm(`Delete ${name}? This can't be undone.`)) return;
  project.files = project.files.filter((f) => f.name !== name);
  if (project.activeFile === name) project.activeFile = project.files[0].name;
  loadFileIntoEditor();
  renderFiles();
  saveProject();
}

const FILE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.(ino|cpp|c|h|hpp)$/i;

function addFile(name) {
  name = name.trim();
  if (!name) return;
  if (!FILE_NAME_RE.test(name)) {
    log(`"${name}" isn't a valid file name. Use letters, numbers, . _ - and end in .ino, .cpp, .c, .h or .hpp.`, "error");
    return;
  }
  if (project.files.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
    log(`${name} already exists.`, "error");
    return;
  }
  const isHeader = /\.(h|hpp)$/i.test(name);
  project.files.push({ name, content: isHeader ? "" : "" });
  project.activeFile = name;
  loadFileIntoEditor();
  renderFiles();
  saveProject();
}

// ---------------------------------------------------------------------
// Wiring: top bar, board settings, libraries, files
// ---------------------------------------------------------------------
projectNameInput.value = project.name;
projectNameInput.addEventListener("input", () => {
  project.name = projectNameInput.value || "my-project";
  saveProject();
});

boardSelect.addEventListener("change", () => {
  project.board = boardSelect.value;
  applyBoardCdcRules();
  saveProject();
});
cdcCheck.addEventListener("change", () => {
  project.cdc = cdcCheck.checked;
  saveProject();
});
partitionSelect.addEventListener("change", () => {
  project.partition = partitionSelect.value;
  saveProject();
});

el("btn-add-lib").addEventListener("click", () => {
  const name = libInput.value.trim();
  if (!name) return;
  if (project.libs.includes(name)) {
    log(`${name} is already in the library list.`, "error");
    return;
  }
  project.libs.push(name);
  libInput.value = "";
  renderLibs();
  saveProject();
});
libInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") el("btn-add-lib").click();
});

el("btn-add-file").addEventListener("click", () => {
  addFile(newFileNameInput.value);
  newFileNameInput.value = "";
});
newFileNameInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") el("btn-add-file").click();
});

el("btn-new").addEventListener("click", () => {
  if (!confirm("Start a new blank project? This replaces everything currently open.")) return;
  project = {
    name: "my-project",
    board: "esp32",
    cdc: false,
    partition: "default",
    libs: [],
    files: [{ name: "sketch.ino", content: DEFAULT_SKETCH }],
    activeFile: "sketch.ino",
  };
  projectNameInput.value = project.name;
  partitionSelect.value = project.partition;
  renderBoards();
  renderLibs();
  renderFiles();
  loadFileIntoEditor();
  saveProject();
});

// ---------------------------------------------------------------------
// Export / import as .zip
// ---------------------------------------------------------------------
el("btn-export").addEventListener("click", async () => {
  const f = activeFile();
  if (f) f.content = editor.value;
  const zip = new JSZip();
  for (const file of project.files) zip.file(file.name, file.content);
  zip.file(
    "waffle32.json",
    JSON.stringify({ board: project.board, cdc: project.cdc, partition: project.partition, libs: project.libs }, null, 2),
  );
  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (project.name || "project") + ".zip";
  a.click();
  URL.revokeObjectURL(a.href);
});

el("btn-import").addEventListener("click", () => el("file-import-input").click());
el("file-import-input").addEventListener("change", async (ev) => {
  const picked = [...ev.target.files];
  if (picked.length === 0) return;
  try {
    if (picked.length === 1 && picked[0].name.toLowerCase().endsWith(".zip")) {
      const zip = await JSZip.loadAsync(picked[0]);
      const files = [];
      let settings = null;
      for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        if (name === "waffle32.json") {
          settings = JSON.parse(await entry.async("string"));
        } else if (FILE_NAME_RE.test(name)) {
          files.push({ name, content: await entry.async("string") });
        }
      }
      if (files.length === 0) throw new Error("No .ino/.cpp/.h files found in that zip.");
      project.files = files;
      project.activeFile = (files.find((f) => /\.ino$/i.test(f.name)) || files[0]).name;
      if (settings) Object.assign(project, settings);
    } else {
      const files = [];
      for (const file of picked) {
        if (!FILE_NAME_RE.test(file.name)) throw new Error(`${file.name} isn't a .ino/.cpp/.c/.h/.hpp file.`);
        files.push({ name: file.name, content: await file.text() });
      }
      project.files = files;
      project.activeFile = (files.find((f) => /\.ino$/i.test(f.name)) || files[0]).name;
    }
    renderBoards();
    renderLibs();
    renderFiles();
    loadFileIntoEditor();
    saveProject();
    log("Project imported.", "ok");
  } catch (err) {
    log("Import failed: " + err.message, "error");
  } finally {
    ev.target.value = "";
  }
});

// ---------------------------------------------------------------------
// Compile: send the project to the Worker, poll until it's done
// ---------------------------------------------------------------------
function setBuildState(state) {
  buildLight.dataset.state = state;
  btnCompile.disabled = state === "running";
}

btnCompile.addEventListener("click", async () => {
  const f = activeFile();
  if (f) f.content = editor.value;

  if (!project.files.some((x) => /\.ino$/i.test(x.name))) {
    log("Add a .ino file before compiling.", "error");
    return;
  }

  setBuildState("running");
  firmware = null;
  btnFlash.disabled = true;
  log(`Compiling for ${project.board}…`, "info");

  try {
    const startRes = await fetch(RELAY_URL + "/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        board: project.board,
        cdc: project.cdc,
        partition: project.partition,
        libs: project.libs,
        files: project.files,
      }),
    });
    const startBody = await startRes.json();
    if (!startRes.ok) throw new Error(startBody.error || "The build service refused this project.");
    const id = startBody.id;

    let lastStage = "";
    while (true) {
      await sleep(2000);
      const statusRes = await fetch(RELAY_URL + "/status/" + id);
      const status = await statusRes.json();
      if (status.stage && status.stage !== lastStage) {
        log(status.stage + "…", "info");
        lastStage = status.stage;
      }
      if (status.status === "done") {
        const fwRes = await fetch(RELAY_URL + "/result/" + id);
        const bytes = new Uint8Array(await fwRes.arrayBuffer());
        firmware = { bytes, board: project.board };
        btnFlash.disabled = false;
        setBuildState("done");
        log(`Build finished — ${bytes.length.toLocaleString()} bytes ready to flash.`, "ok");
        break;
      }
      if (status.status === "error") {
        setBuildState("error");
        log("Build failed:", "error");
        log(status.log || "(no compiler output was returned)", "error");
        break;
      }
    }
  } catch (err) {
    setBuildState("error");
    log("Could not reach the build service: " + err.message, "error");
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------
// Flash + monitor over Web Serial
// ---------------------------------------------------------------------
const terminal = {
  clean() {},
  write(s) {
    consoleEl.lastChild && consoleEl.lastChild.classList.contains("stub")
      ? (consoleEl.lastChild.textContent += s)
      : log(s, undefined);
  },
  writeLine(s) {
    log(s);
  },
};

btnConnect.addEventListener("click", async () => {
  if (!("serial" in navigator)) {
    log("Web Serial isn't available in this browser. Use desktop Chrome, Edge, or Firefox 151+.", "error");
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    const transport = new Transport(port, true);
    espLoader = new ESPLoader({ transport, baudrate: 115200, terminal });
    log("Connecting…", "info");
    const chip = await espLoader.main();
    log("Connected: " + chip, "ok");
    btnConnect.textContent = "Reconnect";
    btnMonitor.disabled = false;
    if (firmware) btnFlash.disabled = false;
  } catch (err) {
    log("Couldn't connect: " + err.message, "error");
  }
});

btnFlash.addEventListener("click", async () => {
  if (!espLoader) {
    log("Connect to the board first.", "error");
    return;
  }
  if (!firmware) {
    log("Compile a build first.", "error");
    return;
  }
  btnFlash.disabled = true;
  progressWrap.hidden = false;
  try {
    log("Flashing " + firmware.bytes.length.toLocaleString() + " bytes at 0x0…", "info");
    await espLoader.writeFlash({
      fileArray: [{ data: firmware.bytes, address: 0x0 }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_i, written, total) => {
        progressFill.style.width = Math.round((written / total) * 100) + "%";
      },
    });
    await espLoader.after("hard_reset");
    log("Flash complete. The board has been reset.", "ok");
  } catch (err) {
    log("Flashing failed: " + err.message, "error");
  } finally {
    btnFlash.disabled = false;
    setTimeout(() => (progressWrap.hidden = true), 1500);
  }
});

btnMonitor.addEventListener("click", async () => {
  if (monitorPort) {
    monitorAbort && monitorAbort.abort();
    try { await monitorPort.close(); } catch {}
    monitorPort = null;
    btnMonitor.textContent = "Monitor";
    log("Monitor closed.", "info");
    return;
  }
  if (!espLoader) {
    log("Connect to the board first.", "error");
    return;
  }
  try {
    await espLoader.transport.disconnect();
    const port = espLoader.transport.device;
    await port.open({ baudRate: 115200 });
    monitorPort = port;
    btnMonitor.textContent = "Stop monitor";
    log("Monitor open at 115200 baud.", "info");
    const decoder = new TextDecoderStream();
    monitorAbort = new AbortController();
    port.readable.pipeTo(decoder.writable, { signal: monitorAbort.signal }).catch(() => {});
    const reader = decoder.readable.getReader();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) log(line.replace(/\r$/, ""));
    }
  } catch (err) {
    log("Monitor stopped: " + err.message, "info");
    monitorPort = null;
    btnMonitor.textContent = "Monitor";
  }
});

// ---------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------
renderBoards();
partitionSelect.value = project.partition;
renderLibs();
renderFiles();
loadFileIntoEditor();
log("Ready. Write a sketch, then Compile, then Connect and Flash.", "info");
