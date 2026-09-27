// Hayanmi — сервер: бот в Telegram + Mini App + API.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Bot, InlineKeyboard } from "grammy";
import * as db from "./db.js";
import { recognizeFood, suggestRecipe, hasGemini } from "./gemini.js";
import { PERSONAS, DEFAULT_PERSONA, coachAccess, coachReply } from "./coach.js";

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
// Цены в Telegram Stars и пробный период
const PLANS = {
  month: { price: Number(process.env.PRICE_MONTH ?? 250), days: 30, recurring: true, title: "Hayanmi Премиум — месяц" },
  year: { price: Number(process.env.PRICE_YEAR ?? 1500), days: 365, recurring: false, title: "Hayanmi Премиум — год" },
};
const TRIAL_DAYS = 3;
const SUPPORT_CONTACT = process.env.SUPPORT_CONTACT || "";
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

// ---------- Часовой пояс пользователя ----------
const DEFAULT_TZ = process.env.DEFAULT_TZ || "Europe/Moscow";
function validTz(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
// Сегодняшняя дата у пользователя в формате ГГГГ-ММ-ДД
function localDate(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: validTz(tz) ? tz : DEFAULT_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
const fmtNum = (n) => Math.round(n).toLocaleString("ru-RU");
const fmtL = (ml) => (ml / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 });

// Минуты от начала суток у пользователя
function localMinutes(tz) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: validTz(tz) ? tz : DEFAULT_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour").value);
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}
// Время у пользователя в виде «19:54»
function localTimeText(tz) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: validTz(tz) ? tz : DEFAULT_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date());
}
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// ---------- Вода и напоминания: настройки по умолчанию ----------
function waterGoal(profile) {
  const w = Number(profile?.answers?.weight) || 70;
  return Math.min(3500, Math.max(1500, Math.round((w * 30) / 100) * 100));
}

const DEFAULT_REMINDERS = {
  meals: true,
  water: true,
  times: { breakfast: "09:00", lunch: "13:30", dinner: "19:00" },
};
const isTime = (t) => typeof t === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);

function normalizeReminders(r) {
  const src = r && typeof r === "object" ? r : {};
  const times = { ...DEFAULT_REMINDERS.times };
  for (const k of Object.keys(times)) if (isTime(src.times?.[k])) times[k] = src.times[k];
  return {
    meals: typeof src.meals === "boolean" ? src.meals : DEFAULT_REMINDERS.meals,
    water: typeof src.water === "boolean" ? src.water : DEFAULT_REMINDERS.water,
    times,
  };
}

// Когда проверяем воду и какая доля нормы должна быть выпита к этому времени
const WATER_CHECKS = [["11:00", 0.25], ["15:00", 0.5], ["18:00", 0.75]];

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
    const tz = req.get("x-timezone");
    await db.upsertUser(user, validTz(tz) ? tz : null);
    req.user = user;
    req.tz = validTz(tz) ? tz : await db.getTimezone(user.id);
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

async function photoQuota(userId, premium) {
  const used = await db.countUsage(userId, "photo");
  const prem = premium ?? (await db.getPremium(userId));
  const unlimited = isAdmin(userId) || prem.active;
  return { used, limit: FREE_PHOTO_LIMIT, unlimited, left: unlimited ? null : Math.max(0, FREE_PHOTO_LIMIT - used) };
}

