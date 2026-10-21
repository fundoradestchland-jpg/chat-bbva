const app = document.querySelector("#app");
const authForm = document.querySelector("#auth-form");
const nameInput = document.querySelector("#name");
const passwordInput = document.querySelector("#password");
const authError = document.querySelector("#auth-error");
const authSubmit = document.querySelector("#auth-submit");
const clientTab = document.querySelector("#client-tab");
const staffTab = document.querySelector("#staff-tab");
const switchAuth = document.querySelector("#switch-auth");
const staffNote = document.querySelector("#staff-note");
const authTitle = document.querySelector("#auth-title");
const authSubtitle = document.querySelector("#auth-subtitle");

let role = "client";
let isRegistering = false;
let currentUser = null;
let selectedClientId = null;
let refreshTimer = null;
let latestMessageId = "";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

async function api(url, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers
  });
  const responseText = await response.text();
  let body;
  try {
    body = responseText ? JSON.parse(responseText) : {};
  } catch {
    if (response.status === 413) throw new Error("El archivo es demasiado grande. El tamaño máximo es de 4 MB.");
    throw new Error("El servidor no ha podido procesar la solicitud. Inténtalo de nuevo.");
  }
  if (response.status === 413 && !body.error) {
    throw new Error("El archivo es demasiado grande. El tamaño máximo es de 4 MB.");
  }
  if (!response.ok) throw new Error(body.error || "Se ha producido un error.");
  return body;
}

function showAuthError(message) {
  authError.textContent = message;
  authError.hidden = false;
}

function updateAuthMode() {
  const staff = role === "staff";
  clientTab.classList.toggle("is-active", !staff);
  staffTab.classList.toggle("is-active", staff);
  clientTab.setAttribute("aria-selected", String(!staff));
  staffTab.setAttribute("aria-selected", String(staff));
  staffNote.hidden = !staff;
  switchAuth.hidden = staff;
  authError.hidden = true;
  if (staff) {
    isRegistering = false;
    authTitle.textContent = "Acceso de administración.";
    authSubtitle.textContent = "Inicia sesión para ver tus conversaciones.";
    authSubmit.querySelector("span:first-child").textContent = "Ver conversaciones";
    passwordInput.autocomplete = "current-password";
  } else {
    authTitle.textContent = isRegistering ? "¡Encantados de conocerte!" : "Nos alegra verte de nuevo.";
    authSubtitle.textContent = isRegistering
      ? "Crea tu espacio para hablar con nuestro equipo."
      : "Inicia sesión para retomar la conversación.";
    authSubmit.querySelector("span:first-child").textContent = isRegistering ? "Crear mi espacio" : "Iniciar sesión";
    passwordInput.autocomplete = isRegistering ? "new-password" : "current-password";
    switchAuth.innerHTML = isRegistering
      ? '¿Ya tienes una cuenta? <button id="switch-auth-button" type="button">Iniciar sesión</button>'
      : '¿Aún no tienes una cuenta? <button id="switch-auth-button" type="button">Crear mi espacio</button>';
    document.querySelector("#switch-auth-button").addEventListener("click", () => {
      isRegistering = !isRegistering;
      updateAuthMode();
      authError.hidden = true;
    });
  }
}

clientTab.addEventListener("click", () => {
  role = "client";
  updateAuthMode();
});
staffTab.addEventListener("click", () => {
  role = "staff";
  updateAuthMode();
});
document.querySelector("#password-toggle").addEventListener("click", (event) => {
  const visible = passwordInput.type === "password";
  passwordInput.type = visible ? "text" : "password";
  event.currentTarget.textContent = visible ? "Ocultar" : "Mostrar";
  event.currentTarget.setAttribute("aria-label", visible ? "Ocultar contraseña" : "Mostrar contraseña");
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authError.hidden = true;
  authSubmit.disabled = true;
  try {
    const body = { name: nameInput.value, password: passwordInput.value };
    const result = role === "staff"
      ? await api("/api/login", { method: "POST", body: JSON.stringify({ ...body, role }) })
      : isRegistering
        ? await api("/api/register", { method: "POST", body: JSON.stringify(body) })
        : await api("/api/login", { method: "POST", body: JSON.stringify(body) });
    currentUser = result.user;
    role = result.role;
    await renderWorkspace();
  } catch (error) {
    showAuthError(error.message);
  } finally {
    authSubmit.disabled = false;
  }
});

