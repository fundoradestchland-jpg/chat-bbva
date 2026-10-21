const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { promisify } = require("node:util");
require("dotenv").config();
const { createPostgresStore } = require("./database");

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;
const MAX_BODY_LENGTH = 16 * 1024;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_ATTACHMENT_BYTES + 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_TYPES = {
  ".jpg": { mimeType: "image/jpeg", signature: (file) => file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff },
  ".jpeg": { mimeType: "image/jpeg", signature: (file) => file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff },
  ".png": { mimeType: "image/png", signature: (file) => file.length >= 24 && file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  ".gif": { mimeType: "image/gif", signature: (file) => file.subarray(0, 6).toString("ascii") === "GIF87a" || file.subarray(0, 6).toString("ascii") === "GIF89a" },
  ".webp": { mimeType: "image/webp", signature: (file) => file.length >= 12 && file.toString("ascii", 0, 4) === "RIFF" && file.toString("ascii", 8, 12) === "WEBP" },
  ".pdf": { mimeType: "application/pdf", signature: (file) => file.subarray(0, 5).toString("ascii") === "%PDF-" },
  ".txt": {
    mimeType: "text/plain",
    signature: (file) => {
      if (file.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(file);
        return true;
      } catch {
        return false;
      }
    }
  },
  ".doc": { mimeType: "application/msword", signature: (file) => file.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) },
  ".docx": { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", signature: (file) => file.length >= 4 && file[0] === 0x50 && file[1] === 0x4b && file[2] === 0x03 && file[3] === 0x04 }
};
const PUBLIC_DIR = path.join(__dirname, "public");

function normalizeName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function nameKey(value) {
  return normalizeName(value).toLocaleLowerCase("fr");
}

function parseMultipart(buffer, contentType) {
  const match = contentType.match(/^\s*multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = match && (match[1] || match[2]);
  if (!boundary || boundary.length > 70 || !/^[0-9A-Za-z'()+_,\-./:=?]+$/.test(boundary)) {
    throw Object.assign(new Error("Le formulaire d’envoi de fichier est invalide."), { status: 400 });
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`);
  const fields = new Map();
  let attachment = null;
  let position = 0;
  let partCount = 0;

  while (position < buffer.length) {
    if (!buffer.subarray(position, position + delimiter.length).equals(delimiter)) {
      throw Object.assign(new Error("Le formulaire d’envoi de fichier est invalide."), { status: 400 });
    }
    position += delimiter.length;
    if (buffer.subarray(position, position + 2).toString("ascii") === "--") break;
    if (buffer.subarray(position, position + 2).toString("ascii") !== "\r\n") {
      throw Object.assign(new Error("Le formulaire d’envoi de fichier est invalide."), { status: 400 });
    }
    position += 2;

    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), position);
    if (headerEnd < 0) {
      throw Object.assign(new Error("Le formulaire d’envoi de fichier est invalide."), { status: 400 });
    }
    const headers = buffer.subarray(position, headerEnd).toString("utf8");
    const disposition = headers.match(/^content-disposition:\s*form-data\s*;([^\r\n]*)$/im);
    const fieldName = disposition && disposition[1].match(/(?:^|;)\s*name="([^"]*)"/i);
    const fileName = disposition && disposition[1].match(/(?:^|;)\s*filename="([^"]*)"/i);
    if (!fieldName || ++partCount > 3) {
      throw Object.assign(new Error("Le formulaire d’envoi de fichier est invalide."), { status: 400 });
    }
    const contentStart = headerEnd + 4;
    const contentEnd = buffer.indexOf(nextDelimiter, contentStart);
    if (contentEnd < 0) {
      throw Object.assign(new Error("Le formulaire d’envoi de fichier est invalide."), { status: 400 });
    }
    const content = buffer.subarray(contentStart, contentEnd);
    const key = fieldName[1];

    if (fileName && fileName[1]) {
      if (key !== "attachment" || attachment) {
        throw Object.assign(new Error("Un seul fichier peut être envoyé par message."), { status: 400 });
      }
      if (content.length > MAX_ATTACHMENT_BYTES) {
        throw Object.assign(new Error("Le fichier dépasse la limite de 8 Mo."), { status: 413 });
      }
      const originalName = path.basename(fileName[1].replace(/\\/g, "/"))
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 180);
      const extension = path.extname(originalName).toLowerCase();
      const type = ATTACHMENT_TYPES[extension];
      if (!originalName || !type || !type.signature(content)) {
        throw Object.assign(new Error("Type de fichier non pris en charge ou fichier invalide. Formats acceptés : images JPG, PNG, GIF, WebP, PDF, TXT, DOC et DOCX."), { status: 400 });
      }
      attachment = {
        id: crypto.randomUUID(),
        name: originalName,
        mimeType: type.mimeType,
        size: content.length,
        content
      };
    } else {
      if (!["text", "clientId"].includes(key) || fields.has(key)) {
        throw Object.assign(new Error("Le formulaire d’envoi de fichier est invalide."), { status: 400 });
      }
      fields.set(key, content.toString("utf8"));
    }
    position = contentEnd + 2;
  }

  return { fields, attachment };
}

function createApp(options = {}) {
  const dataFile = options.dataFile || path.join(__dirname, "data", "fundora.json");
  const attachmentDir = options.attachmentDir || path.join(path.dirname(dataFile), "attachments");
  const databaseUrl = Object.hasOwn(options, "databaseUrl") ? options.databaseUrl : process.env.DATABASE_URL;
  const store = databaseUrl ? createPostgresStore(databaseUrl) : null;
  const staffName = normalizeName(options.staffName || process.env.FUNDORA_STAFF_NAME || "BEN ANT");
  const staffPassword = options.staffPassword || process.env.FUNDORA_STAFF_PASSWORD;
  const staffSalt = crypto.randomBytes(16);
  const staffPasswordHash = staffPassword
    ? crypto.scryptSync(staffPassword, staffSalt, PASSWORD_KEY_LENGTH)
    : null;
  const sessions = new Map();
  const loginAttempts = new Map();
  let data;

  if (options.data) {
    data = options.data;
  } else if (fs.existsSync(dataFile)) {
    data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  } else {
    data = { users: [], messages: [] };
  }
  if (!Array.isArray(data.users) || !Array.isArray(data.messages)) {
    throw new Error("Le fichier de données Fundora n'a pas le format attendu.");
  }

  function saveData() {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const tempFile = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tempFile, dataFile);
  }

  function sendJson(response, status, body, headers = {}) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      ...headers
    });
    response.end(JSON.stringify(body));
  }

  function sendError(response, status, message) {
    sendJson(response, status, { error: message });
  }

  function getSession(request) {
    const cookies = (request.headers.cookie || "").split(";").map((part) => part.trim());
    const cookie = cookies.find((part) => part.startsWith("fundora_session="));
    if (!cookie) return null;
    const token = cookie.slice("fundora_session=".length);
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL;
    return session;
  }

  function setSession(response, identity) {
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { ...identity, expiresAt: Date.now() + SESSION_TTL });
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    response.setHeader(
      "Set-Cookie",
      `fundora_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure}`
    );
  }

  function clearSession(request, response) {
    const cookies = (request.headers.cookie || "").split(";").map((part) => part.trim());
    const cookie = cookies.find((part) => part.startsWith("fundora_session="));
    if (cookie) sessions.delete(cookie.slice("fundora_session=".length));
    response.setHeader("Set-Cookie", "fundora_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  }

  function requireRole(request, response, role) {
    const session = getSession(request);
    if (!session || (role && session.role !== role)) {
      sendError(response, 401, "Veuillez vous connecter pour continuer.");
      return null;
    }
    return session;
  }

  function consumeAttempt(request, key) {
    const address = request.socket.remoteAddress || "unknown";
    const bucketKey = `${address}:${key}`;
    const now = Date.now();
    const bucket = loginAttempts.get(bucketKey);
    if (!bucket || bucket.until <= now) {
      loginAttempts.set(bucketKey, { count: 1, until: now + 15 * 60 * 1000 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= 10;
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY_LENGTH) {
          reject(Object.assign(new Error("La requête est trop volumineuse."), { status: 413 }));
          request.destroy();
        }
      });
      request.on("end", () => {
        try {
          resolve(JSON.parse(body || "{}"));
        } catch {
          reject(Object.assign(new Error("La requête doit contenir un JSON valide."), { status: 400 }));
        }
      });
      request.on("error", reject);
    });
  }

  function readMultipartBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      request.on("data", (chunk) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX_MULTIPART_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          reject(Object.assign(new Error("Le fichier dépasse la limite de 8 Mo."), { status: 413 }));
          request.resume();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (!tooLarge) resolve(Buffer.concat(chunks));
      });
      request.on("error", (error) => {
        if (!tooLarge) reject(error);
      });
    });
  }

  function publicUser(user) {
    return { id: user.id, name: user.name };
  }

  function userById(id) {
    if (store && !UUID_PATTERN.test(id || "")) return Promise.resolve(null);
    return store ? store.getUserById(id) : Promise.resolve(data.users.find((user) => user.id === id) || null);
  }

  function userByName(name) {
    return store
      ? store.getUserByName(nameKey(name))
      : Promise.resolve(data.users.find((user) => nameKey(user.name) === nameKey(name)) || null);
  }

  function visibleMessages(clientId, after) {
    if (store) return store.getMessages(clientId, after);
    const messages = data.messages.filter((message) => message.clientId === clientId);
    const cursorIndex = after ? messages.findIndex((message) => message.id === after) : -1;
    const visible = cursorIndex < 0 ? messages : messages.slice(cursorIndex + 1);
    return visible.map((message) => (
      message.sender === "staff" ? { ...message, senderName: "Fundora" } : message
    ));
  }

  async function handleApi(request, response, url) {
    if (request.method !== "GET" && request.headers.origin) {
      const origin = new URL(request.headers.origin);
      if (origin.host !== request.headers.host) {
        return sendError(response, 403, "Origine de la requête non autorisée.");
      }
    }

    if (request.method === "GET" && url.pathname === "/api/session") {
      const session = getSession(request);
      if (!session) return sendJson(response, 200, { user: null });
      if (session.role === "staff") {
        return sendJson(response, 200, { user: { id: "staff", name: session.name }, role: "staff" });
      }
      const user = await userById(session.userId);
      if (!user) return sendJson(response, 200, { user: null });
      return sendJson(response, 200, { user: publicUser(user), role: "client" });
    }

    if (request.method === "POST" && url.pathname === "/api/register") {
      if (!consumeAttempt(request, "register")) {
        return sendError(response, 429, "Trop de tentatives. Réessayez dans 15 minutes.");
      }
      const body = await readBody(request);
      const name = normalizeName(body.name);
      if (name.length < 2 || name.length > 60) {
        return sendError(response, 400, "Votre nom doit contenir entre 2 et 60 caractères.");
      }
      if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > 128) {
        return sendError(response, 400, "Choisissez un mot de passe de 8 caractères minimum.");
      }
      if (await userByName(name)) {
        return sendError(response, 409, "Ce nom est déjà utilisé. Choisissez un autre nom.");
      }
      const salt = crypto.randomBytes(16);
      const passwordHash = await scrypt(body.password, salt, PASSWORD_KEY_LENGTH);
      const user = {
        id: crypto.randomUUID(),
        name,
        passwordHash: passwordHash.toString("hex"),
        passwordSalt: salt.toString("hex"),
        createdAt: new Date().toISOString()
      };
      if (store) {
        try {
          await store.createUser(user, nameKey(user.name));
        } catch (error) {
          if (error.code === "23505") {
            return sendError(response, 409, "Ce nom est déjà utilisé. Choisissez un autre nom.");
          }
          throw error;
        }
      } else {
        data.users.push(user);
        saveData();
      }
      setSession(response, { role: "client", userId: user.id });
      return sendJson(response, 201, { user: publicUser(user), role: "client" });
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!consumeAttempt(request, "login")) {
        return sendError(response, 429, "Trop de tentatives. Réessayez dans 15 minutes.");
      }
      const body = await readBody(request);
      const name = normalizeName(body.name);
      if (typeof body.password !== "string" || !name) {
        return sendError(response, 400, "Veuillez saisir votre nom et votre mot de passe.");
      }
      if (body.role === "staff") {
        if (!staffPasswordHash || nameKey(name) !== nameKey(staffName)) {
          return sendError(response, 401, "Nom ou mot de passe incorrect.");
        }
        const candidate = await scrypt(body.password, staffSalt, PASSWORD_KEY_LENGTH);
        if (!crypto.timingSafeEqual(candidate, staffPasswordHash)) {
          return sendError(response, 401, "Nom ou mot de passe incorrect.");
        }
        setSession(response, { role: "staff", name: staffName });
        return sendJson(response, 200, { user: { id: "staff", name: staffName }, role: "staff" });
      }
      const user = await userByName(name);
      if (!user) return sendError(response, 401, "Nom ou mot de passe incorrect.");
      const candidate = await scrypt(body.password, Buffer.from(user.passwordSalt, "hex"), PASSWORD_KEY_LENGTH);
      const expected = Buffer.from(user.passwordHash, "hex");
      if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
        return sendError(response, 401, "Nom ou mot de passe incorrect.");
      }
      setSession(response, { role: "client", userId: user.id });
      return sendJson(response, 200, { user: publicUser(user), role: "client" });
    }

    if (request.method === "POST" && url.pathname === "/api/logout") {
      clearSession(request, response);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/conversations") {
      if (!requireRole(request, response, "staff")) return;
      if (store) {
        return sendJson(response, 200, { conversations: await store.getConversations() });
      }
      const conversations = data.users.map((user) => {
        const messages = data.messages.filter((message) => message.clientId === user.id);
        const latest = messages[messages.length - 1] || null;
        return {
          client: publicUser(user),
          lastMessage: latest ? (latest.text || (latest.attachment ? `Pièce jointe : ${latest.attachment.name}` : "")) : "",
          updatedAt: latest ? latest.createdAt : user.createdAt
        };
      });
      conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return sendJson(response, 200, { conversations });
    }

    if (request.method === "GET" && url.pathname === "/api/messages") {
      const session = requireRole(request, response);
      if (!session) return;
      const clientId = session.role === "staff" ? url.searchParams.get("clientId") : session.userId;
      if (session.role === "staff" && !await userById(clientId)) {
        return sendError(response, 404, "Client introuvable.");
      }
      const requestedAfter = url.searchParams.get("after") || "";
      const after = UUID_PATTERN.test(requestedAfter) ? requestedAfter : "";
      return sendJson(response, 200, { messages: await visibleMessages(clientId, after) });
    }

    if (request.method === "POST" && url.pathname === "/api/messages/read") {
      const session = requireRole(request, response);
      if (!session) return;
      const body = await readBody(request);
      const clientId = session.role === "staff" ? body.clientId : session.userId;
      if (!await userById(clientId)) return sendError(response, 404, "Client introuvable.");
      if (store) {
        return sendJson(response, 200, await store.markMessagesRead(clientId, session.role));
      }
      const unreadMessages = data.messages.filter((message) => (
        message.clientId === clientId && message.sender !== session.role && !message.readAt
      ));
      if (unreadMessages.length) {
        const readAt = new Date().toISOString();
        for (const message of unreadMessages) message.readAt = readAt;
        saveData();
        return sendJson(response, 200, { readAt, count: unreadMessages.length });
      }
      return sendJson(response, 200, { readAt: null, count: 0 });
    }

    if (request.method === "GET" && /^\/api\/files\/[0-9a-f-]{36}$/i.test(url.pathname)) {
      const session = requireRole(request, response);
      if (!session) return;
      const fileId = url.pathname.slice("/api/files/".length);
      if (!UUID_PATTERN.test(fileId)) return sendError(response, 404, "Fichier introuvable.");
      if (store) {
        const file = await store.getAttachment(fileId);
        if (!file || (session.role === "client" && file.clientId !== session.userId)) {
          return sendError(response, 404, "Fichier introuvable.");
        }
        return sendAttachment(response, file.attachment, file.content);
      }
      const message = data.messages.find((item) => item.attachment && item.attachment.id === fileId);
      if (!message || (session.role === "client" && message.clientId !== session.userId)) {
        return sendError(response, 404, "Fichier introuvable.");
      }
      const filePath = path.join(attachmentDir, fileId);
      let fileStat;
      try {
        fileStat = fs.statSync(filePath);
      } catch (error) {
        if (error.code === "ENOENT") return sendError(response, 404, "Fichier introuvable.");
        throw error;
      }
      const attachment = message.attachment;
      const encodedName = encodeURIComponent(attachment.name).replace(/['()*]/g, (character) => (
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      ));
      const disposition = attachment.mimeType.startsWith("image/") ? "inline" : "attachment";
      response.writeHead(200, {
        "Content-Type": attachment.mimeType,
        "Content-Length": fileStat.size,
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer"
      });
      const fileStream = fs.createReadStream(filePath);
      fileStream.on("error", (error) => {
        console.error("Erreur de lecture d’une pièce jointe Fundora :", error);
        if (!response.headersSent) sendError(response, 500, "Impossible de lire cette pièce jointe.");
        else response.destroy();
      });
      fileStream.pipe(response);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/messages") {
      const session = requireRole(request, response);
      if (!session) return;
      const contentType = request.headers["content-type"] || "";
      let body;
      let uploadedFile = null;
      if (/^multipart\/form-data\b/i.test(contentType)) {
        const multipart = parseMultipart(await readMultipartBody(request), contentType);
        body = Object.fromEntries(multipart.fields);
        uploadedFile = multipart.attachment;
      } else if (/^application\/json\b/i.test(contentType)) {
        body = await readBody(request);
      } else {
        return sendError(response, 415, "Format de message non pris en charge.");
      }
      const clientId = session.role === "staff" ? body.clientId : session.userId;
      const clientUser = await userById(clientId);
      if (!clientUser) return sendError(response, 404, "Client introuvable.");
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if ((!text && !uploadedFile) || text.length > 2000) {
        return sendError(response, 400, "Écrivez un message ou joignez un fichier. Un message ne peut pas dépasser 2 000 caractères.");
      }
      if (uploadedFile && !store) {
        fs.mkdirSync(attachmentDir, { recursive: true });
        const filePath = path.join(attachmentDir, uploadedFile.id);
        fs.writeFileSync(filePath, uploadedFile.content, { flag: "wx", mode: 0o600 });
      }
      const message = {
        id: crypto.randomUUID(),
        clientId,
        sender: session.role,
        senderName: session.role === "staff" ? "Fundora" : clientUser.name,
        text,
        createdAt: new Date().toISOString()
      };
      if (store) {
        await store.createMessage(message, uploadedFile);
        return sendJson(response, 201, { message });
      }
      if (uploadedFile) {
        message.attachment = {
          id: uploadedFile.id,
          name: uploadedFile.name,
          mimeType: uploadedFile.mimeType,
          size: uploadedFile.size
        };
      }
      data.messages.push(message);
      try {
        saveData();
      } catch (error) {
        data.messages.pop();
        if (uploadedFile) fs.unlinkSync(path.join(attachmentDir, uploadedFile.id));
        throw error;
      }
      return sendJson(response, 201, { message });
    }

    return sendError(response, 404, "Cette adresse n'existe pas.");
  }

  function serveStatic(request, response, url) {
    const routes = {
      "/": ["index.html", "text/html; charset=utf-8"],
      "/app.js": ["app.js", "text/javascript; charset=utf-8"],
      "/styles.css": ["styles.css", "text/css; charset=utf-8"]
    };
    const route = routes[url.pathname];
    if (request.method !== "GET" || !route) {
      response.writeHead(404);
      return response.end("Not found");
    }
    const [fileName, contentType] = route;
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
    });
    const filePath = path.join(PUBLIC_DIR, fileName);
    let content;
    try {
      content = fs.readFileSync(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        console.error(`Fichier statique Fundora introuvable : ${fileName}`);
        response.writeHead(404);
        response.end("Not found");
        return;
      }
      throw error;
    }
    response.end(content);
  }

  function sendAttachment(response, attachment, content) {
    const encodedName = encodeURIComponent(attachment.name).replace(/['()*]/g, (character) => (
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    ));
    const disposition = attachment.mimeType.startsWith("image/") ? "inline" : "attachment";
    response.writeHead(200, {
      "Content-Type": attachment.mimeType,
      "Content-Length": content.length,
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer"
    });
    response.end(content);
  }

  async function handleRequest(request, response, routeOverride) {
    try {
      if (store) await server.ready;
      const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (!routeOverride && requestUrl.pathname === "/api/index") {
        const originalPath = requestUrl.searchParams.get("__fundora_path");
        if (originalPath && originalPath.startsWith("/") && !originalPath.startsWith("//")) {
          requestUrl.searchParams.delete("__fundora_path");
          routeOverride = `${originalPath}${requestUrl.search}`;
        }
      }
      const url = new URL(routeOverride || requestUrl, `http://${request.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
      } else {
        serveStatic(request, response, url);
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error.status) return sendError(response, error.status, error.message);
      console.error("Erreur du serveur Fundora :", error);
      sendError(response, 500, "Une erreur est survenue. Veuillez réessayer.");
    }
  }

  const server = http.createServer(handleRequest);
  server.handleRequest = handleRequest;
  server.ready = store ? store.initialize(dataFile, attachmentDir) : Promise.resolve();
  server.on("close", () => {
    if (store) store.close().catch((error) => console.error("Erreur de fermeture PostgreSQL Fundora :", error));
  });
  return server;
}

if (require.main === module) {
  if (!process.env.FUNDORA_STAFF_PASSWORD || process.env.FUNDORA_STAFF_PASSWORD.length < 8) {
      console.error("Définissez FUNDORA_STAFF_PASSWORD avec au moins 8 caractères avant de lancer le serveur.");
    process.exitCode = 1;
  } else {
    const server = createApp();
    const port = Number(process.env.PORT) || 3000;
    server.ready.then(() => {
      server.listen(port, () => {
        console.log(`Chat Fundora disponible sur http://localhost:${port}`);
      });
    }).catch((error) => {
      console.error("Impossible de démarrer Fundora avec la base PostgreSQL configurée :", error);
      server.close();
      process.exitCode = 1;
    });
  }
}

let vercelServer;

async function vercelHandler(request, response) {
  try {
    if (!vercelServer) vercelServer = createApp();
    await vercelServer.ready;
  } catch (error) {
    console.error("Impossible d’initialiser le chat Fundora :", error);
    response.statusCode = 500;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Le service Fundora est temporairement indisponible.");
    return;
  }

  await vercelServer.handleRequest(request, response);
}

module.exports = vercelHandler;
module.exports.createApp = createApp;
