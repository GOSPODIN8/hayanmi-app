// Hayanmi — ИИ-коуч: характеры, контекст из дневника и лимиты.
import * as db from "./db.js";
import { chatGemini } from "./gemini.js";

export const PERSONAS = {
  alina: { name: "Алина", style: "тёплая и поддерживающая; замечаешь и хвалишь маленькие шаги, мягко предлагаешь, что улучшить" },
  max: { name: "Макс", style: "прямой и мотивирующий спортивный тренер; говоришь коротко и по делу, без сюсюканья, но всегда уважительно" },
  karim: { name: "Карим", style: "спокойный нутрициолог; простыми словами объясняешь, почему это работает, опираешься на науку" },
  sonya: { name: "Соня", style: "лёгкая и с юмором, можешь пошутить и поиронизировать над собой, но советы даёшь серьёзные" },
};
export const DEFAULT_PERSONA = "alina";

export const COACH_FREE = Number(process.env.COACH_FREE_MESSAGES ?? 3);
export const COACH_DAILY = Number(process.env.COACH_DAILY_LIMIT ?? 50);

const MEAL_RU = { breakfast: "Завтрак", lunch: "Обед", dinner: "Ужин", snack: "Перекус" };
const GOAL_RU = { lose: "снизить вес", keep: "держать вес", gain: "набрать массу" };
const n0 = (v) => Math.round(v).toLocaleString("ru-RU");
const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

// Текстовая сводка по пользователю — коуч опирается на неё в ответах
export async function buildContext(userId, date, localTime) {
  const [profile, entries, water, week, weights, streak] = await Promise.all([
    db.getProfile(userId), db.getEntries(userId, date), db.waterTotal(userId, date),
    db.caloriesWeek(userId, date), db.getWeights(userId, 90), db.streak(userId, date),
  ]);
  if (!profile?.result) return "Пользователь ещё не прошёл анкету — норма неизвестна.";
  const a = profile.answers, r = profile.result;
  const eaten = entries.reduce((s, e) => ({ k: s.k + e.kcal, p: s.p + e.protein, f: s.f + e.fat, c: s.c + e.carbs }), { k: 0, p: 0, f: 0, c: 0 });
  const waterGoal = Math.min(3500, Math.max(1500, Math.round((Number(a.weight) * 30) / 100) * 100));

  const lines = [];
  lines.push(`Сейчас у пользователя ${localTime}, дата ${dm(date)}.`);
  lines.push(`Пол: ${a.sex === "m" ? "мужской" : "женский"}, возраст ${a.age}, рост ${a.height} см, вес ${a.weight} кг.`);
  lines.push(`Цель: ${GOAL_RU[a.goal] || "держать вес"}${a.target ? `, желаемый вес ${a.target} кг` : ""}.`);
  lines.push(`Дневная норма: ${n0(r.kcal)} ккал, белки ${r.protein} г, жиры ${r.fat} г, углеводы ${r.carbs} г.`);
  lines.push(`Сегодня съедено: ${n0(eaten.k)} ккал (Б ${n0(eaten.p)}, Ж ${n0(eaten.f)}, У ${n0(eaten.c)}). Осталось: ${n0(r.kcal - eaten.k)} ккал, белка ${n0(r.protein - eaten.p)} г.`);
  if (entries.length) {
    lines.push("Записи за сегодня:");
    for (const e of entries) lines.push(`- ${MEAL_RU[e.meal] || e.meal}: ${e.name}, ${n0(e.grams)} г, ${n0(e.kcal)} ккал`);
  } else {
    lines.push("Сегодня в дневнике пока пусто.");
  }
  lines.push(`Вода сегодня: ${n0(water)} из ${n0(waterGoal)} мл.`);
  lines.push(`Калории за 7 дней: ${week.map((d) => `${dm(d.date)} — ${d.kcal > 0 ? n0(d.kcal) : "нет записей"}`).join("; ")}.`);
  if (weights.length > 1) {
    lines.push(`Вес: ${weights.slice(-6).map((w) => `${dm(w.date)} — ${w.weight} кг`).join("; ")}.`);
  }
  lines.push(`Серия: ${streak} дн. подряд с записями.`);
  return lines.join("\n");
}

function systemPrompt(persona, context) {
  const p = PERSONAS[persona] || PERSONAS[DEFAULT_PERSONA];
  return `Ты — ${p.name}, ИИ-коуч по питанию в приложении Hayanmi (Telegram). Твой характер: ${p.style}.

Как отвечать:
- По-русски, на «ты», дружелюбно и коротко: 2–6 предложений или короткий список через «•».
- Без markdown-разметки: никаких **, #, таблиц.
- Опирайся на конкретные цифры пользователя ниже: что съедено, сколько осталось, как меняется вес.
- Предлагай конкретные продукты и блюда, доступные в России и Средней Азии.
- Не выдумывай данные. Если чего-то нет в дневнике — так и скажи.

Безопасность (важнее всего остального):
- Ты не врач. Не ставь диагнозы, не назначай и не меняй лекарства (в том числе GLP-1 и добавки). При симптомах, болезнях, беременности — советуй обратиться к врачу.
- Не советуй есть меньше 1200 ккал в день женщинам и 1500 мужчинам, голодовки, мочегонные, слабительные, «сушку» и жёсткие исключения продуктов.
- Если видишь признаки расстройства пищевого поведения (страх еды, вина после еды, срывы и компенсации, очищение, желание есть как можно меньше) — не давай цифр и ограничений, поддержи и мягко предложи поговорить со специалистом.
- Если человек пишет о мыслях причинить себе вред или о том, что не хочет жить — ответь с заботой, без советов о питании, и предложи прямо сейчас обратиться к близким или в службу экстренной помощи своей страны (например, 112).
- Если пользователь младше 18 лет — не предлагай дефицит калорий.
- На темы вне питания, веса, тренировок, сна, воды и привычек вежливо отвечай, что ты помогаешь с питанием, и возвращай разговор к нему.

Данные пользователя:
${context}`;
}

export async function coachAccess(userId, isPremium) {
  if (isPremium) {
    const today = await db.countUsageDay(userId, "coach");
    return { ok: today < COACH_DAILY, reason: today < COACH_DAILY ? null : "daily_limit", freeLeft: null };
  }
  const used = await db.countUsage(userId, "coach");
  const freeLeft = Math.max(0, COACH_FREE - used);
  return { ok: freeLeft > 0, reason: freeLeft > 0 ? null : "premium", freeLeft };
}

// Главная функция: вопрос → ответ коуча (история общая для приложения и чата)
export async function coachReply(userId, text, date, localTime) {
  const persona = (await db.getCoach(userId)) || DEFAULT_PERSONA;
  const [context, history] = await Promise.all([
    buildContext(userId, date, localTime),
    db.getCoachMessages(userId, 12),
  ]);
  const reply = await chatGemini(systemPrompt(persona, context), [...history, { role: "user", text }]);
  await db.addCoachMessages(userId, [["user", text], ["coach", reply]]);
  await db.addUsage(userId, "coach");
  return { reply, persona };
}
