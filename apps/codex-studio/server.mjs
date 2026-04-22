import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const studioDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(studioDir, "public");
const initialWorkspaceRoot = path.resolve(
  process.env.CODEX_STUDIO_WORKSPACE || process.argv[2] || process.cwd(),
);
const requestedAppPort = Number.parseInt(
  process.env.CODEX_STUDIO_PORT || "3456",
  10,
);
const codexBin = process.env.CODEX_BIN || "codex";
const shell = process.env.SHELL || "zsh";

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const state = {
  appServerPort: null,
  connected: false,
  currentCommandId: null,
  currentTurnId: null,
  lastError: null,
  studioPort: null,
  studioThreadId: null,
  workspaceRoot: initialWorkspaceRoot,
};

class EventHub {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        client.write(": ping\n\n");
      }
    }, 15000);
  }

  add(res) {
    this.clients.add(res);
    res.write("retry: 1000\n\n");
    this.sendTo(res, "state", state);
  }

  remove(res) {
    this.clients.delete(res);
  }

  send(event, payload) {
    for (const client of this.clients) {
      this.sendTo(client, event, payload);
    }
  }

  sendTo(res, event, payload) {
    const data = JSON.stringify(payload);
    res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  }
}

class AppServerBridge {
  constructor() {
    this.child = null;
    this.completionCache = new Map();
    this.inflightCompletions = new Map();
    this.nextId = 1;
    this.pending = new Map();
    this.turnStreams = new Map();
    this.commandSessions = new Map();
    this.socket = null;
  }

  async start() {
    state.lastError = null;
    state.connected = false;
    state.studioThreadId = null;
    state.currentCommandId = null;
    state.currentTurnId = null;
    state.appServerPort = await getAvailablePort();
    this.spawnChild();
    await this.connectWithRetry();
    await this.initialize();
    await this.request("fs/watch", {
      path: state.workspaceRoot,
      watchId: "workspace-root",
    });
    state.connected = true;
    events.send("state", state);
  }