async function logout() {
  clearInterval(refreshTimer);
  await api("/api/logout", { method: "POST", body: "{}" });
  currentUser = null;
  selectedClientId = null;
  latestMessageId = "";
  window.location.reload();
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function formatDay(value) {
  return new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long" }).format(new Date(value));
}

function messageFormMarkup(placeholder, buttonLabel) {
  return `<form class="message-form" id="message-form"><div class="attachment-controls"><label class="attach-button" for="message-attachment"><span aria-hidden="true">＋</span> Adjuntar archivo</label><input class="attachment-input" id="message-attachment" type="file" accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.txt,.doc,.docx" aria-label="Adjuntar una imagen o un documento"><span class="attachment-name" id="attachment-name">Imágenes y documentos · Máximo 4 MB</span></div><textarea id="message-input" maxlength="2000" rows="1" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}"></textarea><span class="message-hint">Intro para enviar · Mayús + Intro para saltar de línea</span><button class="send-button" type="submit"><span>${escapeHtml(buttonLabel)}</span><span aria-hidden="true">→</span></button></form>`;
}

function bindMessageForm(clientId = null) {
  const form = document.querySelector("#message-form");
  const input = document.querySelector("#message-input");
  const fileInput = document.querySelector("#message-attachment");
  const fileName = document.querySelector("#attachment-name");
  const defaultFileHint = fileName.textContent;

  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file && file.size > 4 * 1024 * 1024) {
      window.alert("El archivo supera el tamaño máximo de 4 MB.");
      fileInput.value = "";
      fileName.textContent = defaultFileHint;
      return;
    }
    fileName.textContent = file ? `${file.name} · ${formatFileSize(file.size)}` : defaultFileHint;
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    const file = fileInput.files[0];
    if (!text && !file) return;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const body = new FormData();
      body.append("text", text);
      if (clientId) body.append("clientId", clientId);
      if (file) body.append("attachment", file);
      await api("/api/messages", { method: "POST", body });
      input.value = "";
      fileInput.value = "";
      fileName.textContent = defaultFileHint;
      if (role === "staff") {
        await refreshStaffMessages();
        await refreshConversations();
      } else {
        await refreshClientMessages();
      }
    } catch (error) {
      window.alert(error.message);
    } finally {
      button.disabled = false;
      input.focus();
    }
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}

