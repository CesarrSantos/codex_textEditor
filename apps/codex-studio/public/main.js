const appState = {
  activeProcessId: null,
  activeTurnId: null,
  connection: null,
  contexts: [],
  eventStream: null,
  files: new Map(),
  inlineAbortController: null,
  inlineRequestId: 0,
  inlineSuggestion: null,
  inlineTimer: null,
  openTabs: [],
  pollTimer: null,
  reconnectNoticeTimer: null,
  searchTimer: null,
  tree: new Map(),
  treeExpanded: new Set(),
  workspaceRoot: "",
};

const dom = {
  attachFileButton: document.querySelector("#attach-file-button"),
  appNotice: document.querySelector("#app-notice"),
  chatForm: document.querySelector("#chat-form"),
  chatEmptyState: document.querySelector("#chat-empty-state"),
  chatInput: document.querySelector("#chat-input"),
  chatLog: document.querySelector("#chat-log"),
  clearContexts: document.querySelector("#clear-contexts"),
  commandForm: document.querySelector("#command-form"),
  commandInput: document.querySelector("#command-input"),
  connectionStatus: document.querySelector("#connection-status"),
  contextPills: document.querySelector("#context-pills"),
  contextSummary: document.querySelector("#context-summary"),
  editorDirtyState: document.querySelector("#editor-dirty-state"),
  editorFileLabel: document.querySelector("#editor-file-label"),
  editorInput: document.querySelector("#editor-input"),
  editorLanguage: document.querySelector("#editor-language"),
  editorPrediction: document.querySelector("#editor-prediction"),
  fimButton: document.querySelector("#fim-button"),
  lineNumbers: document.querySelector("#line-numbers"),
  newFileButton: document.querySelector("#new-file-button"),
  newFolderButton: document.querySelector("#new-folder-button"),
  saveButton: document.querySelector("#save-button"),
  searchInput: document.querySelector("#search-input"),
  searchResults: document.querySelector("#search-results"),
  stopCodex: document.querySelector("#stop-codex"),
  stopCommand: document.querySelector("#stop-command"),
  tabStrip: document.querySelector("#tab-strip"),
  terminalOutput: document.querySelector("#terminal-output"),
  treeRoot: document.querySelector("#tree-root"),
  workspaceForm: document.querySelector("#workspace-form"),
  workspaceInput: document.querySelector("#workspace-input"),
};

window.addEventListener("error", (event) => {
  showNotice(event.message || "Unexpected client error.");
});

window.addEventListener("unhandledrejection", (event) => {
  const message =
    event.reason?.message || String(event.reason || "Unexpected async client error.");
  showNotice(message);
});

void bootstrap();

async function bootstrap() {
  try {
    bindUi();
    renderContexts();
    await refreshState();
    await loadDirectory(appState.workspaceRoot);
    await openFirstUsefulFile();
    connectEventStream();
  } catch (error) {
    showNotice(error.message || "Studio bootstrap failed.");
  }
}

function bindUi() {
  dom.attachFileButton.addEventListener("click", attachActiveFileToCodex);
  dom.newFileButton.addEventListener("click", createNewFile);
  dom.newFolderButton.addEventListener("click", createNewFolder);
  dom.saveButton.addEventListener("click", saveActiveFile);
  dom.fimButton.addEventListener("click", () => requestInlineSuggestion(true));
  dom.clearContexts.addEventListener("click", () => {
    appState.contexts = [];
    renderContexts();
    showNotice("Cleared attached context.", "success");
  });
  dom.stopCodex.addEventListener("click", stopCodexTurn);
  dom.stopCommand.addEventListener("click", stopActiveCommand);
  dom.chatForm.addEventListener("submit", submitChat);
  dom.chatInput.addEventListener("keydown", handleChatKeydown);
  dom.commandForm.addEventListener("submit", submitCommand);
  dom.workspaceForm.addEventListener("submit", submitWorkspaceChange);
  dom.searchInput.addEventListener("input", handleSearchInput);
  dom.editorInput.addEventListener("input", handleEditorInput);
  dom.editorInput.addEventListener("scroll", syncEditorScroll);
  dom.editorInput.addEventListener("keydown", handleEditorKeydown);
  dom.editorInput.addEventListener("click", handleCursorActivity);
  dom.editorInput.addEventListener("keyup", handleCursorActivity);
}

async function refreshState() {
  const payload = await requestJson("/api/state");
  applyState(payload);
}