  spawnChild() {
    const args = [
      "app-server",
      "--listen",
      `ws://127.0.0.1:${state.appServerPort}`,
    ];

    this.child = spawn(codexBin, args, {
      cwd: state.workspaceRoot,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => {
      events.send("serverLog", {
        stream: "stdout",
        text: chunk.toString("utf8"),
      });
    });

    this.child.stderr.on("data", (chunk) => {
      events.send("serverLog", {
        stream: "stderr",
        text: chunk.toString("utf8"),
      });
    });

    this.child.on("error", (error) => {
      state.lastError = `Failed to start ${codexBin}: ${error.message}`;
      state.connected = false;
      events.send("state", state);
    });

    this.child.on("exit", (code, signal) => {
      state.connected = false;
      state.lastError = `Codex app-server exited (${signal || code || 0}).`;
      events.send("state", state);
    });
  }

  async connectWithRetry(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = new Error("Codex app-server did not accept a websocket connection.");

    while (Date.now() < deadline) {
      try {
        this.socket = await openWebSocket(
          `ws://127.0.0.1:${state.appServerPort}`,
        );
        this.socket.addEventListener("message", (event) => {
          this.handlePayload(event.data.toString());
        });
        this.socket.addEventListener("close", () => {
          state.connected = false;
          events.send("state", state);
        });
        return;
      } catch (error) {
        lastError = error;
        await sleep(250);
      }
    }

    throw lastError;
  }

  async initialize() {
    await this.request("initialize", {
      capabilities: null,
      clientInfo: {
        name: "codex-studio",
        version: "0.1.0",
      },
    });
    this.notify("initialized");
  }

  request(method, params) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex app-server websocket is not connected."));
    }

    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.socket.send(JSON.stringify(payload));
    });
  }

  notify(method, params) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const payload = params === undefined ? { method } : { method, params };
    this.socket.send(JSON.stringify(payload));
  }

  async ensureStudioThread() {
    if (state.studioThreadId) {
      return state.studioThreadId;
    }

    const result = await this.request("thread/start", {
      approvalPolicy: "never",
      cwd: state.workspaceRoot,
      sandbox: "workspace-write",
    });

    state.studioThreadId = result.thread.id;
    events.send("state", state);
    return state.studioThreadId;
  }

  async readDirectory(targetPath) {
    const result = await this.request("fs/readDirectory", { path: targetPath });
    return result.entries.map((entry) => ({
      ...entry,
      path: path.join(targetPath, entry.fileName),
    }));
  }

  async readFile(targetPath) {
    const result = await this.request("fs/readFile", { path: targetPath });
    return Buffer.from(result.dataBase64, "base64").toString("utf8");
  }

  async writeFile(targetPath, text) {
    await this.request("fs/writeFile", {
      dataBase64: Buffer.from(text, "utf8").toString("base64"),
      path: targetPath,
    });
  }

  async fuzzySearch(query) {
    if (!query.trim()) {
      return [];
    }
    const result = await this.request("fuzzyFileSearch", {
      cancellationToken: null,
      query,
      roots: [state.workspaceRoot],
    });
    return result.files;
  }

  async startCommand(command) {
    const processId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    state.currentCommandId = processId;
    events.send("state", state);
    events.send("commandStarted", { command, processId });

    this.commandSessions.set(processId, {
      command,
      output: "",
    });

    void this.request("command/exec", {
      command: [shell, "-lc", command],
      cwd: state.workspaceRoot,
      disableTimeout: true,
      processId,
      streamStdoutStderr: true,
      tty: false,
    })
      .then((result) => {
        events.send("commandExit", {
          command,
          exitCode: result.exitCode,
          processId,
          stderr: result.stderr,
          stdout: result.stdout,
        });
        if (state.currentCommandId === processId) {
          state.currentCommandId = null;
          events.send("state", state);
        }
      })
      .catch((error) => {
        events.send("commandExit", {
          command,
          error: error.message,
          exitCode: -1,
          processId,
          stderr: "",
          stdout: "",
        });
        if (state.currentCommandId === processId) {
          state.currentCommandId = null;
          events.send("state", state);
        }
      });

    return { processId };
  }

  async stopCommand(processId) {
    await this.request("command/exec/terminate", { processId });
  }

  async sendChat(message, contexts) {
    const threadId = await this.ensureStudioThread();
    const prompt = buildChatPrompt(message, contexts);
    const result = await this.request("turn/start", {
      approvalPolicy: "never",
      input: [
        {
          text: prompt,
          text_elements: [],
          type: "text",
        },
      ],
      threadId,
    });

    const turnId = result.turn.id;
    state.currentTurnId = turnId;
    this.turnStreams.set(turnId, {
      finalText: "",
      threadId,
      type: "chat",
    });
    events.send("codexTurnStarted", {
      contexts,
      message,
      threadId,
      turnId,
    });
    events.send("state", state);
    return { threadId, turnId };
  }

  async requestCompletion(payload) {
    const normalizedPayload = normalizeCompletionPayload(payload);
    const cacheKey = createCompletionCacheKey(normalizedPayload);
    const cached = this.completionCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      if (normalizedPayload.onDelta && cached.text) {
        normalizedPayload.onDelta(cached.text, cached.text);
      }
      return cached.text;
    }

    const inflight = this.inflightCompletions.get(cacheKey);
    if (inflight) {
      const text = await inflight;
      if (normalizedPayload.onDelta && text) {
        normalizedPayload.onDelta(text, text);
      }
      return text;
    }

    const request = this.runEphemeralTurn(
      buildCompletionPrompt({
        explicit: normalizedPayload.explicit,
        language: normalizedPayload.language,
        path: normalizedPayload.path,
        prefix: normalizedPayload.prefix,
        suffix: normalizedPayload.suffix,
      }),
      {
        onDelta: normalizedPayload.onDelta,
        transform: (text) => extractCompletionText(text, normalizedPayload.suffix),
        type: "completion",
      },
    )
      .then((text) => {
        this.completionCache.set(cacheKey, {
          expiresAt: Date.now() + 20_000,
          text,
        });
        pruneExpiringMap(this.completionCache, 80);
        return text;
      })
      .finally(() => {
        this.inflightCompletions.delete(cacheKey);
      });

    this.inflightCompletions.set(cacheKey, request);
    return request;
  }

  async requestChatCompletion(payload) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return this.runEphemeralTurn(buildOpenAiChatPrompt(messages), {
      onDelta: payload.onDelta,
      type: "chatCompletion",
    });
  }

  async runEphemeralTurn(prompt, streamOptions = {}) {
    const thread = await this.request("thread/start", {
      approvalPolicy: "never",
      cwd: state.workspaceRoot,
      ephemeral: true,
      sandbox: "read-only",
    });

    const turn = await this.request("turn/start", {
      input: [
        {
          text: prompt,
          text_elements: [],
          type: "text",
        },
      ],
      threadId: thread.thread.id,
    });

    const turnId = turn.turn.id;
    return new Promise((resolve, reject) => {
      this.turnStreams.set(turnId, {
        finalText: "",
        onDelta: streamOptions.onDelta,
        reject,
        resolve,
        threadId: thread.thread.id,
        transform: streamOptions.transform,
        type: streamOptions.type || "ephemeral",
      });
    });
  }

  async stopChatTurn() {
    if (!state.studioThreadId || !state.currentTurnId) {
      return { interrupted: false };
    }

    await this.request("turn/interrupt", {
      threadId: state.studioThreadId,
      turnId: state.currentTurnId,
    });
    return { interrupted: true };
  }

  async createDirectory(targetPath) {
    await this.request("fs/createDirectory", {
      path: targetPath,
      recursive: true,
    });
  }

  async switchWorkspace(targetPath) {
    if (targetPath === state.workspaceRoot) {
      return { workspaceRoot: state.workspaceRoot };
    }

    if (state.connected) {
      try {
        await this.request("fs/unwatch", { watchId: "workspace-root" });
      } catch {}
    }

    state.workspaceRoot = targetPath;
    state.studioThreadId = null;
    state.currentTurnId = null;
    state.currentCommandId = null;

    if (state.connected) {
      await this.request("fs/watch", {
        path: state.workspaceRoot,
        watchId: "workspace-root",
      });
    }

    events.send("state", state);
    return { workspaceRoot: state.workspaceRoot };
  }

  handlePayload(rawMessage) {
    const payload = JSON.parse(rawMessage);

    if (payload.id !== undefined && payload.method === undefined) {
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message || "App-server request failed."));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }

    if (payload.method && payload.id !== undefined) {
      this.socket.send(
        JSON.stringify({
          error: {
            code: -32601,
            message: "codex-studio does not implement interactive app-server callbacks",
          },
          id: payload.id,
        }),
      );
      return;
    }

    if (!payload.method) {
      return;
    }

    const { method, params } = payload;

    if (method === "command/exec/outputDelta") {
      const text = Buffer.from(params.deltaBase64, "base64").toString("utf8");
      events.send("commandOutput", {
        processId: params.processId,
        stream: params.stream,
        text,
      });
      return;
    }

    if (method === "fs/changed") {
      events.send("fsChanged", params);
      return;
    }

    if (method === "agentMessage/delta" || method === "item/agentMessage/delta") {
      const stream = this.turnStreams.get(params.turnId);
      if (stream) {
        stream.finalText += params.delta;
        stream.onDelta?.(params.delta, stream.finalText);
      }
      events.send("codexDelta", params);
      return;
    }

    if (method === "item/completed") {
      const stream = this.turnStreams.get(params.turnId);
      if (stream && params.item.type === "agentMessage") {
        stream.finalText = params.item.text;
      }
      events.send("codexItem", params);
      return;
    }

    if (method === "turn/completed") {
      const stream = this.turnStreams.get(params.turn.id);
      if (stream) {
        try {
          const value = stream.transform
            ? stream.transform(stream.finalText)
            : stream.finalText;
          stream.resolve(value);
        } catch (error) {
          stream.reject(error);
        }
        this.turnStreams.delete(params.turn.id);
      }
      if (state.currentTurnId === params.turn.id) {
        state.currentTurnId = null;
        events.send("state", state);
      }
      events.send("codexTurnCompleted", params);
      return;
    }

    if (method === "thread/started" || method === "turn/started") {
      events.send(method.replace("/", ""), params);
      return;
    }

    events.send("serverNotification", { method, params });
  }
}