function formatFileSize(size) {
  if (size < 1024) return `${size} bytes`;
  return size < 1024 * 1024
    ? `${Math.round(size / 1024)} KB`
    : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function renderMessages(messages) {
  const list = document.querySelector("#message-list");
  if (!list) return;
  if (!messages.length && !list.children.length) {
    list.innerHTML = '<div class="empty-chat"><span class="empty-chat-icon">✳</span><strong>La conversación empieza aquí.</strong><span>Envía tu primer mensaje al equipo de Fundora.</span></div>';
    return;
  }
  const empty = list.querySelector(".empty-chat");
  if (empty) empty.remove();
  const existingMessages = new Map(
    [...list.querySelectorAll(".message-row[data-message-id]")].map((item) => [item.dataset.messageId, item])
  );
  for (const message of messages) {
    const existing = existingMessages.get(message.id);
    if (existing) {
      const status = existing.querySelector(".message-status");
      if (status) {
        status.textContent = message.readAt ? "Leído" : "Enviado";
        status.classList.toggle("is-read", Boolean(message.readAt));
      }
      latestMessageId = message.id;
      continue;
    }
    const dateLabel = formatDay(message.createdAt);
    const lastDate = list.dataset.lastDate || "";
    if (dateLabel !== lastDate) {
      const separator = document.createElement("div");
      separator.className = "date-separator";
      separator.textContent = dateLabel;
      list.append(separator);
      list.dataset.lastDate = dateLabel;
    }
    const bubble = document.createElement("article");
    bubble.className = `message-row ${message.sender === role ? "message-mine" : "message-theirs"}`;
    const attachment = message.attachment;
    const attachmentMarkup = attachment
      ? attachment.mimeType.startsWith("image/")
        ? `<a class="message-attachment image-attachment" href="/api/files/${encodeURIComponent(attachment.id)}" target="_blank" rel="noopener"><img src="/api/files/${encodeURIComponent(attachment.id)}" alt="${escapeHtml(attachment.name)}" loading="lazy"><span>${escapeHtml(attachment.name)}</span></a>`
        : `<a class="message-attachment document-attachment" href="/api/files/${encodeURIComponent(attachment.id)}" download><span class="document-icon" aria-hidden="true">↓</span><span class="document-details"><strong>${escapeHtml(attachment.name)}</strong><small>${formatFileSize(attachment.size)}</small></span><span aria-hidden="true">↗</span></a>`
      : "";
    bubble.dataset.messageId = message.id;
    const receipt = message.sender === role
      ? `<span class="message-status${message.readAt ? " is-read" : ""}">${message.readAt ? "Leído" : "Enviado"}</span>`
      : "";
    bubble.innerHTML = `<span class="message-sender">${escapeHtml(message.senderName)}</span>${message.text ? `<div class="message-bubble">${escapeHtml(message.text).replace(/\n/g, "<br>")}</div>` : ""}${attachmentMarkup}<div class="message-meta"><time>${formatTime(message.createdAt)}</time>${receipt}</div>`;
    const image = bubble.querySelector(".image-attachment img");
    if (image) {
      image.addEventListener("load", () => {
        if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) {
          list.scrollTop = list.scrollHeight;
        }
      }, { once: true });
    }
    list.append(bubble);
    latestMessageId = message.id;
  }
  list.scrollTop = list.scrollHeight;
}

async function refreshClientMessages() {
  const result = await api("/api/messages");
  renderMessages(result.messages);
  if (document.visibilityState === "visible" && result.messages.some((message) => message.sender !== role && !message.readAt)) {
    await api("/api/messages/read", { method: "POST", body: "{}" });
  }
}

function clientWorkspace() {
  app.innerHTML = `
    <section class="workspace">
      <div class="workspace-heading"><div><div class="eyebrow"><span class="eyebrow-line"></span> Tu espacio personal</div><h1>Hola, <span>${escapeHtml(currentUser.name.split(" ")[0])}.</span></h1><p>Tu conversación con el equipo de Fundora, siempre a mano.</p></div><button class="logout-button" id="logout">Cerrar sesión <span>↗</span></button></div>
      <section class="chat-card client-chat-card"><div class="chat-header"><div class="team-avatar">F</div><div class="chat-header-copy"><strong>El equipo de Fundora</strong><span><span class="status-dot"></span> Estamos aquí para responderte</span></div><span class="private-label"><span>◈</span> Conversación privada</span></div><div class="message-list" id="message-list" aria-live="polite"></div>${messageFormMarkup("Escribe tu mensaje…", "Enviar")}</section>
      <div class="workspace-footnote"><span>◈</span> Tus mensajes son privados y solo tú y el equipo de Fundora pueden verlos.</div>
    </section>`;
  document.querySelector("#logout").addEventListener("click", logout);
  bindMessageForm();
  refreshClientMessages().catch(showWorkspaceError);
  refreshTimer = setInterval(() => refreshClientMessages().catch(showWorkspaceError), 3000);
}

function showWorkspaceError(error) {
  const list = document.querySelector("#message-list");
  if (list) {
    list.innerHTML = `<p class="workspace-error">${escapeHtml(error.message)} <button id="retry">Reintentar</button></p>`;
    document.querySelector("#retry").addEventListener("click", () => renderWorkspace());
  }
}