function applyState(payload) {
  appState.workspaceRoot = payload.workspaceRoot;
  appState.connection = payload.connected;
  appState.activeProcessId = payload.currentCommandId;
  appState.activeTurnId = payload.currentTurnId;

  dom.workspaceInput.value = payload.workspaceRoot;
  dom.connectionStatus.textContent = payload.connected
    ? "Codex Live"
    : payload.lastError || "Disconnected";
  dom.connectionStatus.classList.toggle("offline", !payload.connected);
  if (payload.connected) {
    clearNotice();
  } else if (payload.lastError) {
    showNotice(payload.lastError, "error", false);
  }
}

function connectEventStream() {
  if (appState.eventStream) {
    appState.eventStream.close();
  }

  const events = new EventSource("/events");
  appState.eventStream = events;
  events.onopen = () => {
    if (appState.reconnectNoticeTimer) {
      window.clearTimeout(appState.reconnectNoticeTimer);
      appState.reconnectNoticeTimer = null;
    }
    clearNotice();
  };
  events.addEventListener("state", (event) => {
    applyState(JSON.parse(event.data));
  });
  events.addEventListener("fsChanged", async (event) => {
    const payload = JSON.parse(event.data);
    try {
      await refreshChangedPaths(payload.changedPaths || []);
    } catch (error) {
      showNotice(error.message || "Failed to refresh changed files.");
    }
  });
  events.addEventListener("codexTurnStarted", (event) => {
    const payload = JSON.parse(event.data);
    appendChatMessage({
      contexts: payload.contexts,
      role: "user",
      text: payload.message,
    });
    appendChatMessage({
      role: "assistant",
      text: "",
      turnId: payload.turnId,
    });
  });
  events.addEventListener("codexDelta", (event) => {
    const payload = JSON.parse(event.data);
    appendChatDelta(payload.turnId, payload.delta);
  });
  events.addEventListener("codexItem", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.item.type === "agentMessage") {
      setChatMessageText(payload.turnId, payload.item.text);
      return;
    }
    if (payload.item.type === "commandExecution") {
      appendChatMessage({
        meta: true,
        role: "assistant",
        text: `Ran command: ${payload.item.command}`,
      });
    }
    if (payload.item.type === "fileChange") {
      appendChatMessage({
        meta: true,
        role: "assistant",
        text: `Updated ${payload.item.changes.length} file(s).`,
      });
    }
  });
  events.addEventListener("codexTurnCompleted", () => {
    syncChatEmptyState();
  });
  events.addEventListener("commandStarted", (event) => {
    const payload = JSON.parse(event.data);
    dom.terminalOutput.textContent = `$ ${payload.command}\n`;
  });
  events.addEventListener("commandOutput", (event) => {
    const payload = JSON.parse(event.data);
    dom.terminalOutput.textContent += payload.text;
    dom.terminalOutput.scrollTop = dom.terminalOutput.scrollHeight;
  });
  events.addEventListener("commandExit", (event) => {
    const payload = JSON.parse(event.data);
    const suffix = payload.error
      ? `\n[process error] ${payload.error}\n`
      : `\n[exit ${payload.exitCode}]\n`;
    dom.terminalOutput.textContent += suffix;
  });
  events.addEventListener("serverLog", (event) => {
    const payload = JSON.parse(event.data);
    if (!appState.connection && payload.text.trim()) {
      dom.terminalOutput.textContent += `[codex ${payload.stream}] ${payload.text}`;
    }
  });
  events.addEventListener("devReload", () => {
    window.location.reload();
  });
  events.onerror = () => {
    if (appState.reconnectNoticeTimer) {
      return;
    }
    appState.reconnectNoticeTimer = window.setTimeout(() => {
      showNotice(
        "Live event stream disconnected. The app is retrying automatically; manual actions should still work.",
        "error",
        false,
      );
      appState.reconnectNoticeTimer = null;
    }, 2500);
  };
}

async function loadDirectory(targetPath) {
  const payload = await requestJson(`/api/tree?path=${encodeURIComponent(targetPath)}`);
  appState.tree.set(targetPath, payload.entries);
  renderTree();
}

function renderTree() {
  const rootItems = renderTreeItems(appState.workspaceRoot, 0);
  dom.treeRoot.innerHTML = "";
  dom.treeRoot.append(rootItems);
  if (!dom.treeRoot.childNodes.length) {
    dom.treeRoot.innerHTML = '<div class="empty-state">No files loaded for this workspace.</div>';
  }
}

