const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

function mapUser(row) {
  return {
    id: row.id,
    name: row.name,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapMessage(row) {
  const message = {
    id: row.id,
    clientId: row.client_id,
    sender: row.sender,
    senderName: row.sender === "staff" ? "Fundora" : row.sender_name,
    text: row.text,
    createdAt: new Date(row.created_at).toISOString()
  };
  if (row.read_at) message.readAt = new Date(row.read_at).toISOString();
  if (row.attachment_id) {
    message.attachment = {
      id: row.attachment_id,
      name: row.attachment_name,
      mimeType: row.attachment_mime_type,
      size: row.attachment_size
    };
  }
  return message;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.client_id, m.sender, m.sender_name, m.text, m.created_at, m.read_at,
         a.id AS attachment_id, a.name AS attachment_name,
         a.mime_type AS attachment_mime_type, a.size AS attachment_size
  FROM messages m
  LEFT JOIN message_attachments a ON a.message_id = m.id`;

function createPostgresStore(connectionString) {
  const pool = new Pool({ connectionString });

  async function initialize(dataFile, attachmentDir) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundora_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        name_key text NOT NULL,
        password_hash text NOT NULL,
        password_salt text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_name_key_unique ON users (name_key);
      CREATE TABLE IF NOT EXISTS messages (
        id uuid PRIMARY KEY,
        client_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        sender text NOT NULL CHECK (sender IN ('client', 'staff')),
        sender_name text NOT NULL,
        text text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        read_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS messages_client_created_idx ON messages (client_id, created_at, id);
      CREATE TABLE IF NOT EXISTS message_attachments (
        id uuid PRIMARY KEY,
        message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
        name text NOT NULL,
        mime_type text NOT NULL,
        size integer NOT NULL CHECK (size >= 0),
        content bytea NOT NULL
      );
    `);

    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      await client.query("SELECT pg_advisory_xact_lock(704220261)");
      const migration = await client.query("SELECT version FROM fundora_migrations WHERE version = 1");
      if (migration.rowCount) {
        await client.query("COMMIT");
        transactionStarted = false;
        return;
      }

      const count = await client.query("SELECT count(*)::integer AS count FROM users");
      if (count.rows[0].count > 0 && fs.existsSync(dataFile)) {
        throw new Error("La base Fundora contient déjà des comptes et n'a pas été modifiée. Choisissez une base PostgreSQL vide ou confirmez la migration avant de relancer.");
      }
      if (count.rows[0].count === 0 && fs.existsSync(dataFile)) {
        const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
        if (!Array.isArray(data.users) || !Array.isArray(data.messages)) {
          throw new Error("Le fichier local Fundora ne peut pas être migré vers PostgreSQL.");
        }
        for (const user of data.users) {
          await client.query(
            `INSERT INTO users (id, name, name_key, password_hash, password_salt, created_at)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
            [
              user.id,
              user.name,
              user.name.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr"),
              user.passwordHash,
              user.passwordSalt,
              user.createdAt || new Date().toISOString()
            ]
          );
        }
        for (const message of data.messages) {
          await client.query(
            `INSERT INTO messages (id, client_id, sender, sender_name, text, created_at, read_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
            [
              message.id,
              message.clientId,
              message.sender,
              message.sender === "staff" ? "Fundora" : message.senderName,
              message.text || "",
              message.createdAt || new Date().toISOString(),
              message.readAt || null
            ]
          );
          if (message.attachment) {
            const filePath = path.join(attachmentDir, message.attachment.id);
            if (!fs.existsSync(filePath)) {
              throw new Error(`Pièce jointe introuvable pendant la migration : ${message.attachment.name}`);
            }
            const content = fs.readFileSync(filePath);
            await client.query(
              `INSERT INTO message_attachments (id, message_id, name, mime_type, size, content)
               VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
              [
                message.attachment.id,
                message.id,
                message.attachment.name,
                message.attachment.mimeType,
                content.length,
                content
              ]
            );
          }
        }
      }
      await client.query("INSERT INTO fundora_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING");
      await client.query("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    async initialize(dataFile, attachmentDir) {
      await initialize(dataFile, attachmentDir);
    },
    async getUserById(id) {
      const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },
    async getUserByName(nameKey) {
      const result = await pool.query("SELECT * FROM users WHERE name_key = $1", [nameKey]);
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },
    async createUser(user, normalizedName) {
      await pool.query(
        `INSERT INTO users (id, name, name_key, password_hash, password_salt, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, user.name, normalizedName, user.passwordHash, user.passwordSalt, user.createdAt]
      );
    },
    async getConversations() {
      const result = await pool.query(`
        SELECT u.id, u.name, u.created_at,
               m.text AS last_text, m.created_at AS last_created_at,
               a.name AS attachment_name
        FROM users u
        LEFT JOIN LATERAL (
          SELECT id, text, created_at
          FROM messages
          WHERE client_id = u.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) m ON true
        LEFT JOIN message_attachments a ON a.message_id = m.id
        ORDER BY COALESCE(m.created_at, u.created_at) DESC, u.id`);
      return result.rows.map((row) => ({
        client: { id: row.id, name: row.name },
        lastMessage: row.last_text || (row.attachment_name ? `Pièce jointe : ${row.attachment_name}` : ""),
        updatedAt: new Date(row.last_created_at || row.created_at).toISOString()
      }));
    },
    async getMessages(clientId, after) {
      const result = await pool.query(
        `${MESSAGE_SELECT}
         WHERE m.client_id = $1
           AND (
             $2::uuid IS NULL
             OR NOT EXISTS (SELECT 1 FROM messages cursor WHERE cursor.id = $2 AND cursor.client_id = $1)
             OR (m.created_at, m.id) > (
               SELECT cursor.created_at, cursor.id
               FROM messages cursor
               WHERE cursor.id = $2 AND cursor.client_id = $1
             )
           )
         ORDER BY m.created_at, m.id`,
        [clientId, after || null]
      );
      return result.rows.map(mapMessage);
    },
    async markMessagesRead(clientId, readerRole) {
      const result = await pool.query(
        `UPDATE messages
         SET read_at = now()
         WHERE client_id = $1 AND sender <> $2 AND read_at IS NULL
         RETURNING read_at`,
        [clientId, readerRole]
      );
      return {
        count: result.rowCount,
        readAt: result.rows.length ? new Date(result.rows[0].read_at).toISOString() : null
      };
    },
    async createMessage(message, uploadedFile) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO messages (id, client_id, sender, sender_name, text, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [message.id, message.clientId, message.sender, message.senderName, message.text, message.createdAt]
        );
        if (uploadedFile) {
          await client.query(
            `INSERT INTO message_attachments (id, message_id, name, mime_type, size, content)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              uploadedFile.id,
              message.id,
              uploadedFile.name,
              uploadedFile.mimeType,
              uploadedFile.size,
              uploadedFile.content
            ]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (uploadedFile) {
        message.attachment = {
          id: uploadedFile.id,
          name: uploadedFile.name,
          mimeType: uploadedFile.mimeType,
          size: uploadedFile.size
        };
      }
      return message;
    },
    async getAttachment(id) {
      const result = await pool.query(
        `SELECT a.id, a.name, a.mime_type, a.size, a.content, m.client_id
         FROM message_attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE a.id = $1`,
        [id]
      );
      if (!result.rows[0]) return null;
      const row = result.rows[0];
      return {
        clientId: row.client_id,
        attachment: {
          id: row.id,
          name: row.name,
          mimeType: row.mime_type,
          size: row.size
        },
        content: row.content
      };
    },
    async close() {
      await pool.end();
    }
  };
}

module.exports = { createPostgresStore };