const events = new EventHub();
const bridge = new AppServerBridge();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

    if (req.method === "OPTIONS") {
      return writeEmpty(res, 204);
    }

    if (url.pathname === "/favicon.ico") {
      return writeEmpty(res, 204);
    }

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "Cache-Control": "no-cache, no-store, must-revalidate, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        Pragma: "no-cache",
        "X-Accel-Buffering": "no",
      });
      events.add(res);
      req.on("close", () => events.remove(res));
      return;
    }

    if (url.pathname === "/api/health") {
      return json(res, 200, {
        appServerPort: state.appServerPort,
        continueApiBase: state.studioPort
          ? `http://127.0.0.1:${state.studioPort}/v1`
          : null,
        connected: state.connected,
        ok: true,
        studioPort: state.studioPort,
        workspaceRoot: state.workspaceRoot,
      });
    }

    if (url.pathname === "/api/state") {
      return json(res, 200, state);
    }

    if (url.pathname === "/api/tree") {
      const requestedPath = ensureWorkspacePath(
        url.searchParams.get("path") || state.workspaceRoot,
      );
      const entries = await bridge.readDirectory(requestedPath);
      return json(res, 200, { entries, path: requestedPath });
    }

    if (url.pathname === "/api/file" && req.method === "GET") {
      const requestedPath = ensureWorkspacePath(url.searchParams.get("path"));
      const text = await bridge.readFile(requestedPath);
      return json(res, 200, { path: requestedPath, text });
    }

    if (url.pathname === "/api/file" && req.method === "POST") {
      const body = await readJsonBody(req);
      const requestedPath = ensureWorkspacePath(body.path);
      await bridge.writeFile(requestedPath, String(body.text ?? ""));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("query") || "";
      const files = await bridge.fuzzySearch(query);
      return json(res, 200, { files });
    }

    if (url.pathname === "/api/workspace/open" && req.method === "POST") {
      const body = await readJsonBody(req);
      const requestedPath = resolveWorkspaceRoot(body.path);
      const metadata = await stat(requestedPath);
      if (!metadata.isDirectory()) {
        const error = new Error("Requested workspace is not a directory.");
        error.statusCode = 400;
        throw error;
      }
      const result = await bridge.switchWorkspace(requestedPath);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/codex/send" && req.method === "POST") {
      const body = await readJsonBody(req);
      const result = await bridge.sendChat(String(body.message || ""), body.contexts || []);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/codex/stop" && req.method === "POST") {
      const result = await bridge.stopChatTurn();
      return json(res, 200, result);
    }

    if (url.pathname === "/api/codex/completion" && req.method === "POST") {
      const body = await readJsonBody(req);
      const insertText = await bridge.requestCompletion(body);
      return json(res, 200, { insertText });
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      return json(res, 200, {
        data: [
          {
            created: 0,
            id: "codex-studio-chat",
            object: "model",
            owned_by: "codex-studio",
          },
          {
            created: 0,
            id: "codex-studio-autocomplete",
            object: "model",
            owned_by: "codex-studio",
          },
        ],
        object: "list",
      });
    }

    if (
      (url.pathname === "/v1/completions" || url.pathname === "/v1/fim/completions") &&
      req.method === "POST"
    ) {
      const body = await readJsonBody(req);
      const parsedPrompt = parseFimPrompt(normalizePromptText(body.prompt ?? body.input ?? ""));
      const prompt = parsedPrompt.prefix;
      const suffix = parsedPrompt.suffix || String(body.suffix || body.input_suffix || "");
      const completionId = `cmpl-${Date.now()}`;
      const completionRequest = {
        explicit: true,
        language: body.language || inferLanguageFromPath(body.path) || "plain text",
        onDelta: null,
        path: body.path || body.filename || "continue-inline",
        prefix: prompt,
        suffix,
      };

      if (body.stream) {
        return streamLegacyCompletion(res, {
          completionId,
          model: String(body.model || "codex-studio-autocomplete"),
          onStart: (onDelta) =>
            bridge.requestCompletion({
              ...completionRequest,
              onDelta,
            }),
        });
      }

      const text = await bridge.requestCompletion(completionRequest);
      return json(res, 200, createLegacyCompletionResponse({
        completionId,
        model: String(body.model || "codex-studio-autocomplete"),
        text,
      }));
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = await readJsonBody(req);
      const chatId = `chatcmpl-${Date.now()}`;
      const model = String(body.model || "codex-studio-chat");

      if (body.stream) {
        return streamChatCompletion(res, {
          chatId,
          messages: Array.isArray(body.messages) ? body.messages : [],
          model,
        });
      }

      const text = await bridge.requestChatCompletion({
        messages: Array.isArray(body.messages) ? body.messages : [],
      });
      return json(res, 200, createChatCompletionResponse({ chatId, model, text }));
    }

    if (url.pathname === "/api/command/start" && req.method === "POST") {
      const body = await readJsonBody(req);
      const result = await bridge.startCommand(String(body.command || ""));
      return json(res, 200, result);
    }

    if (url.pathname === "/api/command/stop" && req.method === "POST") {
      const body = await readJsonBody(req);
      await bridge.stopCommand(String(body.processId || ""));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/fs/create-file" && req.method === "POST") {
      const body = await readJsonBody(req);
      const requestedPath = resolveWorkspaceEntryPath(body.path);
      await bridge.createDirectory(path.dirname(requestedPath));
      await bridge.writeFile(requestedPath, String(body.text ?? ""));
      return json(res, 200, { path: requestedPath });
    }

    if (url.pathname === "/api/fs/create-directory" && req.method === "POST") {
      const body = await readJsonBody(req);
      const requestedPath = resolveWorkspaceEntryPath(body.path);
      await bridge.createDirectory(requestedPath);
      return json(res, 200, { path: requestedPath });
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    return json(res, statusCode, {
      error: error.message || "Unexpected server error",
    });
  }
});