api.get("/state", async (req, res) => {
  try {
    const date = isDate(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10);
    const premium = await db.getPremium(req.user.id);
    const [profile, entries, quota, waterMl, rawReminders] = await Promise.all([
      db.getProfile(req.user.id),
      db.getEntries(req.user.id, date),
      photoQuota(req.user.id, premium),
      db.waterTotal(req.user.id, date),
      db.getReminders(req.user.id),
    ]);
    const reminders = normalizeReminders(rawReminders);
    // Пользователь снова открыл приложение — значит, бот не заблокирован
    if (rawReminders?.blocked) await db.saveReminders(req.user.id, reminders);
    res.json({
      ok: true, profile, entries, quota,
      premium: publicPremium(premium), prices: publicPrices(),
      water: { ml: waterMl, goal: waterGoal(profile) },
      reminders,
      access: { premium: premium.active || isAdmin(req.user.id), admin: isAdmin(req.user.id) },
    });
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
    const w = Number(profile.answers?.weight);
    if (w >= 30 && w <= 300) await db.upsertWeight(req.user.id, localDate(req.tz), w);
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
  const { date, meal, items, pendingId } = req.body || {};
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
    const source = ["photo", "recipe", "ai_recipe"].includes(req.body.source) ? req.body.source : "photo";
    await db.addEntries(req.user.id, date, meal, clean, source);
    if (typeof pendingId === "string" && /^\d+$/.test(pendingId)) await db.deletePending(req.user.id, pendingId);
    res.json({ ok: true, entries: await db.getEntries(req.user.id, date) });
  } catch (e) {
    console.error("entries:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.post("/water", async (req, res) => {
  const { date, delta } = req.body || {};
  const d = Number(delta);
  if (!isDate(date) || !Number.isInteger(d) || d === 0 || Math.abs(d) > 1000) {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }
  try {
    if (d > 0) await db.addWater(req.user.id, date, d);
    else await db.removeLastWater(req.user.id, date);
    res.json({ ok: true, ml: await db.waterTotal(req.user.id, date) });
  } catch (e) {
    console.error("water:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.post("/weight", async (req, res) => {
  const { date, weight } = req.body || {};
  const w = Math.round(Number(weight) * 10) / 10;
  if (!isDate(date) || !(w >= 30 && w <= 300)) return res.status(400).json({ ok: false, error: "bad_request" });
  try {
    await db.upsertWeight(req.user.id, date, w);
    res.json({ ok: true });
  } catch (e) {
    console.error("weight:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.get("/progress", async (req, res) => {
  const date = isDate(req.query.date) ? req.query.date : localDate(req.tz);
  try {
    const [weights, week, streakDays, profile] = await Promise.all([
      db.getWeights(req.user.id),
      db.caloriesWeek(req.user.id, date),
      db.streak(req.user.id, date),
      db.getProfile(req.user.id),
    ]);
    // У тех, кто прошёл анкету до появления прогресса, берём вес из анкеты
    if (!weights.length && profile?.answers?.weight) {
      weights.push({ date: String(profile.savedAt || "").slice(0, 10) || date, weight: Number(profile.answers.weight) });
    }
    res.json({ ok: true, weights, week, streak: streakDays });
  } catch (e) {
    console.error("progress:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- ИИ-повар ----------
const RECIPE_DAILY_LIMIT = Number(process.env.RECIPE_DAILY_LIMIT ?? 15);
const MEAL_SHARE = { breakfast: 0.25, lunch: 0.35, dinner: 0.3, snack: 0.12 };
const MEAL_RU = { breakfast: "завтрак", lunch: "обед", dinner: "ужин", snack: "перекус" };

api.post("/recipes/suggest", async (req, res) => {
  if (!hasGemini()) return res.status(503).json({ ok: false, error: "no_ai" });
  const { date, meal, wishes, avoid } = req.body || {};
  if (!isDate(date) || !MEALS.has(meal)) return res.status(400).json({ ok: false, error: "bad_request" });
  try {
    const premium = await db.getPremium(req.user.id);
    if (!premium.active && !isAdmin(req.user.id)) return res.status(402).json({ ok: false, error: "premium" });
    if ((await db.countUsageDay(req.user.id, "recipe")) >= RECIPE_DAILY_LIMIT) {
      return res.status(429).json({ ok: false, error: "daily_limit" });
    }
    const profile = await db.getProfile(req.user.id);
    if (!profile?.result) return res.status(400).json({ ok: false, error: "no_profile" });

    // Сколько осталось на сегодня и сколько разумно отдать на этот приём пищи
    const entries = await db.getEntries(req.user.id, date);
    const eatenKcal = entries.reduce((s, e) => s + e.kcal, 0);
    const eatenP = entries.reduce((s, e) => s + e.protein, 0);
    const leftKcal = profile.result.kcal - eatenKcal;
    const leftP = profile.result.protein - eatenP;
    const share = Math.round(profile.result.kcal * MEAL_SHARE[meal] * 1.15);
    const targetKcal = Math.max(150, Math.min(share, leftKcal > 0 ? leftKcal : 150));
    const minProtein = Math.max(5, Math.min(45, Math.round(leftP > 0 ? Math.min(leftP, targetKcal * 0.3 / 4) : 10)));

    const recipe = await suggestRecipe({
      meal: MEAL_RU[meal],
      targetKcal: Math.round(targetKcal / 10) * 10,
      minProtein,
      wishes: typeof wishes === "string" ? wishes.trim() : "",
      avoid: typeof avoid === "string" ? avoid : "",
    });
    await db.addUsage(req.user.id, "recipe");
    res.json({ ok: true, recipe, target: { kcal: Math.round(targetKcal), leftKcal: Math.round(leftKcal) } });
  } catch (e) {
    console.error("recipe:", e);
    res.status(502).json({ ok: false, error: "ai_error" });
  }
});

// ---------- ИИ-коуч ----------
api.get("/coach", async (req, res) => {
  try {
    const premium = await db.getPremium(req.user.id);
    const [persona, messages, access] = await Promise.all([
      db.getCoach(req.user.id),
      db.getCoachMessages(req.user.id, 40),
      coachAccess(req.user.id, premium.active || isAdmin(req.user.id)),
    ]);
    res.json({
      ok: true, persona: persona || DEFAULT_PERSONA, messages, freeLeft: access.freeLeft,
      personas: Object.fromEntries(Object.entries(PERSONAS).map(([k, v]) => [k, v.name])),
    });
  } catch (e) {
    console.error("coach:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.post("/coach/send", async (req, res) => {
  if (!hasGemini()) return res.status(503).json({ ok: false, error: "no_ai" });
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  const date = isDate(req.body?.date) ? req.body.date : localDate(req.tz);
  if (!text || text.length > 1000) return res.status(400).json({ ok: false, error: "bad_text" });
  try {
    const premium = await db.getPremium(req.user.id);
    const access = await coachAccess(req.user.id, premium.active || isAdmin(req.user.id));
    if (!access.ok) return res.status(access.reason === "premium" ? 402 : 429).json({ ok: false, error: access.reason });
    const { reply } = await coachReply(req.user.id, text, date, localTimeText(req.tz));
    const after = await coachAccess(req.user.id, premium.active || isAdmin(req.user.id));
    res.json({ ok: true, reply, freeLeft: after.freeLeft });
  } catch (e) {
    console.error("coach send:", e);
    res.status(502).json({ ok: false, error: "ai_error" });
  }
});

api.post("/coach/persona", async (req, res) => {
  const p = req.body?.persona;
  if (!PERSONAS[p]) return res.status(400).json({ ok: false, error: "bad_persona" });
  try {
    await db.setCoach(req.user.id, p);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.post("/coach/clear", async (req, res) => {
  try {
    await db.clearCoachMessages(req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ---------- Админ-панель (только ADMIN_IDS) ----------
const STAR_USD = Number(process.env.STAR_USD ?? 0.013); // примерный курс вывода звёзд
const adminOnly = (req, res, next) =>
  isAdmin(req.user.id) ? next() : res.status(403).json({ ok: false, error: "forbidden" });

api.get("/admin/stats", adminOnly, async (req, res) => {
  try {
    const [stats, newUsers, payments] = await Promise.all([db.adminStats(), db.adminNewUsers(14), db.adminPayments(15)]);
    res.json({ ok: true, stats, newUsers, payments, starUsd: STAR_USD });
  } catch (e) {
    console.error("admin stats:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.get("/admin/user", adminOnly, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q || q.length > 64) return res.status(400).json({ ok: false, error: "bad_query" });
  try {
    const user = await db.adminFindUser(q);
    if (!user) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, user });
  } catch (e) {
    console.error("admin user:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.post("/admin/grant", adminOnly, async (req, res) => {
  const userId = String(req.body?.userId || "");
  const days = Number(req.body?.days);
  if (!/^\d+$/.test(userId) || !Number.isInteger(days) || days < 1 || days > 365) {
    return res.status(400).json({ ok: false, error: "bad_request" });
  }
  try {
    if (!(await db.adminFindUser(userId))) return res.status(404).json({ ok: false, error: "not_found" });
    await db.adminGrant(userId, days);
    if (req.body?.notify !== false) {
      await bot.api.sendMessage(Number(userId),
        `🎁 Тебе подарили Hayanmi Премиум на ${days} дн.! Распознавание фото, ИИ-коуч и все рецепты — без ограничений.`,
        WEBAPP_URL ? { reply_markup: openAppKeyboard() } : undefined
      ).catch(() => {});
    }
    res.json({ ok: true, user: await db.adminFindUser(userId) });
  } catch (e) {
    console.error("admin grant:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.post("/admin/refund", adminOnly, async (req, res) => {
  const userId = String(req.body?.userId || "");
  if (!/^\d+$/.test(userId)) return res.status(400).json({ ok: false, error: "bad_request" });
  try {
    const r = await refundLastPayment(userId);
    if (!r.ok) return res.status(400).json({ ok: false, error: "no_payments" });
    res.json({ ok: true, amount: r.amount, user: await db.adminFindUser(userId) });
  } catch (e) {
    console.error("admin refund:", e);
    res.status(500).json({ ok: false, error: "refund_failed", message: e.description || e.message });
  }
});

api.post("/reminders", async (req, res) => {
  try {
    const reminders = normalizeReminders(req.body?.reminders);
    await db.saveReminders(req.user.id, reminders);
    res.json({ ok: true, reminders });
  } catch (e) {
    console.error("reminders:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Еда, распознанная в чате: открыть в приложении, чтобы поправить граммы
api.get("/pending/:id", async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ ok: false, error: "bad_id" });
  try {
    const items = await db.getPending(req.user.id, req.params.id);
    if (!items) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, items });
  } catch (e) {
    console.error("pending:", e);
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

// ---------- Подписка ----------
function publicPremium(p) {
  const { chargeId, ...rest } = p;
  return rest;
}
function publicPrices() {
  return { month: PLANS.month.price, year: PLANS.year.price, trialDays: TRIAL_DAYS };
}

api.post("/invoice", async (req, res) => {
  const planId = req.body?.plan;
  const plan = PLANS[planId];
  if (!plan) return res.status(400).json({ ok: false, error: "bad_plan" });
  try {
    const params = {
      title: plan.title,
      description: "Безлимитное распознавание еды по фото и все премиум-функции Hayanmi.",
      payload: `${planId}:${req.user.id}`,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: plan.title, amount: plan.price }],
    };
    if (plan.recurring) params.subscription_period = 2592000; // 30 дней — единственный период, который разрешает Telegram
    const link = await bot.api.raw.createInvoiceLink(params);
    res.json({ ok: true, link });
  } catch (e) {
    console.error("invoice:", e);
    res.status(500).json({ ok: false, error: "invoice_error" });
  }
});

api.post("/trial", async (req, res) => {
  try {
    const ok = await db.startTrial(req.user.id, TRIAL_DAYS);
    if (!ok) return res.status(409).json({ ok: false, error: "trial_used" });
    res.json({ ok: true, premium: publicPremium(await db.getPremium(req.user.id)) });
  } catch (e) {
    console.error("trial:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

api.post("/cancel", async (req, res) => {
  try {
    const p = await db.getPremium(req.user.id);
    if (!p.recurring || !p.chargeId || p.canceled) return res.status(400).json({ ok: false, error: "nothing_to_cancel" });
    await bot.api.raw.editUserStarSubscription({
      user_id: req.user.id,
      telegram_payment_charge_id: p.chargeId,
      is_canceled: true,
    });
    await db.markCanceled(req.user.id);
    res.json({ ok: true, premium: publicPremium(await db.getPremium(req.user.id)) });
  } catch (e) {
    console.error("cancel:", e);
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
  if (db.hasDb()) {
    try {
      await db.upsertUser(ctx.from);
      const r = await db.getReminders(ctx.from.id);
      if (r?.blocked) await db.saveReminders(ctx.from.id, normalizeReminders(r));
    } catch (e) { console.warn("start:", e.message); }
  }
  if (!WEBAPP_URL) return ctx.reply("Приложение ещё настраивается. Загляните чуть позже.");
  await ctx.reply(
    "Привет! Я Hayanmi — считаю калории по фото.\n\n" +
      "Сфотографируй тарелку, и я покажу калории, белки, жиры и углеводы.",
    { reply_markup: openAppKeyboard() }
  );
});

// Узнать свой Telegram ID (нужен для ADMIN_IDS)
bot.command("myid", (ctx) => ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`));

// ---------- Фото еды прямо в чат ----------
const MEAL_NAMES = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин", snack: "Перекус" };

function itemTotals(it) {
  const k = it.grams / 100;
  return {
    kcal: it.per100.kcal * k, protein: it.per100.protein * k,
    fat: it.per100.fat * k, carbs: it.per100.carbs * k,
  };
}

function mealKeyboard(pendingId) {
  const kb = new InlineKeyboard()
    .text("Завтрак", `add:${pendingId}:breakfast`).text("Обед", `add:${pendingId}:lunch`).row()
    .text("Ужин", `add:${pendingId}:dinner`).text("Перекус", `add:${pendingId}:snack`).row();
  if (WEBAPP_URL) kb.webApp("✏️ Изменить граммы", `${WEBAPP_URL}/?pending=${pendingId}`).row();
  return kb.text("✖️ Не добавлять", `cancel:${pendingId}`);
}

bot.on("message:photo", async (ctx) => {
  const userId = ctx.from.id;
  const openKb = WEBAPP_URL ? { reply_markup: openAppKeyboard() } : {};
  if (!db.hasDb() || !hasGemini()) return ctx.reply("Распознавание временно недоступно. Попробуйте чуть позже.");

  try {
    await db.upsertUser(ctx.from);
    const profile = await db.getProfile(userId);
    if (!profile) {
      return ctx.reply("Сначала ответь на пару вопросов в приложении — я рассчитаю твою норму калорий. Потом присылай фото еды сюда.", openKb);
    }
    const quota = await photoQuota(userId);
    if (!quota.unlimited && quota.left <= 0) {
      return ctx.reply(
        "Бесплатные распознавания закончились. С Hayanmi Премиум — без ограничений: открой приложение и нажми «Премиум».",
        openKb
      );
    }

    await ctx.replyWithChatAction("typing");
    const status = await ctx.reply("🔍 Распознаю еду…");

    // Берём самую крупную версию фото не больше 1600 px
    const sizes = ctx.message.photo;
    const pick = [...sizes].reverse().find((p) => Math.max(p.width, p.height) <= 1600) || sizes[0];
    const file = await ctx.api.getFile(pick.file_id);
    const imgRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!imgRes.ok) throw new Error("Не удалось скачать фото: " + imgRes.status);
    const base64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

    const hint = (ctx.message.caption || "").trim();
    const result = await recognizeFood(base64, hint);

    if (!result.isFood) {
      return ctx.api.editMessageText(ctx.chat.id, status.message_id,
        "Не вижу еды на фото 🤔 Попробуй снять тарелку сверху при хорошем свете. Эта попытка не потратила бесплатные распознавания.");
    }
    await db.addUsage(userId, "photo");
    const pendingId = await db.createPending(userId, result.items);

    let total = { kcal: 0, protein: 0, fat: 0, carbs: 0 };
    const lines = result.items.map((it) => {
      const t = itemTotals(it);
      total = { kcal: total.kcal + t.kcal, protein: total.protein + t.protein, fat: total.fat + t.fat, carbs: total.carbs + t.carbs };
      return `• ${it.name} — ${fmtNum(it.grams)} г · ${fmtNum(t.kcal)} ккал`;
    });
    const left = quota.unlimited ? "" : `\n\nБесплатных распознаваний осталось: ${Math.max(0, quota.left - 1)}`;
    await ctx.api.editMessageText(
      ctx.chat.id, status.message_id,
      `🍽 Вот что я вижу:\n\n${lines.join("\n")}\n\n` +
        `Итого: ${fmtNum(total.kcal)} ккал · Б ${fmtNum(total.protein)} · Ж ${fmtNum(total.fat)} · У ${fmtNum(total.carbs)}` +
        `\n\nКуда добавить?${left}`,
      { reply_markup: mealKeyboard(pendingId) }
    );
  } catch (e) {
    console.error("chat photo:", e);
    await ctx.reply("Не получилось распознать фото. Попробуй ещё раз через минуту.").catch(() => {});
  }
});

bot.on("message:document", (ctx) => {
  if (ctx.message.document.mime_type?.startsWith("image/")) {
    return ctx.reply("Отправь, пожалуйста, как обычное фото (не файлом) — так я смогу его распознать.");
  }
});

bot.callbackQuery(/^add:(\d+):(breakfast|lunch|dinner|snack)$/, async (ctx) => {
  const [, pendingId, meal] = ctx.match;
  const userId = ctx.from.id;
  try {
    const items = await db.getPending(userId, pendingId);
    if (!items) {
      await ctx.answerCallbackQuery({ text: "Уже добавлено или устарело" });
      return ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    }
    const tz = await db.getTimezone(userId);
    const date = localDate(tz);
    const r1 = (v) => Math.round(v * 10) / 10;
    const entries = items.map((it) => {
      const t = itemTotals(it);
      return { name: it.name, grams: it.grams, kcal: Math.round(t.kcal), protein: r1(t.protein), fat: r1(t.fat), carbs: r1(t.carbs) };
    });
    await db.addEntries(userId, date, meal, entries, "chat");
    await db.deletePending(userId, pendingId);

    const added = entries.reduce((s, e) => s + e.kcal, 0);
    const profile = await db.getProfile(userId);
    const eaten = await db.sumKcal(userId, date);
    let tail = "";
    if (profile?.result?.kcal) {
      const rest = profile.result.kcal - eaten;
      tail = rest >= 0
        ? `\nОсталось на сегодня: ${fmtNum(rest)} ккал`
        : `\nСегодня уже ${fmtNum(-rest)} ккал сверх нормы`;
    }
    await ctx.answerCallbackQuery({ text: "Добавлено ✅" });
    await ctx.editMessageText(
      `✅ Добавлено в «${MEAL_NAMES[meal]}»: ${fmtNum(added)} ккал\n` +
        entries.map((e) => `• ${e.name} — ${fmtNum(e.grams)} г`).join("\n") + tail,
      { reply_markup: WEBAPP_URL ? openAppKeyboard() : undefined }
    );
  } catch (e) {
    console.error("add from chat:", e);
    await ctx.answerCallbackQuery({ text: "Не получилось, попробуй ещё раз" }).catch(() => {});
  }
});

bot.callbackQuery(/^cancel:(\d+)$/, async (ctx) => {
  try {
    await db.deletePending(ctx.from.id, ctx.match[1]);
    await ctx.answerCallbackQuery({ text: "Не добавляю" });
    await ctx.editMessageText("Окей, не добавляю в дневник.");
  } catch (e) {
    await ctx.answerCallbackQuery().catch(() => {});
  }
});

// Кнопка «+250 мл» в напоминании о воде
bot.callbackQuery(/^water:(\d{2,4})$/, async (ctx) => {
  const userId = ctx.from.id;
  try {
    const ml = Math.min(1000, Number(ctx.match[1]));
    const date = localDate(await db.getTimezone(userId));
    await db.addWater(userId, date, ml);
    const total = await db.waterTotal(userId, date);
    const goal = waterGoal(await db.getProfile(userId));
    await ctx.answerCallbackQuery({ text: `+${ml} мл 💧` });
    await ctx.editMessageText(
      `💧 Записал +${ml} мл. Сегодня: ${fmtL(total)} из ${fmtL(goal)} л` + (total >= goal ? "\nНорма воды выполнена 🎉" : ""),
      { reply_markup: new InlineKeyboard().text("+250 мл", "water:250") }
    );
  } catch (e) {
    console.error("water cb:", e);
    await ctx.answerCallbackQuery({ text: "Не получилось, попробуй ещё раз" }).catch(() => {});
  }
});

// ---------- Планировщик напоминаний: раз в минуту ----------
const MEAL_REMINDER_TEXT = {
  breakfast: "☀️ Доброе утро! Не забудь записать завтрак — просто пришли мне фото тарелки.",
  lunch: "🍽 Время обеда. Сфотографируй, что ешь, и пришли сюда — посчитаю калории.",
  dinner: "🌙 Ужин уже был? Пришли фото — добавлю в дневник.",
};
const REMINDER_WINDOW_MIN = 15; // если сервер перезапускался, напомним в течение 15 минут

async function sendReminder(userId, text, keyboard) {
  try {
    await bot.api.sendMessage(userId, text, keyboard ? { reply_markup: keyboard } : undefined);
  } catch (e) {
    if (e.error_code === 403) await db.markBlocked(userId); // бот заблокирован — больше не пишем
    else console.warn("Напоминание не отправлено:", userId, e.description || e.message);
  }
}

let ticking = false;
async function reminderTick() {
  if (ticking || !db.hasDb()) return;
  ticking = true;
  try {
    const users = await db.listReminderUsers();
    for (const u of users) {
      const r = normalizeReminders(u.reminders);
      if (!r.meals && !r.water) continue;
      const now = localMinutes(u.timezone);
      const date = localDate(u.timezone);
      const due = (t) => now >= toMin(t) && now < toMin(t) + REMINDER_WINDOW_MIN;

      if (r.meals) {
        for (const [meal, time] of Object.entries(r.times)) {
          if (!due(time)) continue;
          if (!(await db.claimReminder(u.telegram_id, meal, date))) continue;
          if (await db.mealLogged(u.telegram_id, date, meal)) continue;
          await sendReminder(u.telegram_id, MEAL_REMINDER_TEXT[meal], WEBAPP_URL ? openAppKeyboard() : null);
        }
      }

      if (r.water) {
        for (const [time, share] of WATER_CHECKS) {
          if (!due(time)) continue;
          if (!(await db.claimReminder(u.telegram_id, "water_" + time, date))) continue;
          const goal = waterGoal(u.profile);
          const total = await db.waterTotal(u.telegram_id, date);
          if (total >= goal * share) continue;
          await sendReminder(
            u.telegram_id,
            `💧 Сегодня выпито ${fmtL(total)} из ${fmtL(goal)} л. Самое время для стакана воды!`,
            new InlineKeyboard().text("+250 мл", "water:250")
          );
        }
      }
    }
  } catch (e) {
    console.error("Ошибка напоминаний:", e);
  } finally {
    ticking = false;
  }
}

// Проверка перед оплатой: Telegram ждёт ответ до 10 секунд
bot.on("pre_checkout_query", async (ctx) => {
  const q = ctx.preCheckoutQuery;
  const [planId, userId] = String(q.invoice_payload).split(":");
  const plan = PLANS[planId];
  const valid = plan && q.currency === "XTR" && q.total_amount === plan.price && String(q.from.id) === userId;
  if (valid) return ctx.answerPreCheckoutQuery(true);
  console.warn("Отклонён платёж:", q.invoice_payload, q.total_amount);
  return ctx.answerPreCheckoutQuery(false, { error_message: "Цена изменилась. Откройте оплату заново в приложении." });
});

bot.on("message:successful_payment", async (ctx) => {
  const p = ctx.message.successful_payment;
  const [planId] = String(p.invoice_payload).split(":");
  const plan = PLANS[planId];
  if (!plan || !db.hasDb()) {
    console.error("Оплата без тарифа или без базы:", p);
    return;
  }
  try {
    await db.upsertUser(ctx.from);
    const added = await db.recordPayment({
      userId: ctx.from.id,
      plan: planId,
      amount: p.total_amount,
      chargeId: p.telegram_payment_charge_id,
      recurring: !!(p.is_recurring || plan.recurring),
      expiresAt: p.subscription_expiration_date ? new Date(p.subscription_expiration_date * 1000).toISOString() : null,
      days: plan.days,
    });
    if (!added) return;
    const prem = await db.getPremium(ctx.from.id);
    const until = new Date(prem.expiresAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
    const renew = p.is_recurring && !p.is_first_recurring;
    await ctx.reply(
      (renew ? "Подписка продлена ✅\n" : "Спасибо! Hayanmi Премиум активирован ✅\n") +
        `Доступ до ${until}.`,
      { reply_markup: WEBAPP_URL ? openAppKeyboard() : undefined }
    );
  } catch (e) {
    console.error("Ошибка записи оплаты:", e, p);
    await ctx.reply("Оплата получена, но что-то пошло не так при активации. Напишите /paysupport — мы всё исправим.");
  }
});

bot.command("coach", async (ctx) => {
  const kb = new InlineKeyboard();
  Object.entries(PERSONAS).forEach(([id, p], i) => { kb.text(p.name, `coach:${id}`); if (i % 2) kb.row(); });
  await ctx.reply("Просто напиши мне вопрос о питании — отвечу как твой коуч. Выбери характер коуча:", { reply_markup: kb });
});

bot.callbackQuery(/^coach:(\w+)$/, async (ctx) => {
  const id = ctx.match[1];
  if (!PERSONAS[id] || !db.hasDb()) return ctx.answerCallbackQuery();
  await db.upsertUser(ctx.from);
  await db.setCoach(ctx.from.id, id);
  await ctx.answerCallbackQuery({ text: `Твой коуч: ${PERSONAS[id].name}` });
  await ctx.editMessageText(`Твой коуч теперь — ${PERSONAS[id].name}. Задавай вопросы прямо здесь, в чате.`);
});

bot.command("paysupport", (ctx) =>
  ctx.reply(
    "Вопросы по оплате Hayanmi Премиум:\n\n" +
      "• Отменить автопродление можно в приложении: Профиль → Подписка.\n" +
      "• Если оплата прошла, а Премиум не включился, или нужен возврат — напишите нам" +
      (SUPPORT_CONTACT ? `: ${SUPPORT_CONTACT}` : " в ответ на это сообщение.") +
      `\n\nВаш ID для обращения: ${ctx.from.id}`
  )
);

bot.command("terms", (ctx) =>
  ctx.reply(
    "Условия Hayanmi Премиум\n\n" +
      `1. Месяц — ${PLANS.month.price} Stars, продлевается автоматически каждые 30 дней, пока вы не отмените автопродление.\n` +
      `2. Год — ${PLANS.year.price} Stars, разовая оплата на 365 дней, без автопродления.\n` +
      `3. Пробный период — ${TRIAL_DAYS} дня, один раз, без списания.\n` +
      "4. Hayanmi не является медицинским изделием и не заменяет консультацию врача. Расчёты калорий — ориентир.\n" +
      "5. Вопросы и возвраты — через /paysupport."
  )
);

// Возврат последней оплаты пользователю (только для админов): /refund 123456789
// Возврат последней оплаты пользователю + отключение Премиума и автопродления
async function refundLastPayment(userId) {
  const pay = await db.lastPayment(userId);
  if (!pay) return { ok: false, error: "Нет оплат для возврата" };
  await bot.api.raw.refundStarPayment({ user_id: Number(userId), telegram_payment_charge_id: pay.charge_id });
  const prem = await db.getPremium(userId);
  if (prem.recurring && prem.chargeId && !prem.canceled) {
    await bot.api.raw
      .editUserStarSubscription({ user_id: Number(userId), telegram_payment_charge_id: prem.chargeId, is_canceled: true })
      .catch((e) => console.warn("Не удалось отменить автопродление:", e.description || e));
  }
  await db.markRefunded(pay.id, userId);
  return { ok: true, amount: pay.amount };
}

// /refund 123456789 — только для админов
bot.command("refund", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const userId = ctx.match.trim();
  if (!/^\d+$/.test(userId)) return ctx.reply("Формат: /refund <Telegram ID пользователя>");
  try {
    const r = await refundLastPayment(userId);
    await ctx.reply(r.ok ? `Возвращено ${r.amount} Stars пользователю ${userId}. Премиум отключён.` : r.error);
  } catch (e) {
    console.error("refund:", e);
    await ctx.reply("Не получилось: " + (e.description || e.message));
  }
});

// /stats — короткая сводка для админов
bot.command("stats", async (ctx) => {
  if (!isAdmin(ctx.from.id) || !db.hasDb()) return;
  try {
    const st = await db.adminStats();
    await ctx.reply(
      `📊 Hayanmi\n\n` +
        `Пользователи: ${st.users.total} (сегодня +${st.users.day}, за неделю +${st.users.week})\n` +
        `Прошли анкету: ${st.users.onboarded}\n` +
        `Активны: сегодня ${st.active.day}, за неделю ${st.active.week}\n\n` +
        `Платные подписки: ${st.subs.paid} (автопродление у ${st.subs.renewing})\n` +
        `Пробный период: ${st.subs.trials}, подарки: ${st.subs.gifts}\n` +
        `Выручка: ${fmtNum(st.money.month)} ⭐ за 30 дней, ${fmtNum(st.money.total)} ⭐ всего\n\n` +
        `ИИ за сутки: фото ${st.aiDay.photo || 0}, рецепты ${st.aiDay.recipe || 0}, коуч ${st.aiDay.coach || 0}`
    );
  } catch (e) {
    console.error("stats:", e);
    await ctx.reply("Не получилось собрать статистику.");
  }
});

// ---------- Коуч прямо в чате: любое текстовое сообщение (не команда) ----------
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) return;
  const userId = ctx.from.id;
  const openKb = WEBAPP_URL ? { reply_markup: openAppKeyboard() } : {};
  if (!db.hasDb() || !hasGemini()) return ctx.reply("Коуч временно недоступен. Попробуй чуть позже.");
  try {
    await db.upsertUser(ctx.from);
    if (!(await db.getProfile(userId))) {
      return ctx.reply("Сначала ответь на пару вопросов в приложении — тогда я смогу давать советы под тебя.", openKb);
    }
    const premium = await db.getPremium(userId);
    const access = await coachAccess(userId, premium.active || isAdmin(userId));
    if (!access.ok) {
      return ctx.reply(access.reason === "premium"
        ? "Бесплатные сообщения коучу закончились. С Hayanmi Премиум — общайся с коучем без ограничений: открой приложение и нажми «Премиум»."
        : "На сегодня лимит сообщений коучу исчерпан. Продолжим завтра!", openKb);
    }
    await ctx.replyWithChatAction("typing");
    const tz = await db.getTimezone(userId);
    const { reply } = await coachReply(userId, text.slice(0, 1000), localDate(tz), localTimeText(tz));
    const after = await coachAccess(userId, premium.active || isAdmin(userId));
    const tail = after.freeLeft !== null && after.freeLeft <= 1
      ? `\n\n(Бесплатных сообщений коучу осталось: ${after.freeLeft})` : "";
    await ctx.reply(reply + tail);
  } catch (e) {
    console.error("coach chat:", e);
    await ctx.reply("Не получилось ответить. Попробуй ещё раз через минуту.").catch(() => {});
  }
});

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

  await bot.api.setMyCommands([
    { command: "start", description: "Открыть Hayanmi" },
    { command: "paysupport", description: "Помощь с оплатой" },
    { command: "terms", description: "Условия подписки" },
    { command: "coach", description: "Сменить коуча" },
  ]);
  if (WEBAPP_URL) {
    await bot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "Hayanmi", web_app: { url: WEBAPP_URL } },
    });
  }
  setInterval(reminderTick, 60_000);
  setInterval(() => db.hasDb() && db.cleanupReminderLog().catch(() => {}), 6 * 3600_000);

  await bot.start({
    drop_pending_updates: true,
    onStart: (me) => console.log(`Бот @${me.username} запущен`),
  });
}

main().catch((err) => {
  console.error("Не удалось запустить:", err);
  process.exit(1);
});
