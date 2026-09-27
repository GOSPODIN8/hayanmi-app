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

    ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_used_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT;

    ALTER TABLE users ADD COLUMN IF NOT EXISTS reminders JSONB;

    CREATE TABLE IF NOT EXISTS water_logs (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      entry_date  DATE NOT NULL,
      ml          INT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS water_logs_user_date ON water_logs (user_id, entry_date);

    CREATE TABLE IF NOT EXISTS reminder_log (
      user_id     BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      local_date  DATE NOT NULL,
      PRIMARY KEY (user_id, kind, local_date)
    );

    CREATE TABLE IF NOT EXISTS weight_logs (
      user_id     BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      entry_date  DATE NOT NULL,
      weight      REAL NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, entry_date)
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS coach TEXT;

    CREATE TABLE IF NOT EXISTS coach_messages (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      text        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS coach_messages_user ON coach_messages (user_id, id);

    CREATE TABLE IF NOT EXISTS pending_meals (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      items       JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id     BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
      plan        TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      recurring   BOOLEAN NOT NULL DEFAULT false,
      canceled    BOOLEAN NOT NULL DEFAULT false,
      charge_id   TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id          BIGSERIAL PRIMARY KEY,
      user_id     BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      plan        TEXT NOT NULL,
      amount      INT NOT NULL,
      charge_id   TEXT NOT NULL UNIQUE,
      recurring   BOOLEAN NOT NULL DEFAULT false,
      refunded    BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("База данных готова");
}

export async function upsertUser(u, timezone = null) {
  await pool.query(
    `INSERT INTO users (telegram_id, first_name, username, timezone)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE
       SET first_name = EXCLUDED.first_name,
           username = EXCLUDED.username,
           timezone = COALESCE(EXCLUDED.timezone, users.timezone)`,
    [u.id, u.first_name ?? null, u.username ?? null, timezone]
  );
}

export async function getTimezone(userId) {
  const { rows } = await pool.query(`SELECT timezone FROM users WHERE telegram_id = $1`, [userId]);
  return rows[0]?.timezone ?? null;
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

// ---------- Подписка ----------
export async function getPremium(userId) {
  const { rows } = await pool.query(
    `SELECT u.trial_used_at, s.plan, s.expires_at, s.recurring, s.canceled, s.charge_id,
            (s.expires_at > now()) AS active
     FROM users u LEFT JOIN subscriptions s ON s.user_id = u.telegram_id
     WHERE u.telegram_id = $1`,
    [userId]
  );
  const r = rows[0];
  if (!r) return { active: false, trialAvailable: true };
  return {
    active: !!r.active,
    plan: r.plan ?? null,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    recurring: !!r.recurring,
    canceled: !!r.canceled,
    chargeId: r.charge_id ?? null,
    trialAvailable: !r.trial_used_at && !r.plan,
  };
}

// Пробный период: один раз на пользователя и только если подписки ещё не было
export async function startTrial(userId, days) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT u.trial_used_at, s.user_id AS has_sub
       FROM users u LEFT JOIN subscriptions s ON s.user_id = u.telegram_id
       WHERE u.telegram_id = $1 FOR UPDATE OF u`,
      [userId]
    );
    if (!rows[0] || rows[0].trial_used_at || rows[0].has_sub) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`UPDATE users SET trial_used_at = now() WHERE telegram_id = $1`, [userId]);
    await client.query(
      `INSERT INTO subscriptions (user_id, plan, expires_at) VALUES ($1, 'trial', now() + make_interval(days => $2))`,
      [userId, days]
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Записываем оплату и продлеваем доступ. Повторное уведомление о той же оплате ничего не меняет.
export async function recordPayment({ userId, plan, amount, chargeId, recurring, expiresAt, days }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO payments (user_id, plan, amount, charge_id, recurring)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (charge_id) DO NOTHING RETURNING id`,
      [userId, plan, amount, chargeId, recurring]
    );
    if (ins.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `INSERT INTO subscriptions (user_id, plan, expires_at, recurring, canceled, charge_id)
       VALUES ($1, $2, COALESCE($3::timestamptz, now() + make_interval(days => $4)), $5, false, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         plan = EXCLUDED.plan,
         expires_at = CASE
           WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz
           ELSE GREATEST(subscriptions.expires_at, now()) + make_interval(days => $4)
         END,
         recurring = EXCLUDED.recurring,
         canceled = false,
         charge_id = EXCLUDED.charge_id,
         updated_at = now()`,
      [userId, plan, expiresAt ?? null, days, recurring, chargeId]
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function lastPayment(userId) {
  const { rows } = await pool.query(
    `SELECT id, plan, amount, charge_id FROM payments
     WHERE user_id = $1 AND refunded = false ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function markRefunded(paymentId, userId) {
  await pool.query(`UPDATE payments SET refunded = true WHERE id = $1`, [paymentId]);
  await pool.query(
    `UPDATE subscriptions SET expires_at = LEAST(expires_at, now()), canceled = true, updated_at = now() WHERE user_id = $1`,
    [userId]
  );
}

export async function markCanceled(userId) {
  await pool.query(`UPDATE subscriptions SET canceled = true, updated_at = now() WHERE user_id = $1`, [userId]);
}

// ---------- Распознанная в чате еда, ждущая выбора приёма пищи ----------
export async function createPending(userId, items) {
  await pool.query(`DELETE FROM pending_meals WHERE created_at < now() - interval '2 days'`);
  const { rows } = await pool.query(
    `INSERT INTO pending_meals (user_id, items) VALUES ($1, $2) RETURNING id`,
    [userId, JSON.stringify(items)]
  );
  return String(rows[0].id);
}

export async function getPending(userId, id) {
  const { rows } = await pool.query(
    `SELECT items FROM pending_meals WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0]?.items ?? null;
}

export async function deletePending(userId, id) {
  await pool.query(`DELETE FROM pending_meals WHERE id = $1 AND user_id = $2`, [id, userId]);
}

export async function sumKcal(userId, date) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(kcal), 0)::float AS kcal FROM food_entries WHERE user_id = $1 AND entry_date = $2`,
    [userId, date]
  );
  return rows[0].kcal;
}

// ---------- Вода ----------
export async function addWater(userId, date, ml) {
  await pool.query(`INSERT INTO water_logs (user_id, entry_date, ml) VALUES ($1, $2, $3)`, [userId, date, ml]);
}

export async function removeLastWater(userId, date) {
  await pool.query(
    `DELETE FROM water_logs WHERE id = (
       SELECT id FROM water_logs WHERE user_id = $1 AND entry_date = $2 ORDER BY created_at DESC, id DESC LIMIT 1
     )`,
    [userId, date]
  );
}

export async function waterTotal(userId, date) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(ml), 0)::int AS ml FROM water_logs WHERE user_id = $1 AND entry_date = $2`,
    [userId, date]
  );
  return rows[0].ml;
}

