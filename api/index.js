const { createApp } = require("../server");

const server = createApp();

module.exports = async function handler(request, response) {
  try {
    await server.ready;
  } catch (error) {
    console.error("Impossible d’initialiser le chat Fundora :", error);
    response.statusCode = 500;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Le service Fundora est temporairement indisponible.");
    return;
  }

  await server.handleRequest(request, response);
};