function renderTreeItems(parentPath, depth) {
  const entries = appState.tree.get(parentPath) || [];
  const fragment = document.createDocumentFragment();

  for (const entry of entries.sort(sortEntries)) {
    const row = document.createElement("button");
    row.className = "tree-item";
    row.style.paddingLeft = `${12 + depth * 16}px`;
    row.innerHTML = `<span class="tree-icon">${entry.isDirectory ? "▸" : "•"}</span><span>${entry.fileName}</span>`;

    if (entry.isDirectory) {
      const expanded = appState.treeExpanded.has(entry.path);
      row.classList.toggle("expanded", expanded);
      row.addEventListener("click", async () => {
        if (appState.treeExpanded.has(entry.path)) {
          appState.treeExpanded.delete(entry.path);
          renderTree();
          return;
        }
        appState.treeExpanded.add(entry.path);
        if (!appState.tree.has(entry.path)) {
          await loadDirectory(entry.path);
        } else {
          renderTree();
        }
      });
      fragment.append(row);
      if (expanded) {
        fragment.append(renderTreeItems(entry.path, depth + 1));
      }
      continue;
    }

    row.addEventListener("click", () => openFile(entry.path));
    row.classList.toggle("active", entry.path === appState.activePath);
    fragment.append(row);
  }

  return fragment;
}

async function openFile(filePath) {
  try {
    if (!appState.files.has(filePath)) {
      const payload = await requestJson(`/api/file?path=${encodeURIComponent(filePath)}`);
      appState.files.set(filePath, {
        dirty: false,
        language: detectLanguage(filePath),
        savedText: payload.text,
        text: payload.text,
        path: filePath,
      });
      appState.openTabs.push(filePath);
    }

    appState.activePath = filePath;
    renderTree();
    renderTabs();
    renderEditor();
  } catch (error) {
    showNotice(error.message || `Failed to open ${filePath}.`);
  }
}

function renderTabs() {
  dom.tabStrip.innerHTML = "";
  for (const filePath of appState.openTabs) {
    const tab = document.createElement("div");
    const file = appState.files.get(filePath);
    tab.className = "tab";
    tab.classList.toggle("active", filePath === appState.activePath);
    tab.innerHTML = `
      <button class="tab-open" type="button">${basename(filePath)}${file.dirty ? " *" : ""}</button>
      <button class="tab-close" type="button" aria-label="Close ${basename(filePath)}">×</button>
    `;
    tab.querySelector(".tab-open").addEventListener("click", () => {
      appState.activePath = filePath;
      renderTree();
      renderTabs();
      renderEditor();
    });
    tab.querySelector(".tab-close").addEventListener("click", () => {
      closeTab(filePath);
    });
    dom.tabStrip.append(tab);
  }
}

function renderEditor() {
  const file = getActiveFile();
  if (!file) {
    dom.editorInput.value = "";
    clearInlineSuggestion();
    dom.lineNumbers.innerHTML = "";
    dom.editorFileLabel.textContent = "No file selected";
    dom.editorLanguage.textContent = "Plain text";
    dom.editorDirtyState.textContent = "Saved";
    return;
  }

  dom.editorFileLabel.textContent = relativePath(file.path);
  dom.editorLanguage.textContent = prettifyLanguage(file.language);
  dom.editorDirtyState.textContent = file.dirty ? "Unsaved" : "Saved";
  if (dom.editorInput.value !== file.text) {
    dom.editorInput.value = file.text;
  }
  dom.lineNumbers.innerHTML = renderLineNumbers(file.text);
  renderInlineSuggestion();
}

function handleEditorInput() {
  const file = getActiveFile();
  if (!file) {
    return;
  }

  file.text = dom.editorInput.value;
  file.dirty = file.text !== file.savedText;
  renderTabs();
  renderEditor();
  syncEditorScroll();
  scheduleInlineSuggestion();
}

function syncEditorScroll() {
  dom.editorPrediction.scrollTop = dom.editorInput.scrollTop;
  dom.editorPrediction.scrollLeft = dom.editorInput.scrollLeft;
  dom.lineNumbers.scrollTop = dom.editorInput.scrollTop;
}

