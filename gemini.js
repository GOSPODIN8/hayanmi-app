// Hayanmi — распознавание еды на фото через Gemini.
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

export const hasGemini = () => !!API_KEY;

const SYSTEM_PROMPT = `Ты — опытный нутрициолог. Тебе присылают фото еды.
Задача: найти на фото все блюда и продукты, оценить вес каждой порции в граммах
и пищевую ценность на 100 г.

Правила:
- Названия пиши по-русски, коротко и понятно: «Гречка отварная», «Куриная грудка жареная».
- Оценивай вес по размеру посуды и порции. Соусы и масло в салате учитывай.
- Напитки тоже считаются (граммы = миллилитры).
- Если пользователь прислал уточнение, оно важнее того, что видно на фото.
- Если на фото нет еды, верни is_food = false и пустой список items.

Отвечай ТОЛЬКО JSON без пояснений, строго в таком виде:
{"is_food": true, "items": [{"name": "Гречка отварная", "grams": 180, "kcal_100g": 110, "protein_100g": 4.2, "fat_100g": 1.1, "carbs_100g": 21.3}]}`;

const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
const round1 = (v) => Math.round(v * 10) / 10;

function sanitize(parsed) {
  const isFood = parsed?.is_food !== false;
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const clean = items
    .filter((it) => it && typeof it.name === "string" && it.name.trim())
    .slice(0, 10)
    .map((it) => ({
      name: it.name.trim().slice(0, 60),
      grams: Math.round(clamp(it.grams, 1, 2000)),
      per100: {
        kcal: round1(clamp(it.kcal_100g, 0, 900)),
        protein: round1(clamp(it.protein_100g, 0, 100)),
        fat: round1(clamp(it.fat_100g, 0, 100)),
        carbs: round1(clamp(it.carbs_100g, 0, 100)),
      },
    }));
  return { isFood: isFood && clean.length > 0, items: clean };
}

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("В ответе нет JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function callGemini(systemText, parts, temperature = 0.2) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature },
      }),
      signal: AbortSignal.timeout(60000),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini ответил ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts ?? [];
  const text = out.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!text) throw new Error("Пустой ответ Gemini: " + JSON.stringify(data).slice(0, 300));
  return extractJson(text);
}

export async function recognizeFood(imageBase64, hint) {
  const userText = hint
    ? `Уточнение от пользователя: ${hint.slice(0, 200)}`
    : "Определи еду на фото.";

  const parsed = await callGemini(SYSTEM_PROMPT, [
    { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
    { text: userText },
  ]);
  return sanitize(parsed);
}

// ---------- ИИ-повар: рецепт под остаток КБЖУ ----------
const RECIPE_PROMPT = `Ты — шеф-повар и нутрициолог. Придумай ОДИН простой домашний рецепт на 1 порцию
из продуктов, которые легко купить в обычном магазине в России и Средней Азии.

Правила:
- Калорийность порции — как можно ближе к целевой (допустимо ±10%).
- Белка — не меньше указанного, если это разумно для такого приёма пищи.
- Учитывай пожелания пользователя; если они невыполнимы или вредны — выбери близкую безопасную альтернативу.
- Граммовки ингредиентов — в сыром виде. Шагов 3–6, коротко и понятно.
- Все тексты на русском.

Отвечай ТОЛЬКО JSON строго в таком виде:
{"title": "Название", "minutes": 20, "grams": 350, "kcal": 450, "protein": 35, "fat": 12, "carbs": 45,
 "ingredients": [{"name": "Куриная грудка", "amount": "150 г"}], "steps": ["Шаг 1", "Шаг 2"]}`;

export async function suggestRecipe({ meal, targetKcal, minProtein, wishes, avoid }) {
  const text =
    `Приём пищи: ${meal}.\nЦелевая калорийность: ${targetKcal} ккал.\nБелок: от ${minProtein} г.` +
    (wishes ? `\nПожелания пользователя: ${wishes.slice(0, 200)}` : "") +
    (avoid ? `\nНе предлагай эти блюда, они уже были: ${avoid.slice(0, 300)}` : "");
  const p = await callGemini(RECIPE_PROMPT, [{ text }], 0.9);

  const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const title = str(p.title, 80);
  const ingredients = (Array.isArray(p.ingredients) ? p.ingredients : [])
    .map((i) => ({ name: str(i?.name, 60), amount: str(i?.amount, 30) }))
    .filter((i) => i.name)
    .slice(0, 15);
  const steps = (Array.isArray(p.steps) ? p.steps : []).map((x) => str(x, 300)).filter(Boolean).slice(0, 8);
  if (!title || !ingredients.length || !steps.length) throw new Error("Неполный рецепт от Gemini");

  const protein = round1(clamp(p.protein, 0, 200));
  const fat = round1(clamp(p.fat, 0, 200));
  const carbs = round1(clamp(p.carbs, 0, 400));
  // Проверяем калории по БЖУ: если ИИ ошибся сильно — пересчитываем
  const byMacros = protein * 4 + fat * 9 + carbs * 4;
  let kcal = Math.round(clamp(p.kcal, 0, 3000));
  if (byMacros > 0 && Math.abs(kcal - byMacros) / byMacros > 0.2) kcal = Math.round(byMacros);

  return {
    title, ingredients, steps, kcal, protein, fat, carbs,
    minutes: Math.round(clamp(p.minutes, 1, 240)) || 20,
    grams: Math.round(clamp(p.grams, 50, 1500)) || 300,
  };
}