// ---------- Напоминания ----------
export async function getReminders(userId) {
  const { rows } = await pool.query(`SELECT reminders FROM users WHERE telegram_id = $1`, [userId]);
  return rows[0]?.reminders ?? null;
}

export async function saveReminders(userId, reminders) {
  await pool.query(`UPDATE users SET reminders = $2 WHERE telegram_id = $1`, [userId, JSON.stringify(reminders)]);
}

export async function listReminderUsers() {
  const { rows } = await pool.query(
    `SELECT telegram_id, timezone, reminders, profile FROM users
     WHERE profile IS NOT NULL AND COALESCE((reminders->>'blocked')::boolean, false) = false`
  );
  return rows;
}

export async function mealLogged(userId, date, meal) {
  const { rows } = await pool.query(
    `SELECT 1 FROM food_entries WHERE user_id = $1 AND entry_date = $2 AND meal = $3 LIMIT 1`,
    [userId, date, meal]
  );
  return rows.length > 0;
}

// true — если сегодня такое напоминание ещё не отправляли (и сразу отмечаем)
export async function claimReminder(userId, kind, date) {
  const { rowCount } = await pool.query(
    `INSERT INTO reminder_log (user_id, kind, local_date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [userId, kind, date]
  );
  return rowCount > 0;
}

export async function markBlocked(userId) {
  await pool.query(
    `UPDATE users SET reminders = COALESCE(reminders, '{}'::jsonb) || '{"blocked": true}'::jsonb WHERE telegram_id = $1`,
    [userId]
  );
}

export async function cleanupReminderLog() {
  await pool.query(`DELETE FROM reminder_log WHERE local_date < current_date - 7`);
}

// ---------- Прогресс ----------
export async function upsertWeight(userId, date, weight) {
  await pool.query(
    `INSERT INTO weight_logs (user_id, entry_date, weight) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, entry_date) DO UPDATE SET weight = EXCLUDED.weight, created_at = now()`,
    [userId, date, weight]
  );
}

export async function getWeights(userId, days = 180) {
  const { rows } = await pool.query(
    `SELECT to_char(entry_date, 'YYYY-MM-DD') AS date, weight FROM weight_logs
     WHERE user_id = $1 AND entry_date >= current_date - $2::int
     ORDER BY entry_date`,
    [userId, days]
  );
  return rows;
}

// Калории по дням за последние 7 дней (включая сегодня)
export async function caloriesWeek(userId, date) {
  const { rows } = await pool.query(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS date, COALESCE(sum(f.kcal), 0)::float AS kcal
     FROM generate_series($2::date - 6, $2::date, interval '1 day') AS d
     LEFT JOIN food_entries f ON f.user_id = $1 AND f.entry_date = d::date
     GROUP BY d ORDER BY d`,
    [userId, date]
  );
  return rows;
}

