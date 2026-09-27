// Hayanmi — сервер: бот в Telegram + Mini App + API.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Bot, InlineKeyboard } from "grammy";
import * as db from "./db.js";
import { recognizeFood, hasGemini } from "./gemini.js";

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
// Railway показывает домен без https:// — добавляем сами.
const RAW_WEBAPP_URL = (process.env.WEBAPP_URL || "").trim();
const WEBAPP_URL = RAW_WEBAPP_URL
  ? "https://" + RAW_WEBAPP_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "")
  : "";
// Сколько фото можно распознать бесплатно (за всё время)
const FREE_PHOTO_LIMIT = Number(process.env.FREE_PHOTO_LIMIT ?? 3);
// Telegram ID админов через запятую — у них безлимит (для тестов)
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)
);

if (!BOT_TOKEN) {
  console.error("Нет переменной BOT_TOKEN. Добавьте её в Variables на Railway.");
  process.exit(1);
}
if (!db.hasDb()) console.warn("Нет DATABASE_URL — дневник и анкета на сервере работать не будут.");
if (!hasGemini()) console.warn("Нет GEMINI_API_KEY — распознавание фото работать не будет.");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Проверка, что запрос пришёл из Telegram ----------
function checkInitData(initData) {
  if (!initData || typeof initData !== "string") return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;

  try {
    return JSON.parse(params.get("user"));
  } catch {
    return null;
  }
}

// ---------- Веб-сервер ----------
const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true, db: db.hasDb(), ai: hasGemini() }));

app.post("/api/me", (req, res) => {
  const user = checkInitData(req.body?.initData);
  if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });
  res.json({ ok: true, user: { id: user.id, first_name: user.first_name } });
});

// Всё ниже требует входа через Telegram и базу данных
const api = express.Router();
api.use(async (req, res, next) => {
  const user = checkInitData(req.get("x-init-data"));
  if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (!db.hasDb()) return res.status(503).json({ ok: false, error: "no_db" });
  try {
    await db.upsertUser(user);
    req.user = user;
    next();
  } catch (e) {
    console.error("Ошибка базы:", e);
    res.status(500).json({ ok: false, error: "db_error" });
  }
});

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const MEALS = new Set(["breakfast", "lunch", "dinner", "snack"]);
const num = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
const isAdmin = (userId) => ADMIN_IDS.has(String(userId));

async function photoQuota(userId) {
  const used = await db.countUsage(userId, "photo");
  const unlimited = isAdmin(userId);
  return { used, limit: FREE_PHOTO_LIMIT, unlimited, left: unlimited ? null : Math.max(0, FREE_PHOTO_LIMIT - used) };
}

api.get("/state", async (req, res) => {
  try {
    const date = isDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
    const [profile, entries, quota] = await Promise.all([
      db.getProfile(req.user.id),
      db.getEntries(req.user.id, date),
      photoQuota(req.user.id),
    ]);
    res.json({ ok: true, profile, entries, quota });
  } catch (e) {
    console.error("state:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.post("/profile", async (req, res) => {
  const profile = req.body?.profile;
  if (!profile || typeof profile !== "object" || !profile.result || !profile.answers) {
    return res.status(400).json({ ok: false, error: "bad_profile" });
  }
  if (JSON.stringify(profile).length > 5000) return res.status(400).json({ ok: false, error: "too_big" });
  try {
    await db.saveProfile(req.user.id, profile);
    res.json({ ok: true });
  } catch (e) {
    console.error("profile:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.post("/recognize", async (req, res) => {
  if (!hasGemini()) return res.status(503).json({ ok: false, error: "no_ai" });
  const image = req.body?.image;
  const hint = typeof req.body?.hint === "string" ? req.body.hint.trim() : "";
  if (typeof image !== "string" || image.length < 100 || image.length > 7_000_000) {
    return res.status(400).json({ ok: false, error: "bad_image" });
  }
  try {
    const quota = await photoQuota(req.user.id);
    if (!quota.unlimited && quota.left <= 0) {
      return res.status(402).json({ ok: false, error: "limit", quota });
    }
    const result = await recognizeFood(image, hint);
    if (result.isFood) await db.addUsage(req.user.id, "photo");
    res.json({ ok: true, ...result, quota: await photoQuota(req.user.id) });
  } catch (e) {
    console.error("recognize:", e);
    res.status(502).json({ ok: false, error: "ai_error" });
  }
});

api.post("/entries", async (req, res) => {
  const { date, meal, items } = req.body || {};
  if (!isDate(date) || !MEALS.has(meal) || !Array.isArray(items) || items.length === 0 || items.length > 20) {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }
  const clean = items
    .filter((it) => it && typeof it.name === "string" && it.name.trim())
    .map((it) => ({
      name: it.name.trim().slice(0, 60),
      grams: num(it.grams, 0, 5000),
      kcal: num(it.kcal, 0, 20000),
      protein: num(it.protein, 0, 2000),
      fat: num(it.fat, 0, 2000),
      carbs: num(it.carbs, 0, 2000),
    }))
    .filter((it) => it.grams > 0);
  if (clean.length === 0) return res.status(400).json({ ok: false, error: "empty" });
  try {
    await db.addEntries(req.user.id, date, meal, clean, "photo");
    res.json({ ok: true, entries: await db.getEntries(req.user.id, date) });
  } catch (e) {
    console.error("entries:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.delete("/entries/:id", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ ok: false, error: "bad_id" });
  try {
    const ok = await db.deleteEntry(req.user.id, req.params.id);
    res.json({ ok });
  } catch (e) {
    console.error("delete:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.use("/api", api);

// ---------- Бот ----------
const bot = new Bot(BOT_TOKEN);

function openAppKeyboard() {
  return new InlineKeyboard().webApp("Открыть Hayanmi", WEBAPP_URL);
}

bot.command("start", async (ctx) => {
  if (!WEBAPP_URL) return ctx.reply("Приложение ещё настраивается. Загляните чуть позже.");
  await ctx.reply(
    "Привет! Я Hayanmi — считаю калории по фото.\n\n" +
      "Сфотографируй тарелку, и я покажу калории, белки, жиры и углеводы.",
    { reply_markup: openAppKeyboard() }
  );
});

// Узнать свой Telegram ID (нужен для ADMIN_IDS)
bot.command("myid", (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));

bot.on("message:photo", (ctx) =>
  ctx.reply("Распознавание фото прямо в чате появится скоро. Пока добавь фото в приложении.", {
    reply_markup: WEBAPP_URL ? openAppKeyboard() : undefined,
  })
);

bot.catch((err) => console.error("Ошибка бота:", err.error));

// ---------- Запуск ----------
async function main() {
  if (db.hasDb()) {
    try {
      await db.migrate();
    } catch (e) {
      console.error("Не удалось подготовить базу:", e);
    }
  }

  app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));

  await bot.api.setMyCommands([{ command: "start", description: "Открыть Hayanmi" }]);
  if (WEBAPP_URL) {
    await bot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "Hayanmi", web_app: { url: WEBAPP_URL } },
    });
  }
  await bot.start({
    drop_pending_updates: true,
    onStart: (me) => console.log(`Бот @${me.username} запущен`),
  });
}

main().catch((err) => {
  console.error("Не удалось запустить:", err);
  process.exit(1);
});