async function refreshConversations() {
  const result = await api("/api/conversations");
  const list = document.querySelector("#conversation-list");
  if (!list) return;
  list.innerHTML = result.conversations.length ? "" : '<div class="no-conversations">Los nuevos clientes aparecerán aquí cuando creen su espacio.</div>';
  for (const conversation of result.conversations) {
    const button = document.createElement("button");
    button.className = `conversation-item ${selectedClientId === conversation.client.id ? "is-selected" : ""}`;
    button.innerHTML = `<span class="client-avatar">${escapeHtml(conversation.client.name.slice(0, 1).toUpperCase())}</span><span class="conversation-copy"><strong>${escapeHtml(conversation.client.name)}</strong><span>${escapeHtml(conversation.lastMessage || "Nueva conversación")}</span></span><time>${formatTime(conversation.updatedAt)}</time>`;
    button.addEventListener("click", () => {
      selectedClientId = conversation.client.id;
      latestMessageId = "";
      renderStaffWorkspace();
    });
    list.append(button);
  }
  return result;
}

async function refreshStaffMessages() {
  if (!selectedClientId) return;
  const query = new URLSearchParams({ clientId: selectedClientId });
  const result = await api(`/api/messages?${query}`);
  renderMessages(result.messages);
  if (document.visibilityState === "visible" && result.messages.some((message) => message.sender !== role && !message.readAt)) {
    await api("/api/messages/read", {
      method: "POST",
      body: JSON.stringify({ clientId: selectedClientId })
    });
  }
}

function renderStaffWorkspace() {
  clearInterval(refreshTimer);
  const previouslySelected = selectedClientId;
  app.innerHTML = `
    <section class="workspace staff-workspace">
      <div class="workspace-heading"><div><div class="eyebrow"><span class="eyebrow-line"></span> Panel de administración</div><h1>Tu bandeja <span>de mensajes.</span></h1><p>Consulta las conversaciones de tus clientes y respóndeles.</p></div><button class="logout-button" id="logout">Cerrar sesión <span>↗</span></button></div>
      <section class="inbox-card"><aside class="inbox-sidebar"><div class="inbox-sidebar-heading"><strong>Conversaciones</strong><span id="conversation-count"></span></div><div class="conversation-list" id="conversation-list"><div class="loading-conversations">Cargando conversaciones…</div></div></aside><section class="inbox-chat" id="inbox-chat"></section></section>
      <div class="workspace-footnote"><span>✳</span> Una respuesta atenta puede marcar la diferencia.</div>
    </section>`;
  document.querySelector("#logout").addEventListener("click", logout);
  const inboxChat = document.querySelector("#inbox-chat");
  if (!previouslySelected) {
    inboxChat.innerHTML = '<div class="inbox-placeholder"><span>✳</span><strong>Elige una conversación</strong><p>Selecciona un cliente de la lista para ver sus mensajes.</p></div>';
  } else {
    inboxChat.innerHTML = `<div class="chat-header"><div class="team-avatar">F</div><div class="chat-header-copy"><strong id="selected-client-name">Conversación con el cliente</strong><span>Conversación privada con Fundora</span></div></div><div class="message-list" id="message-list" aria-live="polite"></div>${messageFormMarkup("Responde a tu cliente…", "Responder")}`;
    api("/api/conversations").then(({ conversations }) => {
      const selected = conversations.find((item) => item.client.id === selectedClientId);
      const title = document.querySelector("#selected-client-name");
      if (title && selected) title.textContent = selected.client.name;
    }).catch(showWorkspaceError);
    bindMessageForm(selectedClientId);
    refreshStaffMessages().catch(showWorkspaceError);
  }
  refreshConversations().then(({ conversations }) => {
    const count = document.querySelector("#conversation-count");
    if (count) count.textContent = conversations.length;
  }).catch(showWorkspaceError);
  refreshTimer = setInterval(() => {
    Promise.all([
      refreshConversations(),
      selectedClientId ? refreshStaffMessages() : Promise.resolve()
    ]).then(([{ conversations }]) => {
      const count = document.querySelector("#conversation-count");
      if (count) count.textContent = conversations.length;
    }).catch(showWorkspaceError);
  }, 5000);
}

async function renderWorkspace() {
  clearInterval(refreshTimer);
  if (role === "staff") await renderStaffWorkspace();
  else clientWorkspace();
}

async function start() {
  try {
    const session = await api("/api/session");
    if (session.user) {
      currentUser = session.user;
      role = session.role;
      await renderWorkspace();
    } else {
      updateAuthMode();
    }
  } catch (error) {
    showAuthError(error.message);
  }
}

start();