// Сколько дней подряд есть записи в дневнике (если сегодня пусто — считаем до вчера)
export async function streak(userId, date) {
  const { rows } = await pool.query(
    `SELECT DISTINCT to_char(entry_date, 'YYYY-MM-DD') AS d FROM food_entries
     WHERE user_id = $1 AND entry_date <= $2::date AND entry_date > $2::date - 400
     ORDER BY d DESC`,
    [userId, date]
  );
  const days = new Set(rows.map((r) => r.d));
  const cur = new Date(date + "T00:00:00Z");
  const iso = (d) => d.toISOString().slice(0, 10);
  if (!days.has(iso(cur))) cur.setUTCDate(cur.getUTCDate() - 1);
  let n = 0;
  while (days.has(iso(cur))) { n++; cur.setUTCDate(cur.getUTCDate() - 1); }
  return n;
}

// Сколько раз пользователь использовал ИИ за последние сутки
export async function countUsageDay(userId, kind) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM ai_usage WHERE user_id = $1 AND kind = $2 AND created_at > now() - interval '1 day'`,
    [userId, kind]
  );
  return rows[0].n;
}

// ---------- ИИ-коуч ----------
export async function getCoach(userId) {
  const { rows } = await pool.query(`SELECT coach FROM users WHERE telegram_id = $1`, [userId]);
  return rows[0]?.coach ?? null;
}

export async function setCoach(userId, coach) {
  await pool.query(`UPDATE users SET coach = $2 WHERE telegram_id = $1`, [userId, coach]);
}

export async function getCoachMessages(userId, limit = 40) {
  const { rows } = await pool.query(
    `SELECT role, text, created_at FROM (
       SELECT id, role, text, created_at FROM coach_messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2
     ) t ORDER BY id`,
    [userId, limit]
  );
  return rows.map((r) => ({ role: r.role, text: r.text, at: new Date(r.created_at).toISOString() }));
}

export async function addCoachMessages(userId, pairs) {
  for (const [role, text] of pairs) {
    await pool.query(`INSERT INTO coach_messages (user_id, role, text) VALUES ($1, $2, $3)`, [userId, role, text]);
  }
}

export async function clearCoachMessages(userId) {
  await pool.query(`DELETE FROM coach_messages WHERE user_id = $1`, [userId]);
}
