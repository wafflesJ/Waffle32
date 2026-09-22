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

// CodeMirror 6 is loaded from a local bundle (cm-bundle.js), not a CDN.
// Two different CDN strategies were tried first — jsDelivr's /+esm, then
// esm.sh with explicit ?deps= version pinning — and both still let
// @codemirror/state load as two separate module instances, which breaks
// CodeMirror's extension system (it checks object identity, not just
// version numbers). Bundling CodeMirror and its dependencies into one
// file at build time removes the ambiguity entirely: there is only ever
// one copy of each package, so this ships alongside app.js/app.css.
import {
  EditorView,
  basicSetup,
  EditorState,
  keymap,
  indentWithTab,
  syntaxHighlighting,
  HighlightStyle,
  cpp,
  tags as t,
} from "./cm-bundle.js";

// ---- point this at your own Worker if you fork this project ----
const RELAY_URL = "https://esp-relay.waffle32.workers.dev";

// Boards the relay accepts, and whether they have a "USB CDC on boot" option.
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
// Project state.
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

let firmware = null;
let espLoader = null;
let monitorPort = null;
let monitorAbort = null;

function loadProject() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
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
const editorHost = el("editor-host");
const consoleEl = el("console");
const buildLight = el("build-light");
const progressWrap = el("progress");
const progressFill = el("progress-fill");
const btnCompile = el("btn-compile");
const btnConnect = el("btn-connect");
const btnFlash = el("btn-flash");
const btnMonitor = el("btn-monitor");

// ---------------------------------------------------------------------
// Console log, with ANSI color code support.
//
// arduino-cli colors its own output (e.g. the "Used platform / Version /
// Path" table) with raw ANSI escape sequences, which are meaningless
// inside HTML — they'd otherwise show up as literal "[92m" text. This
// converts them into colored spans using VS Code's own default terminal
// palette, so compiler output looks the way it would in a real terminal.
// ---------------------------------------------------------------------
const ANSI_COLORS = {
  30: "#3b3b3b", 31: "#cd3131", 32: "#0dbc79", 33: "#e5e510",
  34: "#2472c8", 35: "#bc3fbc", 36: "#11a8cd", 37: "#e5e5e5",
  90: "#666666", 91: "#f14c4c", 92: "#23d18b", 93: "#f5f543",
  94: "#3b8eea", 95: "#d670d6", 96: "#29b8db", 97: "#e5e5e5",
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ansiToHtml(raw) {
  const parts = raw.split(/\x1b\[([0-9;]*)m/);
  let html = "";
  let color = null, bold = false, italic = false, underline = false, dim = false;
  const openSpan = () => {
    const styles = [];
    if (color) styles.push("color:" + color);
    if (bold) styles.push("font-weight:600");
    if (italic) styles.push("font-style:italic");
    if (underline) styles.push("text-decoration:underline");
    if (dim) styles.push("opacity:.7");
    return styles.length ? `<span style="${styles.join(";")}">` : "<span>";
  };
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) html += openSpan() + escapeHtml(parts[i]) + "</span>";
    } else {
      const codes = parts[i] === "" ? [0] : parts[i].split(";").map(Number);
      for (const code of codes) {
        if (code === 0) { color = null; bold = italic = underline = dim = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 3) italic = true;
        else if (code === 4) underline = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (code === 23) italic = false;
        else if (code === 24) underline = false;
        else if (code === 39) color = null;
        else if (ANSI_COLORS[code]) color = ANSI_COLORS[code];
      }
    }
  }
  return html;
}

function log(text, kind) {
  const line = document.createElement("div");
  if (kind) line.className = "line-" + kind;
  if (text.indexOf("\x1b[") !== -1) {
    line.innerHTML = ansiToHtml(text);
  } else {
    line.textContent = text;
  }
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}
el("btn-clear-log").addEventListener("click", () => (consoleEl.textContent = ""));

// ---------------------------------------------------------------------
// Rendering: board settings, libraries, files, tabs
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

// ---------------------------------------------------------------------
// Editor: CodeMirror 6, styled to match VS Code Dark+.
//
// One EditorView instance persists for the app's lifetime. Switching
// files replaces its EditorState entirely (view.setState), which both
// swaps the document and gives each file its own independent undo
// history — editing test.cpp shouldn't let you undo into sketch.ino.
// ---------------------------------------------------------------------
const vsDarkUi = EditorView.theme(
  {
    "&": { backgroundColor: "var(--bg)", color: "#d4d4d4", height: "100%", fontSize: "13px" },
    ".cm-content": { fontFamily: "var(--mono)", caretColor: "#aeafad", padding: "10px 0" },
    ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
    "&.cm-focused .cm-cursor": { borderLeftColor: "#aeafad" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "#264f78" },
    ".cm-gutters": { backgroundColor: "var(--bg)", color: "#858585", border: "none" },
    ".cm-activeLineGutter": { backgroundColor: "#2a2d2e", color: "#c6c6c6" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.04)" },
    ".cm-matchingBracket, .cm-nonmatchingBracket": { backgroundColor: "#3a3d41", outline: "1px solid #565656" },
    ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none", color: "#6a6a6a" },
  },
  { dark: true },
);

