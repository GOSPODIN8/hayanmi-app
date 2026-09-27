// Hayanmi — расчёт дневной нормы калорий и БЖУ.
// Формула Миффлина — Сан-Жеора + коэффициент активности.
(function (root) {
  const ACTIVITY = {
    min:    { k: 1.2,   t: "Минимальная",   d: "Сидячая работа, почти без спорта" },
    light:  { k: 1.375, t: "Лёгкая",        d: "Прогулки или 1–3 тренировки в неделю" },
    medium: { k: 1.55,  t: "Средняя",       d: "3–5 тренировок в неделю" },
    high:   { k: 1.725, t: "Высокая",       d: "6–7 тренировок в неделю" },
    max:    { k: 1.9,   t: "Очень высокая", d: "Тяжёлый физический труд или спорт дважды в день" },
  };

  const MIN_KCAL = { m: 1500, f: 1200 };
  const LOSE_DEFICIT = 500;   // ккал в день
  const GAIN_SURPLUS = 300;   // ккал в день
  const KCAL_PER_KG = 7700;  // примерно столько ккал в 1 кг массы тела

  function bmi(weight, heightCm) {
    const h = heightCm / 100;
    return weight / (h * h);
  }

  // Для младше 18 лет — только поддержание веса
  function effectiveGoal(p) {
    return p.age < 18 ? "keep" : p.goal;
  }

  function calculate(p) {
    const base = 10 * p.weight + 6.25 * p.height - 5 * p.age + (p.sex === "m" ? 5 : -161);
    const tdee = base * ACTIVITY[p.activity].k;
    const goal = effectiveGoal(p);

    let kcal = tdee;
    if (goal === "lose") kcal = Math.max(tdee - LOSE_DEFICIT, MIN_KCAL[p.sex]);
    if (goal === "gain") kcal = tdee + GAIN_SURPLUS;
    kcal = Math.round(kcal / 10) * 10;

    // Белок считаем от веса, но не больше веса при ИМТ 25 — иначе при большом весе выходит слишком много
    const refWeight = Math.min(p.weight, 25 * Math.pow(p.height / 100, 2));
    const protein = Math.round(refWeight * (goal === "keep" ? 1.6 : 1.8));
    const fat = Math.round((kcal * 0.28) / 9);
    const carbs = Math.max(0, Math.round((kcal - protein * 4 - fat * 9) / 4));

    const diff = Math.round(kcal - tdee); // отрицательное — дефицит

    // Прогноз считаем от фактического дефицита/профицита, а не от «идеального»
    let weeks = null;
    if (goal !== "keep" && p.target) {
      const kgPerWeek = (Math.abs(diff) * 7) / KCAL_PER_KG;
      if (kgPerWeek >= 0.05) {
        weeks = Math.max(1, Math.ceil(Math.abs(p.weight - p.target) / kgPerWeek));
      }
    }

    return { kcal, protein, fat, carbs, weeks, goal, diff };
  }

  // Проверка желаемого веса. Возвращает текст ошибки или null.
  function checkTarget(p, target) {
    if (p.goal === "lose") {
      if (target >= p.weight) return "Для снижения веса цель должна быть меньше текущего веса.";
      if (bmi(target, p.height) < 18.5) {
        const min = Math.ceil(18.5 * Math.pow(p.height / 100, 2));
        return `Это ниже здорового веса для вашего роста. Минимальная цель — ${min} кг.`;
      }
    }
    if (p.goal === "gain") {
      if (target <= p.weight) return "Для набора массы цель должна быть больше текущего веса.";
      if (target - p.weight > 40) return "Слишком большая разница. Поставьте промежуточную цель.";
    }
    return null;
  }

  root.HayanmiCalc = { ACTIVITY, calculate, checkTarget, effectiveGoal, bmi };
  if (typeof module !== "undefined") module.exports = root.HayanmiCalc;
})(typeof window !== "undefined" ? window : globalThis);
