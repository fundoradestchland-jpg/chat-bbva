const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createApp } = require("../server");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fundora-chat-"));
const staffName = "BEN ANT";
const staffPassword = "ben@2006";
const server = createApp({
  dataFile: path.join(directory, "fundora.json"),
  databaseUrl: "",
  staffName,
  staffPassword
});
let baseUrl;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});

function makeClient() {
  return { cookie: "", async request(route, options = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...options.headers
      }
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    return { status: response.status, body: await response.json() };
  } };
}

test("clients can register, sign in again, and exchange private messages with Fundora", async () => {
  const client = makeClient();
  const registration = await client.request("/api/register", {
    method: "POST",
    body: JSON.stringify({ name: "Camille Martin", password: "client-pass-123" })
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.body.user.name, "Camille Martin");

  const duplicate = await makeClient().request("/api/register", {
    method: "POST",
    body: JSON.stringify({ name: "  camille   martin ", password: "another-pass-123" })
  });
  assert.equal(duplicate.status, 409);

  const signedOut = await client.request("/api/logout", { method: "POST", body: "{}" });
  assert.equal(signedOut.status, 200);
  const wrongPassword = await client.request("/api/login", {
    method: "POST",
    body: JSON.stringify({ name: "Camille Martin", password: "wrong-password" })
  });
  assert.equal(wrongPassword.status, 401);

  const login = await client.request("/api/login", {
    method: "POST",
    body: JSON.stringify({ name: "  CAMILLE martin ", password: "client-pass-123" })
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.name, "Camille Martin");

  const sent = await client.request("/api/messages", {
    method: "POST",
    body: JSON.stringify({ text: "Bonjour, j’ai une question." })
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.sender, "client");
  const clientId = sent.body.message.clientId;

  const staff = makeClient();
  const staffLogin = await staff.request("/api/login", {
    method: "POST",
    body: JSON.stringify({ name: staffName, password: staffPassword, role: "staff" })
  });
  assert.equal(staffLogin.status, 200);

  const invalidStaffLogin = await makeClient().request("/api/login", {
    method: "POST",
    body: JSON.stringify({ name: staffName, password: "wrong-pass", role: "staff" })
  });
  assert.equal(invalidStaffLogin.status, 401);

  const conversations = await staff.request("/api/conversations");
  assert.equal(conversations.body.conversations.length, 1);
  assert.equal(conversations.body.conversations[0].client.id, clientId);

  const unread = await staff.request(`/api/messages?clientId=${encodeURIComponent(clientId)}`);
  assert.equal(unread.body.messages[0].readAt, undefined);
  const markedRead = await staff.request("/api/messages/read", {
    method: "POST",
    body: JSON.stringify({ clientId })
  });
  assert.equal(markedRead.status, 200);
  assert.equal(markedRead.body.count, 1);
  const clientMessages = await client.request("/api/messages");
  assert.ok(clientMessages.body.messages[0].readAt);

  const reply = await staff.request("/api/messages", {
    method: "POST",
    body: JSON.stringify({ clientId, text: "Bonjour Camille, nous sommes là pour vous aider." })
  });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.message.sender, "staff");
  assert.equal(reply.body.message.senderName, "Fundora");

  const clientMarkedRead = await client.request("/api/messages/read", {
    method: "POST",
    body: JSON.stringify({ clientId: "a-different-client-id" })
  });
  assert.equal(clientMarkedRead.status, 200);
  assert.equal(clientMarkedRead.body.count, 1);
  const staffMessages = await staff.request(`/api/messages?clientId=${encodeURIComponent(clientId)}`);
  assert.ok(staffMessages.body.messages[1].readAt);

  const newMessages = await client.request(`/api/messages?after=${encodeURIComponent(sent.body.message.id)}`);
  assert.equal(newMessages.body.messages.length, 1);
  assert.equal(newMessages.body.messages[0].id, reply.body.message.id);

  const received = await client.request("/api/messages");
  assert.equal(received.body.messages.length, 2);
  assert.equal(received.body.messages[1].text, "Bonjour Camille, nous sommes là pour vous aider.");
});

test("Vercel rewrites preserve registration and login API routes", async () => {
  const client = makeClient();
  const registration = await client.request(
    "/api/index?__fundora_path=%2Fapi%2Fregister",
    {
      method: "POST",
      body: JSON.stringify({ name: "Vercel Route Test", password: "vercel-route-pass" })
    }
  );
  assert.equal(registration.status, 201);

  const signedOut = await client.request("/api/logout", { method: "POST", body: "{}" });
  assert.equal(signedOut.status, 200);
  const login = await client.request(
    "/api/index?__fundora_path=%2Fapi%2Flogin",
    {
      method: "POST",
      body: JSON.stringify({ name: "Vercel Route Test", password: "vercel-route-pass" })
    }
  );
  assert.equal(login.status, 200);
  assert.equal(login.body.user.name, "Vercel Route Test");
});

test("messages stay private, and passwords are not stored in plain text", async () => {
  const file = path.join(directory, "fundora.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.notEqual(saved.users[0].passwordHash, "client-pass-123");
  assert.equal(saved.users[0].passwordHash.length, 128);
  assert.equal(saved.messages.length, 2);

  const anotherClient = makeClient();
  const registration = await anotherClient.request("/api/register", {
    method: "POST",
    body: JSON.stringify({ name: "Alex Dupont", password: "another-pass-123" })
  });
  assert.equal(registration.status, 201);
  const messages = await anotherClient.request("/api/messages");
  assert.deepEqual(messages.body.messages, []);

  const anonymous = makeClient();
  const unauthorized = await anonymous.request("/api/conversations");
  assert.equal(unauthorized.status, 401);
});

test("invalid names and short passwords are rejected", async () => {
  const response = await makeClient().request("/api/register", {
    method: "POST",
    body: JSON.stringify({ name: "A", password: "short" })
  });
  assert.equal(response.status, 400);
});

test("tampered session tokens are not accepted", async () => {
  const response = await fetch(`${baseUrl}/api/conversations`, {
    headers: { Cookie: `fundora_session=${crypto.randomBytes(32).toString("hex")}` }
  });
  assert.equal(response.status, 401);
});

test("clients can only mark their own messages as read", async () => {
  const client = makeClient();
  const registration = await client.request("/api/register", {
    method: "POST",
    body: JSON.stringify({ name: "Samira Test", password: "samira-pass-123" })
  });
  assert.equal(registration.status, 201);

  const markedRead = await client.request("/api/messages/read", {
    method: "POST",
    body: JSON.stringify({ clientId: "a-different-client-id" })
  });
  assert.equal(markedRead.status, 200);
  assert.equal(markedRead.body.count, 0);
});

test("messages sent by the admin keep the Fundora display name, including older messages", async () => {
  const clientId = "legacy-client";
  const legacyServer = createApp({
    dataFile: path.join(directory, "legacy-fundora.json"),
    databaseUrl: "",
    staffName,
    staffPassword,
    data: {
      users: [{ id: clientId, name: "Legacy Client", createdAt: new Date().toISOString() }],
      messages: [{
        id: "legacy-message",
        clientId,
        sender: "staff",
        senderName: staffName,
        text: "Ancien message administrateur",
        createdAt: new Date().toISOString()
      }]
    }
  });
  await new Promise((resolve) => legacyServer.listen(0, "127.0.0.1", resolve));
  try {
    const legacyUrl = `http://127.0.0.1:${legacyServer.address().port}`;
    const login = await fetch(`${legacyUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: staffName, password: staffPassword, role: "staff" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const response = await fetch(`${legacyUrl}/api/messages?clientId=${encodeURIComponent(clientId)}`, {
      headers: { Cookie: cookie }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.messages[0].senderName, "Fundora");
  } finally {
    await new Promise((resolve) => legacyServer.close(resolve));
  }
});

test("client accounts and messages remain available after a server restart", async () => {
  const restartedServer = createApp({
    dataFile: path.join(directory, "fundora.json"),
    databaseUrl: "",
    staffName,
    staffPassword
  });
  await new Promise((resolve) => restartedServer.listen(0, "127.0.0.1", resolve));
  try {
    const client = makeClient();
    const response = await fetch(`http://127.0.0.1:${restartedServer.address().port}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Camille Martin", password: "client-pass-123" })
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const messagesResponse = await fetch(`http://127.0.0.1:${restartedServer.address().port}/api/messages`, {
      headers: { Cookie: cookie }
    });
    const body = await messagesResponse.json();
    assert.equal(messagesResponse.status, 200);
    assert.equal(body.messages[0].text, "Bonjour, j’ai une question.");
  } finally {
    await new Promise((resolve) => restartedServer.close(resolve));
  }
});

test("clients and admin can exchange private images and documents", async () => {
  const client = makeClient();
  const login = await client.request("/api/login", {
    method: "POST",
    body: JSON.stringify({ name: "Camille Martin", password: "client-pass-123" })
  });
  assert.equal(login.status, 200);

  const imageForm = new FormData();
  imageForm.append("text", "Voici une image.");
  imageForm.append(
    "attachment",
    new Blob([Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)])], { type: "image/png" }),
    "image.png"
  );
  const imageMessage = await client.request("/api/messages", { method: "POST", body: imageForm });
  assert.equal(imageMessage.status, 201);
  assert.equal(imageMessage.body.message.attachment.mimeType, "image/png");
  assert.equal(imageMessage.body.message.attachment.name, "image.png");

  const staff = makeClient();
  const staffLogin = await staff.request("/api/login", {
    method: "POST",
    body: JSON.stringify({ name: staffName, password: staffPassword, role: "staff" })
  });
  assert.equal(staffLogin.status, 200);

  const documentForm = new FormData();
  documentForm.append("clientId", login.body.user.id);
  documentForm.append("attachment", new Blob(["%PDF-1.7\nFundora document"], { type: "application/pdf" }), "document.pdf");
  const documentMessage = await staff.request("/api/messages", { method: "POST", body: documentForm });
  assert.equal(documentMessage.status, 201);
  assert.equal(documentMessage.body.message.attachment.mimeType, "application/pdf");

  const conversations = await staff.request("/api/conversations");
  assert.equal(conversations.body.conversations[0].lastMessage, "Archivo adjunto: document.pdf");

  const imageResponse = await fetch(`${baseUrl}/api/files/${imageMessage.body.message.attachment.id}`, {
    headers: { Cookie: client.cookie }
  });
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(imageResponse.headers.get("content-disposition"), "inline; filename*=UTF-8''image.png");

  const documentResponse = await fetch(`${baseUrl}/api/files/${documentMessage.body.message.attachment.id}`, {
    headers: { Cookie: staff.cookie }
  });
  assert.equal(documentResponse.status, 200);
  assert.match(documentResponse.headers.get("content-disposition"), /^attachment;/);
  assert.equal(await documentResponse.text(), "%PDF-1.7\nFundora document");

  const anotherClient = makeClient();
  const registration = await anotherClient.request("/api/register", {
    method: "POST",
    body: JSON.stringify({ name: "Nora Dupont", password: "another-pass-123" })
  });
  assert.equal(registration.status, 201);
  const privateFile = await fetch(`${baseUrl}/api/files/${imageMessage.body.message.attachment.id}`, {
    headers: { Cookie: anotherClient.cookie }
  });
  assert.equal(privateFile.status, 404);

  const unsupportedForm = new FormData();
  unsupportedForm.append("attachment", new Blob(["not an image"], { type: "image/png" }), "fake.png");
  const unsupported = await client.request("/api/messages", { method: "POST", body: unsupportedForm });
  assert.equal(unsupported.status, 400);

  const maximumSizeForm = new FormData();
  maximumSizeForm.append(
    "attachment",
    new Blob([Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(4 * 1024 * 1024 - 8)])], { type: "image/png" }),
    "maximum-size.png"
  );
  const maximumSize = await client.request("/api/messages", { method: "POST", body: maximumSizeForm });
  assert.equal(maximumSize.status, 201);
  assert.equal(maximumSize.body.message.attachment.size, 4 * 1024 * 1024);

  const oversizedForm = new FormData();
  oversizedForm.append(
    "attachment",
    new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "text/plain" }),
    "trop-grand.txt"
  );
  const oversized = await client.request("/api/messages", { method: "POST", body: oversizedForm });
  assert.equal(oversized.status, 413);

  const anonymousFile = await fetch(`${baseUrl}/api/files/${imageMessage.body.message.attachment.id}`);
  assert.equal(anonymousFile.status, 401);
});
