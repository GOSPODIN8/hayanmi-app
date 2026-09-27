// Hayanmi — работа с базой данных PostgreSQL.
import pg from "pg";

const url = process.env.DATABASE_URL;
export const pool = url
  ? new pg.Pool({
      connectionString: url,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
      max: 5,
    })
  : null;

export const hasDb = () => !!pool;

// Создаём таблицы при запуске, если их ещё нет
export async function migrate() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      first_name  TEXT,
      username    TEXT,
      profile     JSONB,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS food_entries (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      entry_date  DATE NOT NULL,
      meal        TEXT NOT NULL,
      name        TEXT NOT NULL,
      grams       REAL NOT NULL,
      kcal        REAL NOT NULL,
      protein     REAL NOT NULL,
      fat         REAL NOT NULL,
      carbs       REAL NOT NULL,
      source      TEXT NOT NULL DEFAULT 'photo',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS food_entries_user_date ON food_entries (user_id, entry_date);

    CREATE TABLE IF NOT EXISTS ai_usage (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ai_usage_user_kind ON ai_usage (user_id, kind);
  `);
  console.log("База данных готова");
}

export async function upsertUser(u) {
  await pool.query(
    `INSERT INTO users (telegram_id, first_name, username)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE
       SET first_name = EXCLUDED.first_name, username = EXCLUDED.username`,
    [u.id, u.first_name ?? null, u.username ?? null]
  );
}

export async function getProfile(userId) {
  const { rows } = await pool.query(`SELECT profile FROM users WHERE telegram_id = $1`, [userId]);
  return rows[0]?.profile ?? null;
}

export async function saveProfile(userId, profile) {
  await pool.query(
    `UPDATE users SET profile = $2, updated_at = now() WHERE telegram_id = $1`,
    [userId, JSON.stringify(profile)]
  );
}

const ENTRY_COLS = `id, to_char(entry_date, 'YYYY-MM-DD') AS date, meal, name, grams, kcal, protein, fat, carbs, source`;

export async function getEntries(userId, date) {
  const { rows } = await pool.query(
    `SELECT ${ENTRY_COLS} FROM food_entries
     WHERE user_id = $1 AND entry_date = $2
     ORDER BY created_at, id`,
    [userId, date]
  );
  return rows.map((r) => ({ ...r, id: String(r.id) }));
}

export async function addEntries(userId, date, meal, items, source) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const it of items) {
      await client.query(
        `INSERT INTO food_entries (user_id, entry_date, meal, name, grams, kcal, protein, fat, carbs, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [userId, date, meal, it.name, it.grams, it.kcal, it.protein, it.fat, it.carbs, source]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteEntry(userId, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM food_entries WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rowCount > 0;
}

export async function countUsage(userId, kind) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ai_usage WHERE user_id = $1 AND kind = $2`,
    [userId, kind]
  );
  return rows[0].n;
}

export async function addUsage(userId, kind) {
  await pool.query(`INSERT INTO ai_usage (user_id, kind) VALUES ($1, $2)`, [userId, kind]);
}