setupClientReloadWatcher();

bridge
  .start()
  .catch((error) => {
    state.lastError = error.message;
    events.send("state", state);
  })
  .finally(() => {
    void startHttpServer();
  });

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  if (bridge.child && !bridge.child.killed) {
    bridge.child.kill("SIGTERM");
  }
  server.close(() => process.exit(0));
}

async function startHttpServer() {
  const preferredPort = Number.isNaN(requestedAppPort) ? 3456 : requestedAppPort;

  try {
    const actualPort = await listenOnPort(preferredPort);
    state.studioPort = actualPort;
    events.send("state", state);
    console.log(`Codex Studio running at http://127.0.0.1:${actualPort}`);
  } catch (error) {
    state.lastError = `Failed to start studio HTTP server: ${error.message}`;
    events.send("state", state);
    console.error(state.lastError);
    process.exitCode = 1;
  }
}

function buildChatPrompt(message, contexts) {
  const sections = [];
  if (Array.isArray(contexts) && contexts.length > 0) {
    sections.push("Attached editor context:");
    for (const context of contexts) {
      sections.push(`Path: ${context.path}`);
      sections.push(`Language: ${context.language || "plain text"}`);
      sections.push("```");
      sections.push(context.selectedText || "");
      sections.push("```");
    }
  }
  sections.push("User request:");
  sections.push(message);
  return sections.join("\n");
}

