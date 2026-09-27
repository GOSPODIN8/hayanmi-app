// Hayanmi — сервер: бот в Telegram + раздача Mini App + проверка входа.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Bot, InlineKeyboard } from "grammy";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL; // адрес Mini App, например https://hayanmi.up.railway.app
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("Нет переменной BOT_TOKEN. Добавьте её в Variables на Railway.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Проверка, что запрос пришёл из Telegram ----------
// Telegram подписывает данные пользователя (initData) токеном бота.
// Сервер пересчитывает подпись и сравнивает: подделать её без токена нельзя.
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

  // Данные старше суток не принимаем
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
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/me", (req, res) => {
  const user = checkInitData(req.body?.initData);
  if (!user) return res.status(401).json({ ok: false, error: "unauthorized" });
  res.json({
    ok: true,
    user: { id: user.id, first_name: user.first_name, username: user.username ?? null },
  });
});

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));

// ---------- Бот ----------
const bot = new Bot(BOT_TOKEN);

function openAppKeyboard() {
  return new InlineKeyboard().webApp("Открыть Hayanmi", WEBAPP_URL);
}

bot.command("start", async (ctx) => {
  if (!WEBAPP_URL) {
    return ctx.reply("Приложение ещё настраивается. Загляните чуть позже.");
  }
  await ctx.reply(
    "Привет! Я Hayanmi — считаю калории по фото.\n\n" +
      "Сфотографируй тарелку, и я покажу калории, белки, жиры и углеводы.",
    { reply_markup: openAppKeyboard() }
  );
});

bot.on("message:photo", (ctx) =>
  ctx.reply("Распознавание фото появится совсем скоро. Пока загляни в приложение.", {
    reply_markup: WEBAPP_URL ? openAppKeyboard() : undefined,
  })
);

bot.catch((err) => console.error("Ошибка бота:", err.error));

async function setupBot() {
  await bot.api.setMyCommands([{ command: "start", description: "Открыть Hayanmi" }]);
  if (WEBAPP_URL) {
    // Кнопка «Hayanmi» слева от поля ввода в чате с ботом
    await bot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "Hayanmi", web_app: { url: WEBAPP_URL } },
    });
  }
  await bot.start({
    drop_pending_updates: true,
    onStart: (me) => console.log(`Бот @${me.username} запущен`),
  });
}

setupBot().catch((err) => {
  console.error("Не удалось запустить бота:", err);
  process.exit(1);
});
