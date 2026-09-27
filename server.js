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
    const [profile, entries, quota] = await Promise.all([
      db.getProfile(req.user.id),
      db.getEntries(req.user.id, date),
      photoQuota(req.user.id, premium),
    ]);
    res.json({ ok: true, profile, entries, quota, premium: publicPremium(premium), prices: publicPrices() });
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
bot.command("refund", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const userId = ctx.match.trim();
  if (!/^\d+$/.test(userId)) return ctx.reply("Формат: /refund <Telegram ID пользователя>");
  try {
    const pay = await db.lastPayment(userId);
    if (!pay) return ctx.reply("У пользователя нет оплат для возврата.");
    await bot.api.raw.refundStarPayment({ user_id: Number(userId), telegram_payment_charge_id: pay.charge_id });
    const prem = await db.getPremium(userId);
    if (prem.recurring && prem.chargeId && !prem.canceled) {
      await bot.api.raw
        .editUserStarSubscription({ user_id: Number(userId), telegram_payment_charge_id: prem.chargeId, is_canceled: true })
        .catch((e) => console.warn("Не удалось отменить автопродление:", e.description || e));
    }
    await db.markRefunded(pay.id, userId);
    await ctx.reply(`Возвращено ${pay.amount} Stars пользователю ${userId}. Премиум отключён.`);
  } catch (e) {
    console.error("refund:", e);
    await ctx.reply("Не получилось: " + (e.description || e.message));
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
  ]);
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
