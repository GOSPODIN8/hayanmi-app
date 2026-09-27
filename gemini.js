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

export async function recognizeFood(imageBase64, hint) {
  const userText = hint
    ? `Уточнение от пользователя: ${hint.slice(0, 200)}`
    : "Определи еду на фото.";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
              { text: userText },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini ответил ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  if (!text) throw new Error("Пустой ответ Gemini: " + JSON.stringify(data).slice(0, 300));
  return sanitize(extractJson(text));
}