// Token colors, mapped from the real tags @lezer/cpp's grammar emits
// (checked directly in its source) to VS Code Dark+'s actual palette —
// e.g. "if/for/return" are pink #C586C0 while "int/const/class" are blue
// #569CD6, exactly as VS Code splits control-flow from storage keywords.
const vsDarkHighlight = HighlightStyle.define([
  { tag: t.controlKeyword, color: "#C586C0" },
  { tag: t.processingInstruction, color: "#C586C0" }, // #include, #define, ...
  { tag: t.definitionKeyword, color: "#569CD6" }, // struct, class, namespace, using...
  { tag: t.modifier, color: "#569CD6" }, // const, static, virtual...
  { tag: t.operatorKeyword, color: "#569CD6" }, // new, sizeof, delete
  { tag: t.null, color: "#569CD6" },
  { tag: t.self, color: "#569CD6" }, // this
  { tag: t.bool, color: "#569CD6" },
  { tag: t.standard(t.typeName), color: "#569CD6" }, // int, char, void, bool...
  { tag: t.typeName, color: "#4EC9B0" }, // user-defined types (Servo, String...)
  { tag: t.namespace, color: "#4EC9B0" },
  { tag: t.propertyName, color: "#9CDCFE" },
  { tag: t.function(t.propertyName), color: "#DCDCAA" },
  { tag: t.variableName, color: "#9CDCFE" },
  { tag: t.function(t.variableName), color: "#DCDCAA" },
  { tag: t.function(t.definition(t.variableName)), color: "#DCDCAA" },
  { tag: t.labelName, color: "#C8C8C8" },
  { tag: [t.lineComment, t.blockComment], color: "#6A9955", fontStyle: "italic" },
  { tag: t.number, color: "#B5CEA8" },
  { tag: t.literal, color: "#B5CEA8" },
  { tag: [t.string, t.special(t.string), t.character], color: "#CE9178" },
  { tag: t.escape, color: "#D7BA7D" },
  { tag: t.meta, color: "#9CDCFE" },
  { tag: t.special(t.name), color: "#4FC1FF" }, // macro names
]);

let cmView = null;

function editorExtensions() {
  return [
    basicSetup, // line numbers, history, bracket matching + auto-closing, active-line highlight, etc.
    keymap.of([indentWithTab]), // Tab/Shift+Tab indent-select; not in basicSetup by default
    cpp(),
    vsDarkUi,
    syntaxHighlighting(vsDarkHighlight, { fallback: true }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const f = activeFile();
        if (f) f.content = update.state.doc.toString();
        scheduleSave();
      }
    }),
  ];
}

function loadFileIntoEditor() {
  const f = activeFile();
  try {
    const state = EditorState.create({ doc: f ? f.content : "", extensions: editorExtensions() });
    if (cmView) cmView.setState(state);
    else cmView = new EditorView({ state, parent: editorHost });
  } catch (err) {
    // Surface editor setup failures into our own console panel, since a
    // silent failure here is otherwise only visible in devtools.
    log("Editor failed to load: " + err.message, "error");
    console.error(err);
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 400);
}

function switchFile(name) {
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
  project.files.push({ name, content: "" });
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
// Collapsible sidebar
// ---------------------------------------------------------------------
const railEl = el("rail");
const railToggleBtn = el("btn-toggle-rail");

function setRailCollapsed(collapsed) {
  railEl.classList.toggle("collapsed", collapsed);
  railToggleBtn.setAttribute("aria-pressed", String(collapsed));
  localStorage.setItem("waffle32:railCollapsed", collapsed ? "1" : "0");
}
railToggleBtn.addEventListener("click", () => setRailCollapsed(!railEl.classList.contains("collapsed")));
setRailCollapsed(localStorage.getItem("waffle32:railCollapsed") === "1");

// ---------------------------------------------------------------------
// Resizable console drawer — drag the handle above the console
// ---------------------------------------------------------------------
const resizeHandle = el("drawer-resize-handle");
const savedHeight = Number(localStorage.getItem("waffle32:consoleHeight"));
if (savedHeight) consoleEl.style.height = savedHeight + "px";

resizeHandle.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  resizeHandle.setPointerCapture(ev.pointerId);
  resizeHandle.classList.add("active");
  const startY = ev.clientY;
  const startH = consoleEl.getBoundingClientRect().height;

  function onMove(e) {
    const delta = startY - e.clientY; // dragging up = taller
    const max = window.innerHeight * 0.78;
    const newH = Math.min(Math.max(startH + delta, 60), max);
    consoleEl.style.height = newH + "px";
  }
  function onUp() {
    resizeHandle.releasePointerCapture(ev.pointerId);
    resizeHandle.classList.remove("active");
    resizeHandle.removeEventListener("pointermove", onMove);
    resizeHandle.removeEventListener("pointerup", onUp);
    localStorage.setItem("waffle32:consoleHeight", String(Math.round(consoleEl.getBoundingClientRect().height)));
  }
  resizeHandle.addEventListener("pointermove", onMove);
  resizeHandle.addEventListener("pointerup", onUp);
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