function ensureWorkspacePath(targetPath) {
  if (!targetPath) {
    const error = new Error("A path query parameter is required.");
    error.statusCode = 400;
    throw error;
  }

  const resolvedPath = path.resolve(targetPath);
  const relativePath = path.relative(state.workspaceRoot, resolvedPath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    const error = new Error("Requested path is outside the opened workspace.");
    error.statusCode = 403;
    throw error;
  }

  return resolvedPath;
}

function resolveWorkspaceEntryPath(targetPath) {
  if (!targetPath) {
    const error = new Error("A path is required.");
    error.statusCode = 400;
    throw error;
  }

  const rawPath = String(targetPath).trim();
  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(state.workspaceRoot, rawPath);
  return ensureWorkspacePath(resolvedPath);
}

function resolveWorkspaceRoot(targetPath) {
  if (!targetPath) {
    const error = new Error("A workspace path is required.");
    error.statusCode = 400;
    throw error;
  }

  return path.resolve(String(targetPath).trim());
}

async function serveStatic(urlPath, res) {
  const cleanPath =
    urlPath === "/" ? "/index.html" : urlPath.replaceAll("..", "");
  const filePath = path.join(publicDir, cleanPath);
  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const notFound = new Error("Not found");
      notFound.statusCode = 404;
      throw notFound;
    }
    throw error;
  }

  if (!fileStats.isFile()) {
    const error = new Error("Not found");
    error.statusCode = 404;
    throw error;
  }

  const body = await readFile(filePath);
  const type = mimeTypes.get(path.extname(filePath)) || "text/plain; charset=utf-8";
  res.writeHead(200, withStandardHeaders({
    "Content-Type": type,
  }));
  res.end(body);
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, withStandardHeaders({
    "Content-Type": "application/json; charset=utf-8",
  }));
  res.end(JSON.stringify(payload));
}