async function saveActiveFile() {
  const file = getActiveFile();
  if (!file) {
    return;
  }

  try {
    await requestJson("/api/file", {
      body: JSON.stringify({
        path: file.path,
        text: file.text,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    file.savedText = file.text;
    file.dirty = false;
    renderTabs();
    renderEditor();
  } catch (error) {
    showNotice(error.message || `Failed to save ${file.path}.`);
  }
}

function handleEditorKeydown(event) {
  if (!event.metaKey && !event.ctrlKey && (event.key === "Tab" || event.key === "Enter")) {
    if (acceptInlineSuggestion()) {
      event.preventDefault();
      return;
    }
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveActiveFile();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
    event.preventDefault();
    attachSelectionToCodex();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && event.code === "Space") {
    event.preventDefault();
    void requestInlineSuggestion(true);
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    insertIntoEditor("  ");
  }
}

function handleChatKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    dom.chatForm.requestSubmit();
  }
}

function insertIntoEditor(text) {
  const start = dom.editorInput.selectionStart;
  const end = dom.editorInput.selectionEnd;
  const value = dom.editorInput.value;
  dom.editorInput.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
  dom.editorInput.selectionStart = dom.editorInput.selectionEnd = start + text.length;
  handleEditorInput();
}

function attachSelectionToCodex() {
  const file = getActiveFile();
  if (!file) {
    return;
  }

  const start = dom.editorInput.selectionStart;
  const end = dom.editorInput.selectionEnd;
  const selectedText = file.text.slice(start, end);
  if (!selectedText.trim()) {
    return;
  }

  appState.contexts.push({
    end,
    language: file.language,
    path: file.path,
    selectedText,
    start,
    summary: `Selection ${start}:${end}`,
  });
  renderContexts();
  dom.chatInput.focus();
}

function attachActiveFileToCodex() {
  const file = getActiveFile();
  if (!file) {
    return;
  }

  const maxContextChars = 16000;
  const selectedText =
    file.text.length > maxContextChars
      ? `${file.text.slice(0, maxContextChars)}\n\n/* truncated */`
      : file.text;

  appState.contexts.push({
    end: selectedText.length,
    language: file.language,
    path: file.path,
    selectedText,
    start: 0,
    summary: file.text.length > maxContextChars ? "File head (truncated)" : "Full file",
  });
  renderContexts();
  showNotice(`Attached ${basename(file.path)} to the next prompt.`, "success");
  dom.chatInput.focus();
}

function renderContexts() {
  dom.contextPills.innerHTML = "";
  dom.contextSummary.textContent =
    appState.contexts.length === 0
      ? "No context attached."
      : `${appState.contexts.length} context attachment${appState.contexts.length === 1 ? "" : "s"} ready.`;

  for (const [index, context] of appState.contexts.entries()) {
    const pill = document.createElement("button");
    pill.className = "context-pill";
    pill.innerHTML = `<strong>${basename(context.path)}</strong><span>${context.summary || context.language}</span>`;
    pill.addEventListener("click", () => {
      appState.contexts.splice(index, 1);
      renderContexts();
    });
    dom.contextPills.append(pill);
  }

  syncChatEmptyState();
}

async function submitChat(event) {
  event.preventDefault();
  const message = dom.chatInput.value.trim();
  if (!message) {
    return;
  }

  try {
    await requestJson("/api/codex/send", {
      body: JSON.stringify({
        contexts: appState.contexts,
        message,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    dom.chatInput.value = "";
  } catch (error) {
    showNotice(error.message || "Failed to send message to Codex.");
  }
}

async function stopCodexTurn() {
  try {
    const payload = await requestJson("/api/codex/stop", {
      method: "POST",
    });
    if (payload.interrupted) {
      showNotice("Stopped the active Codex turn.", "success");
    }
  } catch (error) {
    showNotice(error.message || "Failed to stop Codex.");
  }
}

function appendChatMessage(message) {
  const row = document.createElement("article");
  row.className = `chat-entry ${message.role}`;
  if (message.meta) {
    row.classList.add("meta");
  }
  if (message.turnId) {
    row.dataset.turnId = message.turnId;
  }

  row.innerHTML = `
    <header>
      <span class="chat-entry-role">${message.role === "assistant" ? "Codex" : "You"}</span>
      <span class="chat-entry-meta">${message.meta ? "Event" : "Message"}</span>
    </header>
    <div class="chat-entry-body"></div>
  `;

  setChatBodyText(row, message.text);

  if (message.contexts?.length) {
    const contextList = document.createElement("div");
    contextList.className = "chat-context-list";
    contextList.textContent = message.contexts
      .map((context) => basename(context.path))
      .join(", ");
    row.append(contextList);
  }

  dom.chatLog.append(row);
  dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
  syncChatEmptyState();
}

function appendChatDelta(turnId, delta) {
  const row = dom.chatLog.querySelector(`[data-turn-id="${turnId}"]`);
  if (!row) {
    return;
  }
  const nextText = `${row.dataset.messageText || ""}${delta}`;
  setChatBodyText(row, nextText);
  dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
}

function setChatMessageText(turnId, text) {
  const row = dom.chatLog.querySelector(`[data-turn-id="${turnId}"]`);
  if (!row) {
    appendChatMessage({
      role: "assistant",
      text,
      turnId,
    });
    return;
  }
  setChatBodyText(row, text);
  dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
}

function setChatBodyText(row, text) {
  row.dataset.messageText = text;
  const body = row.querySelector(".chat-entry-body");
  renderChatBody(body, text);
}

function renderChatBody(container, text) {
  container.innerHTML = "";
  for (const segment of splitMessageSegments(text)) {
    if (segment.type === "code") {
      const block = document.createElement("div");
      block.className = "chat-code";

      const label = document.createElement("span");
      label.className = "chat-code-label";
      label.textContent = segment.language || "code";

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = segment.text;
      pre.append(code);

      block.append(label, pre);
      container.append(block);
      continue;
    }

    const paragraph = document.createElement("p");
    paragraph.className = "chat-copy";
    paragraph.textContent = segment.text;
    container.append(paragraph);
  }
}

function splitMessageSegments(text) {
  const rawText = String(text || "");
  if (!rawText) {
    return [{ text: "", type: "text" }];
  }

  const segments = [];
  const pattern = /```([\w-]+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(rawText))) {
    if (match.index > lastIndex) {
      segments.push({
        text: rawText.slice(lastIndex, match.index).trim(),
        type: "text",
      });
    }
    segments.push({
      language: match[1] || "",
      text: match[2].replace(/\n$/, ""),
      type: "code",
    });
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < rawText.length) {
    segments.push({
      text: rawText.slice(lastIndex).trim(),
      type: "text",
    });
  }

  return segments.filter((segment) => segment.type === "code" || segment.text);
}

function syncChatEmptyState() {
  dom.chatEmptyState.classList.toggle("hidden", dom.chatLog.childElementCount > 0);
}

async function submitCommand(event) {
  event.preventDefault();
  const command = dom.commandInput.value.trim();
  if (!command) {
    return;
  }
  try {
    await requestJson("/api/command/start", {
      body: JSON.stringify({ command }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    showNotice(error.message || "Failed to start command.");
  }
}

async function stopActiveCommand() {
  if (!appState.activeProcessId) {
    return;
  }
  try {
    await requestJson("/api/command/stop", {
      body: JSON.stringify({ processId: appState.activeProcessId }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  } catch (error) {
    showNotice(error.message || "Failed to stop command.");
  }
}

async function submitWorkspaceChange(event) {
  event.preventDefault();
  const nextPath = dom.workspaceInput.value.trim();
  if (!nextPath || nextPath === appState.workspaceRoot) {
    return;
  }

  try {
    const payload = await requestJson("/api/workspace/open", {
      body: JSON.stringify({ path: nextPath }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    resetWorkspaceUi(payload.workspaceRoot);
    showNotice(`Opened workspace ${payload.workspaceRoot}`, "success");
  } catch (error) {
    showNotice(error.message || "Failed to change workspace.");
  }
}

function handleSearchInput() {
  window.clearTimeout(appState.searchTimer);
  const query = dom.searchInput.value.trim();
  if (!query) {
    dom.searchResults.classList.add("hidden");
    dom.searchResults.innerHTML = "";
    return;
  }

  appState.searchTimer = window.setTimeout(async () => {
    try {
      const payload = await requestJson(`/api/search?query=${encodeURIComponent(query)}`);
      renderSearchResults(payload.files || []);
    } catch (error) {
      showNotice(error.message || "Search failed.");
    }
  }, 150);
}

function renderSearchResults(files) {
  dom.searchResults.classList.remove("hidden");
  dom.searchResults.innerHTML = "";
  for (const match of files.slice(0, 12)) {
    const item = document.createElement("button");
    item.className = "search-item";
    item.innerHTML = `<strong>${match.file_name}</strong><span>${match.path}</span>`;
    item.addEventListener("click", () => {
      dom.searchResults.classList.add("hidden");
      dom.searchInput.value = "";
      void openFile(pathJoin(appState.workspaceRoot, match.path));
    });
    dom.searchResults.append(item);
  }
}

async function requestInlineSuggestion(explicit = false) {
  const file = getActiveFile();
  if (!file) {
    clearInlineSuggestion();
    return;
  }

  const selectionStart = dom.editorInput.selectionStart;
  const selectionEnd = dom.editorInput.selectionEnd;
  if (selectionStart !== selectionEnd) {
    clearInlineSuggestion();
    return;
  }

  const requestId = ++appState.inlineRequestId;
  if (appState.inlineAbortController) {
    appState.inlineAbortController.abort();
  }
  appState.inlineAbortController = new AbortController();

  try {
    const payload = await requestJson("/api/codex/completion", {
      body: JSON.stringify({
        content: file.text,
        cursorEnd: selectionEnd,
        cursorStart: selectionStart,
        explicit,
        language: file.language,
        path: file.path,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: appState.inlineAbortController.signal,
    });

    if (requestId !== appState.inlineRequestId) {
      return;
    }

    const suggestionText = normalizeInlineSuggestion({
      cursor: selectionStart,
      fullText: file.text,
      suggestionText: payload.insertText || "",
      suffix: file.text.slice(selectionStart),
    });
    if (!suggestionText) {
      clearInlineSuggestion();
      return;
    }

    appState.inlineSuggestion = {
      path: file.path,
      text: suggestionText,
    };
    renderInlineSuggestion();
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    clearInlineSuggestion();
    showNotice(error.message || "Inline prediction failed.");
  }
}

window.setInterval(() => {
  void refreshState().catch(() => {});
}, 10000);

async function refreshChangedPaths(changedPaths) {
  const directoriesToRefresh = new Set([appState.workspaceRoot]);

  for (const changedPath of changedPaths) {
    directoriesToRefresh.add(parentPath(changedPath));
    const file = appState.files.get(changedPath);
    if (file && !file.dirty) {
      const payload = await requestJson(`/api/file?path=${encodeURIComponent(changedPath)}`);
      file.text = payload.text;
      file.savedText = payload.text;
      renderEditor();
    }
  }

  for (const directory of directoriesToRefresh) {
    if (appState.tree.has(directory)) {
      await loadDirectory(directory);
    }
  }
}

async function openFirstUsefulFile() {
  const candidate = await findFirstUsefulFile(appState.workspaceRoot);

  if (candidate) {
    await openFile(candidate.path);
  }
}

async function findFirstUsefulFile(directoryPath) {
  if (!appState.tree.has(directoryPath)) {
    await loadDirectory(directoryPath);
  }

  const entries = [...(appState.tree.get(directoryPath) || [])].sort(sortEntries);
  const directFile =
    entries.find((entry) => entry.isFile && entry.fileName.toLowerCase().startsWith("readme")) ||
    entries.find((entry) => entry.isFile);

  if (directFile) {
    return directFile;
  }

  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }
    const nested = await findFirstUsefulFile(entry.path);
    if (nested) {
      appState.treeExpanded.add(entry.path);
      return nested;
    }
  }

  return null;
}

function getActiveFile() {
  return appState.activePath ? appState.files.get(appState.activePath) : null;
}

function closeTab(filePath) {
  const index = appState.openTabs.indexOf(filePath);
  if (index === -1) {
    return;
  }
  appState.openTabs.splice(index, 1);
  if (appState.activePath === filePath) {
    appState.activePath = appState.openTabs[index - 1] || appState.openTabs[index] || null;
  }
  clearInlineSuggestion();
  renderTree();
  renderTabs();
  renderEditor();
}

function handleCursorActivity() {
  renderInlineSuggestion();
  scheduleInlineSuggestion();
}

function scheduleInlineSuggestion() {
  clearInlineSuggestion();
  if (appState.inlineTimer) {
    window.clearTimeout(appState.inlineTimer);
  }
  appState.inlineTimer = window.setTimeout(() => {
    void requestInlineSuggestion(false);
  }, 450);
}

function clearInlineSuggestion() {
  appState.inlineSuggestion = null;
  dom.editorPrediction.textContent = "";
}

function renderInlineSuggestion() {
  const file = getActiveFile();
  const suggestion = appState.inlineSuggestion;

  if (
    !file ||
    !suggestion ||
    suggestion.path !== file.path ||
    dom.editorInput.selectionStart !== dom.editorInput.selectionEnd ||
    !shouldShowInlineSuggestion(file.text, dom.editorInput.selectionStart)
  ) {
    dom.editorPrediction.textContent = "";
    return;
  }

  const cursor = dom.editorInput.selectionStart;
  const prefix = file.text.slice(0, cursor);
  dom.editorPrediction.innerHTML =
    `<span class="prediction-prefix">${escapeHtml(prefix)}</span>` +
    `<span class="prediction-text">${escapeHtml(suggestion.text)}</span>`;
  syncEditorScroll();
}

function shouldShowInlineSuggestion(text, cursor) {
  const lineEnd = text.indexOf("\n", cursor);
  const restOfLine = text.slice(cursor, lineEnd === -1 ? text.length : lineEnd);
  return restOfLine.trim() === "";
}

function normalizeInlineSuggestion({ cursor, fullText, suggestionText, suffix }) {
  let suggestion = String(suggestionText || "").replace(/\r/g, "");

  const fenced = suggestion.match(/^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/);
  if (fenced) {
    suggestion = fenced[1];
  }

  const trimmedJson = suggestion.trim();
  if (trimmedJson.startsWith("{") || trimmedJson.startsWith("\"")) {
    try {
      const parsed = JSON.parse(trimmedJson);
      if (typeof parsed === "string") {
        suggestion = parsed;
      } else if (typeof parsed?.insertText === "string") {
        suggestion = parsed.insertText;
      }
    } catch {}
  }

  suggestion = trimSharedSuffix(suggestion, suffix);
  suggestion = trimDuplicateCurrentLinePrefix(suggestion, fullText, cursor);
  return suggestion;
}

function acceptInlineSuggestion() {
  if (!appState.inlineSuggestion?.text) {
    return false;
  }
  if (dom.editorInput.selectionStart !== dom.editorInput.selectionEnd) {
    return false;
  }
  const text = appState.inlineSuggestion.text;
  clearInlineSuggestion();
  insertIntoEditor(text);
  return true;
}

async function createNewFile() {
  const suggestedPath = window.prompt("New file path", "src/new-file.ts");
  if (!suggestedPath) {
    return;
  }

  try {
    const payload = await requestJson("/api/fs/create-file", {
      body: JSON.stringify({ path: suggestedPath, text: "" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    await refreshTreeAfterCreate(payload.path);
    await openFile(payload.path);
  } catch (error) {
    showNotice(error.message || "Failed to create file.");
  }
}

async function createNewFolder() {
  const suggestedPath = window.prompt("New folder path", "src/new-folder");
  if (!suggestedPath) {
    return;
  }

  try {
    const payload = await requestJson("/api/fs/create-directory", {
      body: JSON.stringify({ path: suggestedPath }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    await refreshTreeAfterCreate(payload.path);
  } catch (error) {
    showNotice(error.message || "Failed to create folder.");
  }
}

async function refreshTreeAfterCreate(createdPath) {
  const directories = new Set([appState.workspaceRoot, parentPath(createdPath)]);
  for (const directory of directories) {
    await loadDirectory(directory);
    appState.treeExpanded.add(directory);
  }
}

async function resetWorkspaceUi(workspaceRoot) {
  appState.workspaceRoot = workspaceRoot;
  appState.contexts = [];
  appState.files.clear();
  appState.openTabs = [];
  appState.tree.clear();
  appState.treeExpanded.clear();
  appState.activePath = null;
  clearInlineSuggestion();
  renderContexts();
  renderTabs();
  renderEditor();
  await loadDirectory(workspaceRoot);
  await openFirstUsefulFile();
}

function renderLineNumbers(text) {
  return text
    .split("\n")
    .map((_, index) => `<span>${index + 1}</span>`)
    .join("");
}

function highlightCode(text, language) {
  let html = escapeHtml(text || " ");
  const placeholders = [];

  const stash = (regex, className) => {
    html = html.replace(regex, (match) => {
      const key = `§§${placeholders.length}§§`;
      placeholders.push(`<span class="${className}">${match}</span>`);
      return key;
    });
  };

  const rules = syntaxRules(language);
  if (rules.comments) {
    for (const pattern of rules.comments) {
      stash(pattern, "tok-comment");
    }
  }
  stash(rules.strings, "tok-string");
  stash(rules.numbers, "tok-number");
  stash(rules.keywords, "tok-keyword");

  html = html.replace(/§§(\d+)§§/g, (_, index) => placeholders[Number(index)]);
  return html;
}

function syntaxRules(language) {
  const jsKeywords =
    /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|import|export|from|async|await|class|new|extends|try|catch|throw|default)\b/g;
  const rustKeywords =
    /\b(fn|let|mut|pub|impl|struct|enum|match|if|else|for|while|loop|return|use|mod|trait|async|await|move)\b/g;
  const pyKeywords =
    /\b(def|return|if|elif|else|for|while|import|from|class|with|as|try|except|raise|async|await|lambda)\b/g;
  const common = {
    numbers: /\b\d+(?:\.\d+)?\b/g,
    strings: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g,
  };

  switch (language) {
    case "javascript":
    case "typescript":
    case "tsx":
    case "jsx":
      return {
        ...common,
        comments: [/\/\*[\s\S]*?\*\//g, /\/\/.*/g],
        keywords: jsKeywords,
      };
    case "rust":
      return {
        ...common,
        comments: [/\/\*[\s\S]*?\*\//g, /\/\/.*/g],
        keywords: rustKeywords,
      };
    case "python":
    case "shell":
      return {
        ...common,
        comments: [/#.*/g],
        keywords: pyKeywords,
      };
    case "json":
      return {
        ...common,
        comments: [],
        keywords: /\b(true|false|null)\b/g,
      };
    case "markdown":
      return {
        ...common,
        comments: [],
        keywords: /(^#+.*$|\*\*[^*]+\*\*)/gm,
      };
    default:
      return {
        ...common,
        comments: [],
        keywords: /\b(TODO|FIXME|NOTE)\b/g,
      };
  }
}

function detectLanguage(filePath) {
  const extension = filePath.split(".").pop()?.toLowerCase();
  const map = {
    cjs: "javascript",
    css: "css",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    py: "python",
    rs: "rust",
    sh: "shell",
    ts: "typescript",
    tsx: "tsx",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[extension] || "plain";
}

function prettifyLanguage(language) {
  return language.charAt(0).toUpperCase() + language.slice(1);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function basename(filePath) {
  return filePath.split("/").pop();
}

function parentPath(filePath) {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

function pathJoin(base, relative) {
  return `${base.replace(/\/$/, "")}/${relative.replace(/^\//, "")}`;
}

function relativePath(filePath) {
  if (!filePath || !appState.workspaceRoot) {
    return filePath || "";
  }
  return filePath.startsWith(`${appState.workspaceRoot}/`)
    ? filePath.slice(appState.workspaceRoot.length + 1)
    : filePath;
}

function trimSharedSuffix(text, suffix) {
  if (!text || !suffix) {
    return text;
  }

  const maxOverlap = Math.min(text.length, suffix.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (text.endsWith(suffix.slice(0, size))) {
      return text.slice(0, -size);
    }
  }

  return text;
}

function trimDuplicateCurrentLinePrefix(text, fullText, cursor) {
  if (!text) {
    return text;
  }

  const lineStart = fullText.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const currentLinePrefix = fullText.slice(lineStart, cursor);
  if (!currentLinePrefix) {
    return text;
  }

  for (let size = Math.min(currentLinePrefix.length, text.length); size > 0; size -= 1) {
    if (text.startsWith(currentLinePrefix.slice(-size))) {
      return text.slice(size);
    }
  }

  return text;
}

function sortEntries(left, right) {
  if (left.isDirectory !== right.isDirectory) {
    return left.isDirectory ? -1 : 1;
  }
  return left.fileName.localeCompare(right.fileName);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function showNotice(message, tone = "error", autoHide = true) {
  dom.appNotice.textContent = message;
  dom.appNotice.classList.remove("hidden", "success");
  if (tone === "success") {
    dom.appNotice.classList.add("success");
  }
  if (showNotice.timer) {
    window.clearTimeout(showNotice.timer);
  }
  if (autoHide) {
    showNotice.timer = window.setTimeout(() => {
      clearNotice();
    }, 5000);
  }
}

function clearNotice() {
  dom.appNotice.classList.add("hidden");
}