function writeEmpty(res, statusCode) {
  res.writeHead(statusCode, withStandardHeaders());
  res.end();
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

function setupClientReloadWatcher() {
  const watchTargets = [
    path.join(publicDir, "index.html"),
    path.join(publicDir, "main.js"),
    path.join(publicDir, "styles.css"),
  ];

  for (const target of watchTargets) {
    fs.watch(target, { persistent: false }, () => {
      events.send("devReload", { changed: path.basename(target) });
    });
  }
}

function withStandardHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    ...extra,
  };
}

function buildCompletionPrompt({ explicit, language, path: filePath, prefix, suffix }) {
  return [
    "You are a coding autocomplete engine.",
    "Return only the exact code to insert at the cursor.",
    "Do not return JSON.",
    "Do not explain anything.",
    "Do not wrap the answer in markdown fences.",
    "Match the local style and indentation.",
    explicit
      ? "The user explicitly requested a completion, so prefer a useful short continuation."
      : "Only respond when a likely next insertion is obvious; otherwise return an empty response.",
    `FILE: ${filePath || "untitled"}`,
    `LANGUAGE: ${language || "plain text"}`,
    "<PREFIX>",
    prefix,
    "</PREFIX>",
    "<SUFFIX>",
    suffix,
    "</SUFFIX>",
    "INSERTION:",
  ].join("\n");
}

function buildOpenAiChatPrompt(messages) {
  const sections = [
    "You are Codex Studio's chat assistant.",
    "Answer the final user request clearly and directly.",
    "Use the earlier messages as conversation history.",
    `WORKSPACE: ${state.workspaceRoot}`,
  ];

  for (const message of messages) {
    const role = String(message?.role || "user").toUpperCase();
    const content = extractMessageText(message);
    if (!content) {
      continue;
    }
    sections.push(`${role}:`);
    sections.push(content);
  }

  return sections.join("\n\n");
}

function normalizeCompletionPayload(payload) {
  const content = String(payload.content || "");
  const cursorStart = Number.isInteger(payload.cursorStart)
    ? payload.cursorStart
    : content.length;
  const cursorEnd = Number.isInteger(payload.cursorEnd)
    ? payload.cursorEnd
    : cursorStart;

  return {
    explicit: Boolean(payload.explicit),
    language: payload.language || inferLanguageFromPath(payload.path) || "plain text",
    onDelta: payload.onDelta,
    path: payload.path || "untitled",
    prefix: payload.prefix ?? content.slice(
      Math.max(0, cursorStart - 3500),
      cursorStart,
    ),
    suffix: payload.suffix ?? content.slice(
      cursorEnd,
      Math.min(content.length, cursorEnd + 3500),
    ),
  };
}

function createCompletionCacheKey(payload) {
  return JSON.stringify({
    explicit: payload.explicit,
    language: payload.language,
    path: payload.path,
    prefix: payload.prefix,
    suffix: payload.suffix,
  });
}

function pruneExpiringMap(map, maxEntries) {
  if (map.size <= maxEntries) {
    return;
  }

  const entries = [...map.entries()].sort((left, right) => {
    return (left[1]?.expiresAt || 0) - (right[1]?.expiresAt || 0);
  });

  while (entries.length > maxEntries) {
    const [oldestKey] = entries.shift();
    map.delete(oldestKey);
  }
}

function normalizePromptText(prompt) {
  if (Array.isArray(prompt)) {
    return prompt.map((part) => String(part ?? "")).join("");
  }
  return String(prompt || "");
}

function parseFimPrompt(prompt) {
  const text = String(prompt || "");
  if (!text) {
    return { prefix: "", suffix: "" };
  }

  const formats = [
    {
      order: "prefix-suffix-middle",
      middle: "<|fim_middle|>",
      prefix: "<|fim_prefix|>",
      suffix: "<|fim_suffix|>",
    },
    {
      order: "prefix-middle-suffix",
      middle: "<｜fim▁hole｜>",
      prefix: "<｜fim▁begin｜>",
      suffix: "<｜fim▁end｜>",
    },
    {
      order: "prefix-suffix-middle",
      middle: "<fim_middle>",
      prefix: "<fim_prefix>",
      suffix: "<fim_suffix>",
    },
    {
      middle: "<FILL_HERE>",
      prefix: "",
      suffix: "",
    },
  ];

  for (const format of formats) {
    if (format.middle === "<FILL_HERE>" && text.includes(format.middle)) {
      const [prefix, ...rest] = text.split(format.middle);
      return {
        prefix,
        suffix: rest.join(format.middle),
      };
    }

    if (
      format.prefix &&
      format.suffix &&
      format.middle &&
      text.includes(format.prefix) &&
      text.includes(format.suffix) &&
      text.includes(format.middle)
    ) {
      const prefixStart = text.indexOf(format.prefix) + format.prefix.length;
      if (format.order === "prefix-suffix-middle") {
        const suffixStart = text.indexOf(format.suffix, prefixStart);
        const middleStart = text.indexOf(format.middle, suffixStart + format.suffix.length);
        if (suffixStart === -1 || middleStart === -1) {
          continue;
        }
        return {
          prefix: text.slice(prefixStart, suffixStart),
          suffix: text.slice(suffixStart + format.suffix.length, middleStart),
        };
      }

      if (format.order === "prefix-middle-suffix") {
        const middleStart = text.indexOf(format.middle, prefixStart);
        const suffixStart = text.indexOf(format.suffix, middleStart + format.middle.length);
        if (middleStart === -1 || suffixStart === -1) {
          continue;
        }
        return {
          prefix: text.slice(prefixStart, middleStart),
          suffix: text.slice(middleStart + format.middle.length, suffixStart),
        };
      }
    }
  }

  return { prefix: text, suffix: "" };
}

function extractMessageText(message) {
  if (!message) {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part?.type === "text") {
          return part.text || "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function extractCompletionText(rawText, suffix = "") {
  let text = String(rawText || "").replace(/\r/g, "");
  if (!text.trim()) {
    return "";
  }

  const parsed = tryParseCompletionPayload(text.trim());
  if (parsed !== null) {
    text = parsed;
  }

  text = stripMarkdownFence(text);
  text = trimSuffixOverlap(text, suffix);
  return text;
}

function tryParseCompletionPayload(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (typeof parsed?.insertText === "string") {
      return parsed.insertText;
    }
    if (typeof parsed?.completion === "string") {
      return parsed.completion;
    }
    if (typeof parsed?.text === "string") {
      return parsed.text;
    }
    if (Array.isArray(parsed?.choices) && parsed.choices.length > 0) {
      const [choice] = parsed.choices;
      if (typeof choice?.text === "string") {
        return choice.text;
      }
      if (typeof choice?.message?.content === "string") {
        return choice.message.content;
      }
    }
  } catch {}

  return null;
}

function stripMarkdownFence(text) {
  const fenced = text.match(/^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1] : text;
}

function inferLanguageFromPath(filePath) {
  const extension = String(filePath || "").split(".").pop()?.toLowerCase();
  const map = {
    cjs: "javascript",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sh: "shell",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    txt: "plain text",
    xml: "xml",
    yml: "yaml",
    yaml: "yaml",
  };
  return map[extension] || null;
}

function trimSuffixOverlap(text, suffix) {
  if (!text || !suffix) {
    return text;
  }

  const overlapLimit = Math.min(text.length, suffix.length);
  for (let size = overlapLimit; size > 0; size -= 1) {
    if (text.endsWith(suffix.slice(0, size))) {
      return text.slice(0, -size);
    }
  }

  return text;
}

function createLegacyCompletionResponse({ completionId, model, text }) {
  return {
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        logprobs: null,
        text,
      },
    ],
    created: Math.floor(Date.now() / 1000),
    id: completionId,
    model,
    object: "text_completion",
  };
}

function createChatCompletionResponse({ chatId, model, text }) {
  return {
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: {
          content: text,
          role: "assistant",
        },
      },
    ],
    created: Math.floor(Date.now() / 1000),
    id: chatId,
    model,
    object: "chat.completion",
  };
}

function writeSseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseDone(res) {
  res.write("data: [DONE]\n\n");
  res.end();
}

async function streamLegacyCompletion(res, { completionId, model, onStart }) {
  res.writeHead(200, withStandardHeaders({
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }));

  try {
    let lastText = "";
    const text = await onStart((_, aggregate) => {
      const delta = aggregate.slice(lastText.length);
      lastText = aggregate;
      if (!delta) {
        return;
      }
      writeSseChunk(res, {
        choices: [
          {
            finish_reason: null,
            index: 0,
            logprobs: null,
            text: delta,
          },
        ],
        created: Math.floor(Date.now() / 1000),
        id: completionId,
        model,
        object: "text_completion",
      });
    });

    if (text && text !== lastText) {
      writeSseChunk(res, {
        choices: [
          {
            finish_reason: null,
            index: 0,
            logprobs: null,
            text: text.slice(lastText.length),
          },
        ],
        created: Math.floor(Date.now() / 1000),
        id: completionId,
        model,
        object: "text_completion",
      });
    }
    writeSseChunk(res, {
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          logprobs: null,
          text: "",
        },
      ],
      created: Math.floor(Date.now() / 1000),
      id: completionId,
      model,
      object: "text_completion",
    });
    writeSseDone(res);
  } catch (error) {
    writeSseChunk(res, { error: { message: error.message || "Completion failed." } });
    writeSseDone(res);
  }
}

async function streamChatCompletion(res, { chatId, messages, model }) {
  res.writeHead(200, withStandardHeaders({
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  }));

  writeSseChunk(res, {
    choices: [
      {
        delta: { role: "assistant" },
        finish_reason: null,
        index: 0,
      },
    ],
    created: Math.floor(Date.now() / 1000),
    id: chatId,
    model,
    object: "chat.completion.chunk",
  });

  try {
    await bridge.requestChatCompletion({
      messages,
      onDelta: (delta) => {
        if (!delta) {
          return;
        }
        writeSseChunk(res, {
          choices: [
            {
              delta: { content: delta },
              finish_reason: null,
              index: 0,
            },
          ],
          created: Math.floor(Date.now() / 1000),
          id: chatId,
          model,
          object: "chat.completion.chunk",
        });
      },
    });

    writeSseChunk(res, {
      choices: [
        {
          delta: {},
          finish_reason: "stop",
          index: 0,
        },
      ],
      created: Math.floor(Date.now() / 1000),
      id: chatId,
      model,
      object: "chat.completion.chunk",
    });
    writeSseDone(res);
  } catch (error) {
    writeSseChunk(res, { error: { message: error.message || "Chat completion failed." } });
    writeSseDone(res);
  }
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const candidate = createServer();
    candidate.listen(0, "127.0.0.1", () => {
      const address = candidate.address();
      candidate.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    candidate.on("error", reject);
  });
}

function listenOnPort(preferredPort) {
  return new Promise((resolve, reject) => {
    const handleListening = () => {
      const address = server.address();
      cleanup();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine studio listen address."));
        return;
      }
      resolve(address.port);
    };

    const handleError = async (error) => {
      cleanup();
      if (error.code !== "EADDRINUSE") {
        reject(error);
        return;
      }

      try {
        const fallbackPort = await getAvailablePort();
        const actualPort = await listenOnPort(fallbackPort);
        console.warn(
          `Port ${preferredPort} is busy; using http://127.0.0.1:${actualPort} instead.`,
        );
        resolve(actualPort);
      } catch (fallbackError) {
        reject(fallbackError);
      }
    };

    const cleanup = () => {
      server.off("error", handleError);
      server.off("listening", handleListening);
    };

    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(preferredPort, "127.0.0.1");
  });
}

process.on("uncaughtException", (error) => {
  state.lastError = `Studio server crashed: ${error.message}`;
  events.send("state", state);
  console.error(error);
});

process.on("unhandledRejection", (error) => {
  const message = error?.message || String(error);
  state.lastError = `Studio server rejected a promise: ${message}`;
  events.send("state", state);
  console.error(error);
});

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`Failed to connect to ${url}`)),
      { once: true },
    );
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
