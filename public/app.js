// Hayanmi — Mini App: анкета, результат, главная.
(function () {
  const tg = window.Telegram?.WebApp;
  const Calc = window.HayanmiCalc;
  const app = document.getElementById("app");

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#0E0F0C"); tg.setBackgroundColor("#0E0F0C"); tg.setBottomBarColor?.("#0E0F0C"); } catch (e) {}

    const can = (v) => typeof tg.isVersionAtLeast === "function" && tg.isVersionAtLeast(v);
    const isPhone = ["ios", "android", "android_x"].includes(tg.platform);

    // Во весь экран — только на телефонах (Bot API 8.0+)
    if (isPhone && can("8.0")) {
      try { tg.requestFullscreen(); } catch (e) {}
      try { tg.lockOrientation(); } catch (e) {}
    }
    // Чтобы приложение не закрывалось свайпом вниз, пока двигаешь ползунки (Bot API 7.7+)
    if (can("7.7")) {
      try { tg.disableVerticalSwipes(); } catch (e) {}
    }
  }

  // ---------- Хранилище ----------
  // CloudStorage Telegram привязан к аккаунту пользователя.
  // Вне Telegram (проверка в браузере) — localStorage.
  const hasCloud = !!(tg && tg.CloudStorage && tg.isVersionAtLeast && tg.isVersionAtLeast("6.9"));
  const storage = {
    get(key) {
      return new Promise((resolve) => {
        if (hasCloud) {
          tg.CloudStorage.getItem(key, (err, val) => resolve(err ? null : val || null));
        } else {
          try { resolve(localStorage.getItem(key)); } catch (e) { resolve(null); }
        }
      });
    },
    set(key, value) {
      return new Promise((resolve) => {
        if (hasCloud) {
          tg.CloudStorage.setItem(key, value, (err) => resolve(!err));
        } else {
          try { localStorage.setItem(key, value); resolve(true); } catch (e) { resolve(false); }
        }
      });
    },
  };

  // ---------- Мелочи ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Math.round(n).toLocaleString("ru-RU");
  const haptic = (kind) => {
    try {
      if (kind === "select") tg?.HapticFeedback?.selectionChanged();
      else if (kind === "error") tg?.HapticFeedback?.notificationOccurred("error");
      else if (kind === "success") tg?.HapticFeedback?.notificationOccurred("success");
      else tg?.HapticFeedback?.impactOccurred("light");
    } catch (e) {}
  };

  let backHandler = null;
  function setBack(fn) {
    if (!tg?.BackButton) return;
    if (backHandler) tg.BackButton.offClick(backHandler);
    backHandler = fn;
    if (fn) { tg.BackButton.onClick(fn); tg.BackButton.show(); }
    else tg.BackButton.hide();
  }

  // ---------- Запросы к серверу ----------
  async function api(path, options = {}) {
    const res = await fetch("/api" + path, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Init-Data": tg?.initData || "",
        "X-Timezone": (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; } })(),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data || data.ok === false) {
      const err = new Error((data && data.error) || "http_" + res.status);
      err.code = (data && data.error) || "http_" + res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function localDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function showAlert(msg) {
    if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
  }

  function showConfirm(msg) {
    return new Promise((resolve) => {
      if (tg?.showConfirm) tg.showConfirm(msg, (ok) => resolve(!!ok));
      else resolve(confirm(msg));
    });
  }

  // Общее состояние приложения
  const state = { profile: null, entries: [], quota: null, premium: null, prices: null, water: null, reminders: null, date: localDate() };

  async function loadState() {
    const data = await api("/state?date=" + state.date);
    state.profile = data.profile;
    state.entries = data.entries || [];
    state.quota = data.quota || null;
    state.premium = data.premium || null;
    state.prices = data.prices || null;
    state.water = data.water || null;
    state.reminders = data.reminders || null;
    state.access = data.access || null;
    return data;
  }

  // ---------- Шкала-линейка для чисел (возраст, рост, вес) ----------
  // Листается пальцем, щёлкает на делениях, число сверху можно ввести с клавиатуры.
  const RULERS = {
    age:    { min: 14, max: 90,  step: 1,   tickW: 14, major: 5,  label: 5,  decimals: 0 },
    height: { min: 130, max: 230, step: 1,  tickW: 10, major: 10, label: 10, decimals: 0 },
    weight: { min: 35, max: 250, step: 0.1, tickW: 8,  major: 10, label: 10, decimals: 1 },
  };

  const numText = (v, decimals) => decimals ? v.toFixed(decimals).replace(".", ",") : String(Math.round(v));

  function rulerHtml(kind, value, unit, label) {
    const c = RULERS[kind];
    const ticks = Math.round((c.max - c.min) / c.step);
    const width = ticks * c.tickW;
    const labels = [];
    for (let i = 0; i <= ticks; i += c.label) {
      labels.push(`<span class="rl-num" style="left:${i * c.tickW}px">${numText(c.min + i * c.step, 0)}</span>`);
    }
    return `
      <div class="picker">
        <label class="picker-value" for="num">
          <input id="num" class="display" type="text" inputmode="${c.decimals ? "decimal" : "numeric"}" autocomplete="off"
                 value="${numText(value, c.decimals)}" aria-label="${esc(label)}">
          <span class="unit">${unit}</span>
        </label>
        <div class="ruler-wrap">
          <div class="ruler" id="ruler" tabindex="-1" aria-hidden="true">
            <div class="ruler-track" style="width:${width}px">
              <div class="rl-ticks" style="width:${width + 2}px;
                background-image:
                  repeating-linear-gradient(90deg, rgba(243,241,234,.9) 0 2px, transparent 2px ${c.tickW * c.major}px),
                  repeating-linear-gradient(90deg, rgba(166,165,158,.55) 0 1px, transparent 1px ${c.tickW}px);
                background-size: 100% 40px, 100% 20px;
                background-position: 0 0, 0 10px;
                background-repeat: no-repeat;"></div>
              ${labels.join("")}
            </div>
          </div>
          <div class="ruler-center" aria-hidden="true"></div>
          <div class="ruler-fade left" aria-hidden="true"></div>
          <div class="ruler-fade right" aria-hidden="true"></div>
        </div>
        <div class="small muted picker-hint">Листайте шкалу или нажмите на число</div>
      </div>`;
  }

  // Подключаем поведение к разметке rulerHtml. onChange вызывается при каждом новом значении.
  function mountRuler(kind, initial, onChange) {
    const c = RULERS[kind];
    const ruler = document.getElementById("ruler");
    const input = document.getElementById("num");
    const track = ruler.querySelector ? ruler.querySelector(".ruler-track") : null;
    let value = initial;
    let snapTimer = null;
    let programmatic = false;

    const pad = () => (ruler.clientWidth || 0) / 2;
    const toScroll = (v) => ((v - c.min) / c.step) * c.tickW;
    const fromScroll = (x) => {
      const v = c.min + Math.round(x / c.tickW) * c.step;
      return Math.min(c.max, Math.max(c.min, Number(v.toFixed(c.decimals))));
    };

    function layout() {
      if (track) { track.style.marginLeft = pad() + "px"; track.style.marginRight = pad() + "px"; }
    }
    function jump(v, smooth) {
      programmatic = true;
      const left = toScroll(v);
      if (smooth && ruler.scrollTo) ruler.scrollTo({ left, behavior: "smooth" });
      else ruler.scrollLeft = left;
      setTimeout(() => { programmatic = false; }, smooth ? 350 : 50);
    }

    layout();
    jump(value, false);

    ruler.addEventListener("scroll", () => {
      const v = fromScroll(ruler.scrollLeft);
      if (v !== value) {
        value = v;
        if (document.activeElement !== input) input.value = numText(v, c.decimals);
        if (!programmatic) haptic("select");
        onChange && onChange(v);
      }
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        const target = toScroll(fromScroll(ruler.scrollLeft));
        if (Math.abs(target - ruler.scrollLeft) > 0.5) jump(fromScroll(ruler.scrollLeft), true);
      }, 120);
    }, { passive: true });

    // Ввод с клавиатуры: при правильном числе шкала переезжает на него
    input.addEventListener("focus", () => { setTimeout(() => input.select && input.select(), 0); });
    input.addEventListener("input", () => {
      const v = parseFloat(input.value.trim().replace(",", "."));
      if (isFinite(v) && v >= c.min && v <= c.max) {
        value = Number(v.toFixed(c.decimals));
        jump(value, true);
        onChange && onChange(value);
      }
    });
    input.addEventListener("blur", () => {
      const v = parseFloat(input.value.trim().replace(",", "."));
      if (isFinite(v) && v >= c.min && v <= c.max) input.value = numText(v, c.decimals);
    });

    window.addEventListener("resize", () => { layout(); jump(value, false); });
    return { get: () => value, set: (v) => { value = v; input.value = numText(v, c.decimals); jump(v, false); } };
  }

  // ---------- Анкета ----------
  const GOALS = {
    lose: { t: "Снизить вес", d: "Дефицит калорий, без жёстких диет" },
    keep: { t: "Держать вес", d: "Питаться сбалансированно" },
    gain: { t: "Набрать массу", d: "Небольшой профицит и больше белка" },
  };

  let draft = {};   // ответы анкеты
  let stepIndex = 0;

  function visibleSteps() {
    const steps = ["sex", "age", "height", "weight"];
    if (!(draft.age < 18)) {
      steps.push("goal");
      if (draft.goal && draft.goal !== "keep") steps.push("target");
    }
    steps.push("activity");
    return steps;
  }

  const NUMBER_STEPS = {
    age:    { title: "Сколько вам лет?",      unit: "лет", min: 14,  max: 90,  int: true,  err: "Введите возраст от 14 до 90 лет." },
    height: { title: "Ваш рост",              unit: "см",  min: 130, max: 230, int: true,  err: "Введите рост от 130 до 230 см." },
    weight: { title: "Ваш текущий вес",       unit: "кг",  min: 35,  max: 250, int: false, err: "Введите вес от 35 до 250 кг." },
    target: { title: "Какой вес — ваша цель?", unit: "кг", min: 35,  max: 250, int: false, err: "Введите вес от 35 до 250 кг." },
  };

  function progressHtml() {
    const steps = visibleSteps();
    const n = stepIndex + 1;
    return `
      <div class="progress">
        <div class="track"><div class="fill" style="width:${Math.round((n / steps.length) * 100)}%"></div></div>
        <div class="label">Шаг ${n} из ${steps.length}</div>
      </div>`;
  }

  function renderStep() {
    const steps = visibleSteps();
    if (stepIndex >= steps.length) return renderResult();
    const step = steps[stepIndex];
    setBack(stepIndex > 0 ? () => { stepIndex--; renderStep(); } : (draft._editing ? () => renderProfile() : null));

    if (step === "sex") {
      return renderChoice("Ваш пол", "Нужен для точного расчёта обмена веществ.", "sex", {
        m: { t: "Мужской" }, f: { t: "Женский" },
      });
    }
    if (step === "goal") {
      return renderChoice("Ваша цель", "Её можно поменять в любой момент.", "goal", GOALS);
    }
    if (step === "activity") {
      return renderChoice("Уровень активности", "Выберите то, что ближе к обычной неделе.", "activity", Calc.ACTIVITY);
    }
    return renderNumber(step);
  }

  function renderChoice(title, sub, key, options) {
    app.innerHTML = `
      ${progressHtml()}
      <h2 class="q-title display">${esc(title)}</h2>
      <p class="q-sub">${esc(sub)}</p>
      <div class="options">
        ${Object.entries(options).map(([val, o]) => `
          <button class="option ${draft[key] === val ? "selected" : ""}" data-val="${val}" type="button">
            <span class="t">${esc(o.t)}</span>
            ${o.d ? `<span class="d">${esc(o.d)}</span>` : ""}
          </button>`).join("")}
      </div>`;
    app.querySelectorAll(".option").forEach((btn) => {
      btn.addEventListener("click", () => {
        haptic("select");
        draft[key] = btn.dataset.val;
        if (key === "goal" && draft.goal === "keep") delete draft.target;
        stepIndex++;
        renderStep();
      });
    });
  }

  // Стартовое значение на шкале: прошлый ответ или разумное значение по полу и цели
  function defaultNumber(step) {
    if (draft[step] != null) return Number(draft[step]);
    const male = draft.sex === "m";
    if (step === "age") return 30;
    if (step === "height") return male ? 176 : 164;
    if (step === "weight") return male ? 80 : 65;
    if (step === "target") {
      const w = Number(draft.weight) || (male ? 80 : 65);
      if (draft.goal === "gain") return Math.round(w + 5);
      const minHealthy = Math.ceil(18.5 * Math.pow((Number(draft.height) || 170) / 100, 2));
      return Math.max(Math.round(w - 5), Math.min(minHealthy, Math.round(w - 1)));
    }
    return 0;
  }

  function renderNumber(step) {
    const cfg = NUMBER_STEPS[step];
    const sub = step === "target"
      ? `Сейчас: ${String(draft.weight).replace(".", ",")} кг`
      : step === "age" ? "Норма калорий зависит от возраста." : "";
    const kind = step === "target" ? "weight" : step;
    const value = defaultNumber(step);
    app.innerHTML = `
      ${progressHtml()}
      <h2 class="q-title display">${esc(cfg.title)}</h2>
      <p class="q-sub">${esc(sub)}</p>
      ${rulerHtml(kind, value, cfg.unit, cfg.title)}
      <div class="error" id="err" role="alert" style="text-align:center"></div>
      <div class="grow"></div>
      <button class="primary" id="next" type="button">Далее</button>`;

    const input = document.getElementById("num");
    const errEl = document.getElementById("err");
    mountRuler(kind, value, () => { errEl.textContent = ""; });

    const submit = () => {
      const raw = input.value.trim().replace(",", ".");
      const num = cfg.int ? parseInt(raw, 10) : parseFloat(raw);
      if (!isFinite(num) || num < cfg.min || num > cfg.max || (cfg.int && !/^\d+$/.test(raw))) {
        errEl.textContent = cfg.err;
        haptic("error");
        return;
      }
      const value = cfg.int ? num : Math.round(num * 10) / 10;
      if (step === "target") {
        const problem = Calc.checkTarget(draft, value);
        if (problem) { errEl.textContent = problem; haptic("error"); return; }
      }
      draft[step] = value;
      // Если изменили вес — старая цель могла стать неверной
      if (step === "weight" && draft.target != null && Calc.checkTarget(draft, draft.target)) delete draft.target;
      input.blur();
      stepIndex++;
      renderStep();
    };
    document.getElementById("next").addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    input.addEventListener("input", () => { errEl.textContent = ""; });
  }

  // ---------- Результат ----------
  function goalDateText(weeks) {
    const d = new Date(Date.now() + weeks * 7 * 864e5);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString("ru-RU", sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
  }

  function forecastSvg(from, to) {
    const up = to > from;
    const y1 = up ? 112 : 28, y2 = up ? 28 : 112;
    return `
      <svg width="100%" height="140" viewBox="0 0 318 140" preserveAspectRatio="none" aria-label="Прогноз: с ${from} до ${to} кг">
        <line x1="0" y1="124" x2="318" y2="124" stroke="#2C2E33" stroke-width="1"/>
        <path d="M10 ${y1} C 90 ${y1} 170 ${y2} 308 ${y2}" fill="none" stroke="#D4F25A" stroke-width="3" stroke-linecap="round"/>
        <circle cx="10" cy="${y1}" r="6" fill="#0E0F0C" stroke="#F3F1EA" stroke-width="2"/>
        <circle cx="308" cy="${y2}" r="7" fill="#D4F25A"/>
      </svg>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:6px">
        <span>${String(from).replace(".", ",")} кг <span class="muted">сейчас</span></span>
        <span style="color:var(--accent);font-weight:700">${String(to).replace(".", ",")} кг</span>
      </div>`;
  }

  function renderResult() {
    const r = Calc.calculate(draft);
    setBack(() => { stepIndex = visibleSteps().length - 1; renderStep(); });

    let subtitle = "ккал в день · поддержание веса";
    if (r.goal === "lose") subtitle = `ккал в день · дефицит ${fmt(-r.diff)} ккал`;
    if (r.goal === "gain") subtitle = `ккал в день · профицит ${fmt(r.diff)} ккал`;

    const minorNote = draft.age < 18
      ? `<p class="note muted">До 18 лет Hayanmi рассчитывает только поддержание веса. Цели по снижению или набору лучше ставить вместе с врачом.</p>`
      : "";

    const forecast = r.weeks
      ? `<section class="card">
          <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
            <strong>Прогноз</strong><span class="muted small">≈ ${goalDateText(r.weeks)}</span>
          </div>
          ${forecastSvg(draft.weight, draft.target)}
        </section>`
      : "";

    app.innerHTML = `
      <div class="muted" style="font-size:15px;font-weight:600">Ваша норма на день</div>
      <div class="big-num display">${fmt(r.kcal)}</div>
      <div>${subtitle}</div>
      <div class="tiles">
        <div class="tile"><div class="dot" style="background:var(--protein)"></div><div class="v display">${r.protein} г</div><div class="k">Белки</div></div>
        <div class="tile"><div class="dot" style="background:var(--fat)"></div><div class="v display">${r.fat} г</div><div class="k">Жиры</div></div>
        <div class="tile"><div class="dot" style="background:var(--carbs)"></div><div class="v display">${r.carbs} г</div><div class="k">Углеводы</div></div>
      </div>
      ${forecast}
      ${minorNote}
      <p class="note muted">Это ориентир, а не медицинская рекомендация. Норму можно изменить в любой момент.</p>
      <div class="grow"></div>
      <div class="stack">
        <button class="primary" id="save" type="button">Сохранить и начать</button>
      </div>`;

    document.getElementById("save").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Сохраняю…";
      const { _editing, ...answers } = draft;
      const profile = { v: 1, answers, result: r, savedAt: new Date().toISOString() };
      try {
        await api("/profile", { method: "POST", body: { profile } });
        storage.set("profile", JSON.stringify(profile)); // запасная копия
      } catch (err) {
        haptic("error");
        btn.disabled = false;
        btn.textContent = "Сохранить и начать";
        showAlert("Не получилось сохранить. Проверьте интернет и попробуйте ещё раз.");
        return;
      }
      haptic("success");
      const firstTime = !state.profile;
      state.profile = profile;
      if (firstTime && state.premium && !state.premium.active) {
        markPaywallShown();
        return renderPaywall("onboarding");
      }
      renderHome();
    });
  }

  // ---------- Главная ----------
  const MEALS = [
    { id: "breakfast", t: "Завтрак" },
    { id: "lunch", t: "Обед" },
    { id: "dinner", t: "Ужин" },
    { id: "snack", t: "Перекус" },
  ];
  const mealTitle = (id) => (MEALS.find((m) => m.id === id) || MEALS[3]).t;

  function defaultMeal() {
    const h = new Date().getHours();
    if (h >= 4 && h < 11) return "breakfast";
    if (h >= 11 && h < 16) return "lunch";
    if (h >= 16 && h < 22) return "dinner";
    return "snack";
  }

  function totalsOf(list) {
    return list.reduce(
      (t, e) => ({ kcal: t.kcal + e.kcal, p: t.p + e.protein, f: t.f + e.fat, c: t.c + e.carbs }),
      { kcal: 0, p: 0, f: 0, c: 0 }
    );
  }

  function macroRow(name, color, eaten, goal) {
    const pct = goal > 0 ? Math.min(100, Math.round((eaten / goal) * 100)) : 0;
    return `
      <div class="macro">
        <div class="row"><span>${name}</span><span class="muted">${fmt(eaten)} / ${fmt(goal)} г</span></div>
        <div class="bar"><div style="width:${pct}%;background:${color}"></div></div>
      </div>`;
  }

  const ICON_X = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7L17 17M17 7L7 17" stroke="#A6A59E" stroke-width="2" stroke-linecap="round"/></svg>`;

  // ---------- Вода ----------
  const DROP = `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3C12 3 6 10 6 14.5A6 6 0 0 0 18 14.5C18 10 12 3 12 3Z" fill="none" stroke="#86B6FF" stroke-width="2" stroke-linejoin="round"/></svg>`;
  const reduceMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } };
  const liters = (ml) => (ml / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 });

  function waterHtml() {
    if (!state.water) return "";
    const { ml, goal } = state.water;
    const pct = Math.min(100, Math.round((ml / goal) * 100));
    return `
      <section class="card water">
        <div class="water-top">
          ${DROP}
          <div class="water-info">
            <div class="water-title">Вода</div>
            <div class="small muted" id="w-text">${liters(ml)} из ${liters(goal)} л${ml >= goal ? " · норма выполнена" : ""}</div>
          </div>
          <button class="icon-btn round" id="w-minus" type="button" aria-label="Убрать 250 мл" ${ml > 0 ? "" : "disabled"}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12H19" stroke="#F3F1EA" stroke-width="2.2" stroke-linecap="round"/></svg>
          </button>
          <button class="water-add" id="w-plus" type="button">+250 мл</button>
        </div>
        <div class="bar" style="margin-top:12px"><div id="w-bar" style="width:${pct}%;background:var(--protein)"></div></div>
      </section>`;
  }

  let waterBusy = false;
  async function changeWater(delta) {
    if (waterBusy) return;
    waterBusy = true;
    haptic(delta > 0 ? "select" : undefined);
    try {
      const data = await api("/water", { method: "POST", body: { date: state.date, delta } });
      state.water = { ...state.water, ml: data.ml };
      if (delta > 0 && data.ml >= state.water.goal && data.ml - delta < state.water.goal) haptic("success");
      renderHome();
    } catch (e) {
      showAlert("Не получилось записать воду. Попробуйте ещё раз.");
    } finally {
      waterBusy = false;
    }
  }

  // ---------- Иконка Hayanmi на главном экране телефона (Bot API 8.0) ----------
  const canAddToHome = () =>
    !!(tg && typeof tg.addToHomeScreen === "function" && tg.isVersionAtLeast && tg.isVersionAtLeast("8.0"));

  function checkHomeScreen() {
    return new Promise((resolve) => {
      if (!canAddToHome() || typeof tg.checkHomeScreenStatus !== "function") return resolve("unsupported");
      const t = setTimeout(() => resolve("unknown"), 800);
      try {
        tg.checkHomeScreenStatus((status) => { clearTimeout(t); resolve(status || "unknown"); });
      } catch (e) { clearTimeout(t); resolve("unsupported"); }
    });
  }

  if (tg && typeof tg.onEvent === "function") {
    tg.onEvent("homeScreenAdded", () => {
      state.homeScreen = "added";
      haptic("success");
      const card = document.getElementById("hs-card");
      if (card && card.remove) card.remove();
      const pbtn = document.getElementById("hs-profile");
      if (pbtn) { pbtn.disabled = true; pbtn.textContent = "Hayanmi уже на главном экране"; }
    });
  }

  function addToHome() {
    haptic();
    try { tg.addToHomeScreen(); } catch (e) { showAlert("На этом устройстве Telegram пока не умеет добавлять приложения на главный экран."); }
  }

  const APP_ICON = `<svg width="30" height="30" viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="40" fill="none" stroke="#2C2E33" stroke-width="10"/><circle cx="48" cy="48" r="40" fill="none" stroke="#D4F25A" stroke-width="10" stroke-linecap="round" stroke-dasharray="180 252" transform="rotate(-90 48 48)"/><path d="M37 29V67M37 51C37 45 41 42 46 42C52 42 59 45 59 53V67" fill="none" stroke="#F3F1EA" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function homeScreenHtml() {
    if (!["missed", "unknown"].includes(state.homeScreen) || state.hsDismissed) return "";
    return `
      <section class="card homescreen" id="hs-card">
        <div class="hs-icon">${APP_ICON}</div>
        <div class="hs-text">
          <div style="font-size:15px;font-weight:700">Hayanmi на экран «Домой»</div>
          <div class="small muted">Открывай в одно касание, как обычное приложение</div>
        </div>
        <button class="hs-add" id="hs-add" type="button">Добавить</button>
        <button class="icon-btn" id="hs-close" type="button" aria-label="Скрыть">${ICON_X}</button>
      </section>`;
  }

  function promoHtml() {
    if (!state.premium || state.premium.active) return "";
    const prices = state.prices || { month: 250, year: 1500, trialDays: 3 };
    const trial = state.premium.trialAvailable;
    const q = state.quota;
    const sub = q && !q.unlimited && q.left <= 0
      ? "Бесплатные распознавания закончились. Продолжайте без ограничений."
      : "Безлимитное распознавание еды по фото и все новые функции.";
    return `
      <section class="promo">
        <div class="promo-top">
          <div class="promo-title display">Hayanmi <span style="color:var(--accent)">Премиум</span></div>
          ${STAR}
        </div>
        <p class="promo-text">${sub}</p>
        <button class="primary promo-btn" id="promo-btn" type="button">${trial
          ? `Попробовать ${prices.trialDays} дня бесплатно`
          : `Подключить от ${fmt(Math.round(prices.year / 12))} ⭐ в месяц`}</button>
      </section>`;
  }

  function renderHome() {
    setBack(null);
    const r = state.profile.result;
    const eaten = totalsOf(state.entries);
    const over = eaten.kcal > r.kcal;
    const left = Math.abs(Math.round(r.kcal - eaten.kcal));
    const circumference = 2 * Math.PI * 62;
    const filled = Math.min(1, eaten.kcal / r.kcal) * circumference;
    const firstName = tg?.initDataUnsafe?.user?.first_name;

    const mealsHtml = MEALS.map((m) => {
      const list = state.entries.filter((e) => e.meal === m.id);
      if (!list.length) return "";
      const t = totalsOf(list);
      return `
        <div class="section-title"><span>${m.t}</span><span class="muted">${fmt(t.kcal)} ккал</span></div>
        ${list.map((e) => `
          <div class="entry">
            <div class="info">
              <div class="name">${esc(e.name)}</div>
              <div class="meta">${fmt(e.grams)} г · Б ${fmt(e.protein)} · Ж ${fmt(e.fat)} · У ${fmt(e.carbs)}</div>
            </div>
            <div class="kcal">${fmt(e.kcal)}</div>
            <button class="icon-btn" type="button" data-del="${esc(e.id)}" aria-label="Удалить: ${esc(e.name)}">${ICON_X}</button>
          </div>`).join("")}`;
    }).join("");

    const q = state.quota;
    const quotaHtml = q && !q.unlimited
      ? `<div class="quota">${q.left > 0 ? `Бесплатных распознаваний осталось: ${q.left} из ${q.limit}` : "Бесплатные распознавания закончились"}</div>`
      : `<div style="height:14px"></div>`;

    app.innerHTML = `
      <header>
        <div>
          <div class="hello muted">${firstName ? "Привет, " + esc(firstName) + "!" : "Привет!"}</div>
          <h1 class="display">Сегодня</h1>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="badge ${state.premium?.active ? "on" : ""}" id="premium" type="button">Премиум</button>
          <button class="icon-btn round" id="profile-btn" type="button" aria-label="Профиль">${TAB_ICONS.profile}</button>
        </div>
      </header>

      <section class="card ring-wrap" aria-label="Калории за день">
        <div class="ring">
          <svg width="148" height="148" viewBox="0 0 148 148" aria-hidden="true">
            <circle cx="74" cy="74" r="62" fill="none" stroke="#2C2E33" stroke-width="12"/>
            <circle cx="74" cy="74" r="62" fill="none" stroke="${over ? "#F4A259" : "#D4F25A"}" stroke-width="12" stroke-linecap="round"
                    stroke-dasharray="${filled.toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 74 74)"/>
          </svg>
          <div class="center">
            <div class="num display">${fmt(left)}</div>
            <div class="lbl muted">${over ? "ккал сверх нормы" : "ккал осталось"}</div>
          </div>
        </div>
        <div class="macros">
          ${macroRow("Белки", "var(--protein)", eaten.p, r.protein)}
          ${macroRow("Жиры", "var(--fat)", eaten.f, r.fat)}
          ${macroRow("Углеводы", "var(--carbs)", eaten.c, r.carbs)}
          <div class="small muted">Съедено ${fmt(eaten.kcal)} из ${fmt(r.kcal)}</div>
        </div>
      </section>

      ${waterHtml()}

      ${homeScreenHtml()}

      ${promoHtml()}

      ${mealsHtml || `<section class="card empty"><p class="note muted" style="margin:0">Пока пусто. Сфотографируй еду — и калории посчитаются сами.</p></section>`}

      ${quotaHtml}
      ${tabbarHtml("home")}`;
    bindTabs();

    const openSub = () => { haptic(); state.premium?.active ? renderSubscription() : renderPaywall(); };
    document.getElementById("profile-btn").addEventListener("click", () => { haptic(); renderProfile(); });
    const hsAdd = document.getElementById("hs-add");
    if (hsAdd) hsAdd.addEventListener("click", addToHome);
    const hsClose = document.getElementById("hs-close");
    if (hsClose) hsClose.addEventListener("click", () => {
      haptic();
      state.hsDismissed = true;
      storage.set("hs_dismissed", "1");
      renderHome();
    });
    document.getElementById("premium").addEventListener("click", openSub);
    const promoBtn = document.getElementById("promo-btn");
    if (promoBtn) promoBtn.addEventListener("click", openSub);

    app.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const ok = await showConfirm("Удалить эту запись из дневника?");
        if (!ok) return;
        try {
          await api("/entries/" + btn.dataset.del, { method: "DELETE" });
          state.entries = state.entries.filter((e) => e.id !== btn.dataset.del);
          haptic("success");
          renderHome();
        } catch (e) {
          showAlert("Не получилось удалить. Попробуйте ещё раз.");
        }
      });
    });


    const wPlus = document.getElementById("w-plus");
    const wMinus = document.getElementById("w-minus");
    if (wPlus) wPlus.addEventListener("click", () => changeWater(250));
    if (wMinus) wMinus.addEventListener("click", () => changeWater(-250));
  }

  // ---------- Фото: сжатие перед отправкой ----------
  function resizeImage(file, maxSide = 1024) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad_image")); };
      img.src = url;
    });
  }

  // ---------- Фото: превью и уточнение ----------
  function renderPhotoPreview(dataUrl) {
    setBack(() => renderHome());
    app.innerHTML = `
      <img class="photo" src="${dataUrl}" alt="Выбранное фото еды">
      <label class="label" for="hint">Уточнение для ИИ (необязательно)</label>
      <input class="text-input" id="hint" type="text" maxlength="200" autocomplete="off" placeholder="Например: курица жареная, без масла">
      <div class="grow"></div>
      <div class="stack">
        <button class="primary" id="go" type="button">Распознать</button>
      </div>`;

    document.getElementById("go").addEventListener("click", () => {
      const hint = document.getElementById("hint").value.trim();
      recognize(dataUrl, hint);
    });
  }

  async function recognize(dataUrl, hint) {
    setBack(null);
    app.innerHTML = `
      <img class="photo" src="${dataUrl}" alt="Фото еды">
      <div class="loading">
        <div class="spinner" aria-hidden="true"></div>
        <div>Распознаю еду…</div>
        <div class="small muted">Обычно это занимает 5–15 секунд</div>
      </div>`;

    try {
      const data = await api("/recognize", {
        method: "POST",
        body: { image: dataUrl.split(",")[1], hint },
      });
      if (data.quota) state.quota = data.quota;
      if (!data.isFood) {
        haptic("error");
        return renderNoFood(dataUrl);
      }
      haptic("success");
      renderRecognized(dataUrl, data.items);
    } catch (e) {
      haptic("error");
      if (e.code === "limit") {
        if (e.data?.quota) state.quota = e.data.quota;
        return renderPaywall("limit");
      }
      setBack(() => renderHome());
      app.innerHTML = `
        <img class="photo small" src="${dataUrl}" alt="Фото еды">
        <section class="card empty" style="margin-top:14px">
          <p class="note" style="margin:0 0 6px"><strong>Не получилось распознать</strong></p>
          <p class="note muted" style="margin:0">Сервис распознавания не ответил. Попробуйте ещё раз через минуту.</p>
        </section>
        <div class="grow"></div>
        <div class="stack">
          <button class="primary" id="retry" type="button">Попробовать ещё раз</button>
          <button class="secondary" id="home" type="button">На главную</button>
        </div>`;
      document.getElementById("retry").addEventListener("click", () => recognize(dataUrl, hint));
      document.getElementById("home").addEventListener("click", () => renderHome());
    }
  }

  function renderNoFood(dataUrl) {
    setBack(() => renderHome());
    app.innerHTML = `
      <img class="photo small" src="${dataUrl}" alt="Фото">
      <section class="card empty" style="margin-top:14px">
        <p class="note" style="margin:0 0 6px"><strong>Не вижу еды на фото</strong></p>
        <p class="note muted" style="margin:0">Попробуйте снять тарелку сверху при хорошем свете. Такие попытки не тратят бесплатные распознавания.</p>
      </section>
      <div class="grow"></div>
      <button class="primary" id="home" type="button">Понятно</button>`;
    document.getElementById("home").addEventListener("click", () => renderHome());
  }

  // ---------- Профиль и напоминания ----------
  function renderProfile() {
    setBack(() => renderHome());
    const a = state.profile.answers;
    const r = state.profile.result;
    const rem = JSON.parse(JSON.stringify(state.reminders || { meals: true, water: true, times: { breakfast: "09:00", lunch: "13:30", dinner: "19:00" } }));
    const goalText = { lose: "Снизить вес", keep: "Держать вес", gain: "Набрать массу" }[a.goal] || "Держать вес";

    app.innerHTML = `
      <h2 class="q-title display" style="margin-top:4px">Профиль</h2>

      <section class="card">
        <div class="kv"><span class="muted">Норма</span><strong>${fmt(r.kcal)} ккал</strong></div>
        <div class="kv"><span class="muted">Б / Ж / У</span><strong>${r.protein} / ${r.fat} / ${r.carbs} г</strong></div>
        <div class="kv"><span class="muted">Цель</span><strong>${goalText}${a.target ? " · " + String(a.target).replace(".", ",") + " кг" : ""}</strong></div>
        <div class="kv"><span class="muted">Вес · рост</span><strong>${String(a.weight).replace(".", ",")} кг · ${a.height} см</strong></div>
        <button class="secondary" id="re-onboard" type="button" style="margin-top:12px">Изменить данные</button>
      </section>

      <div class="section-title" style="margin-top:8px"><span>Напоминания в Telegram</span></div>
      <section class="card">
        <label class="switch-row">
          <span><strong>Еда</strong><br><span class="small muted">Только если приём пищи ещё не записан</span></span>
          <input type="checkbox" class="switch" id="rem-meals" ${rem.meals ? "checked" : ""}>
        </label>
        <div class="times" id="times" ${rem.meals ? "" : "hidden"}>
          <label class="time-row"><span>Завтрак</span><input type="time" id="t-breakfast" value="${rem.times.breakfast}"></label>
          <label class="time-row"><span>Обед</span><input type="time" id="t-lunch" value="${rem.times.lunch}"></label>
          <label class="time-row"><span>Ужин</span><input type="time" id="t-dinner" value="${rem.times.dinner}"></label>
        </div>
        <div class="divider"></div>
        <label class="switch-row">
          <span><strong>Вода</strong><br><span class="small muted">В 11:00, 15:00 и 18:00, если выпито мало</span></span>
          <input type="checkbox" class="switch" id="rem-water" ${rem.water ? "checked" : ""}>
        </label>
      </section>

      <button class="primary" id="save-rem" type="button">Сохранить напоминания</button>
      <button class="secondary" id="sub-btn" type="button" style="margin-top:10px">${state.premium?.active ? "Моя подписка" : "Hayanmi Премиум"}</button>
      ${state.homeScreen && state.homeScreen !== "unsupported"
        ? `<button class="secondary" id="hs-profile" type="button" style="margin-top:10px" ${state.homeScreen === "added" ? "disabled" : ""}>${state.homeScreen === "added" ? "Hayanmi уже на главном экране" : "Добавить на главный экран"}</button>`
        : ""}
      ${tabbarHtml("")}`;
    bindTabs();
    const hsP = document.getElementById("hs-profile");
    if (hsP && state.homeScreen !== "added") hsP.addEventListener("click", addToHome);
    document.getElementById("sub-btn").addEventListener("click", () => {
      haptic();
      state.premium?.active ? renderSubscription() : renderPaywall();
    });

    const mealsBox = document.getElementById("rem-meals");
    mealsBox.addEventListener("change", () => {
      haptic("select");
      document.getElementById("times").hidden = !mealsBox.checked;
    });
    document.getElementById("rem-water").addEventListener("change", () => haptic("select"));

    document.getElementById("re-onboard").addEventListener("click", () => {
      haptic();
      draft = { ...state.profile.answers, _editing: true };
      stepIndex = 0;
      renderStep();
    });

    document.getElementById("save-rem").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const val = (id, fallback) => {
        const v = document.getElementById(id).value;
        return /^\d{2}:\d{2}$/.test(v) ? v : fallback;
      };
      const reminders = {
        meals: mealsBox.checked,
        water: document.getElementById("rem-water").checked,
        times: {
          breakfast: val("t-breakfast", rem.times.breakfast),
          lunch: val("t-lunch", rem.times.lunch),
          dinner: val("t-dinner", rem.times.dinner),
        },
      };
      btn.disabled = true;
      btn.textContent = "Сохраняю…";
      try {
        const data = await api("/reminders", { method: "POST", body: { reminders } });
        state.reminders = data.reminders;
        haptic("success");
        btn.textContent = "Сохранено ✓";
        setTimeout(() => { btn.disabled = false; btn.textContent = "Сохранить напоминания"; }, 1500);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Сохранить";
        showAlert("Не получилось сохранить. Попробуйте ещё раз.");
      }
    });
  }

  // ---------- Премиум: показ пейволла время от времени ----------
  const PAYWALL_EVERY_DAYS = 3;

  async function shouldAutoPaywall() {
    if (!state.premium || state.premium.active) return false;
    const last = Number(await storage.get("paywall_last")) || 0;
    return Date.now() - last > PAYWALL_EVERY_DAYS * 864e5;
  }

  function markPaywallShown() {
    storage.set("paywall_last", String(Date.now()));
  }

  // ---------- Премиум: пейволл ----------
  const STAR = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L14.6 9L21 9.5L16 13.6L17.6 20L12 16.5L6.4 20L8 13.6L3 9.5L9.4 9Z" fill="#F4C84A"/></svg>`;
  const CHECK = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5L10 17L19 7" fill="none" stroke="#D4F25A" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const LOGO = `<svg width="44" height="44" viewBox="0 0 96 96" aria-label="Hayanmi"><circle cx="48" cy="48" r="40" fill="none" stroke="#2C2E33" stroke-width="8"/><circle cx="48" cy="48" r="40" fill="none" stroke="#D4F25A" stroke-width="8" stroke-linecap="round" stroke-dasharray="180 252" transform="rotate(-90 48 48)"/><path d="M37 29V67M37 51C37 45 41 42 46 42C52 42 59 45 59 53V67" fill="none" stroke="#F3F1EA" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const dateText = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

  function renderPaywall(reason) {
    let first = true;
    // Плавное закрытие: экран уезжает вниз, потом открываем главную
    const close = async () => {
      haptic();
      const pw = document.getElementById("paywall");
      if (pw && !pw.classList.contains("leave")) {
        pw.classList.add("leave");
        await new Promise((r) => setTimeout(r, reduceMotion() ? 0 : 220));
      }
      renderHome();
    };
    setBack(close);
    const prices = state.prices || { month: 250, year: 1500, trialDays: 3 };
    const perMonth = Math.round(prices.year / 12);
    const save = Math.round((1 - prices.year / (prices.month * 12)) * 100);
    const trial = state.premium?.trialAvailable;
    let plan = "year";

    function draw() {
      app.innerHTML = `
        <div class="paywall ${first ? "enter" : ""}" id="paywall">
        <div class="pw-glow" aria-hidden="true"></div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          ${LOGO}
          <button class="icon-btn close" id="close" type="button" aria-label="Закрыть">${ICON_X}</button>
        </div>
        <div style="margin:18px 0 20px">
          <h2 class="q-title display" style="font-size:30px;margin-bottom:10px">Hayanmi<br><span style="color:var(--accent)">Премиум</span></h2>
          <p class="q-sub" style="margin:0">${reason === "limit"
            ? "Бесплатные распознавания закончились. С Премиумом — без ограничений."
            : reason === "onboarding"
              ? "Норма готова! Считайте калории по фото без ограничений."
              : "Считай всё одним фото — без ограничений."}</p>
        </div>
        <div class="benefits">
          <div>${CHECK}<span>Безлимитное распознавание еды по фото</span></div>
          <div>${CHECK}<span>Новые премиум-функции: ИИ-коуч, голодание, замеры</span></div>
          <div>${CHECK}<span>Оплата звёздами прямо в Telegram</span></div>
        </div>
        <div class="plans" role="radiogroup" aria-label="Тариф">
          <button class="plan ${plan === "year" ? "on" : ""}" type="button" role="radio" aria-checked="${plan === "year"}" data-plan="year">
            <div><div class="pt">Год</div><div class="pd">≈${perMonth} Stars в месяц · разовая оплата</div></div>
            <div class="pp">${STAR}${fmt(prices.year)}</div>
            ${save > 0 ? `<div class="save">−${save}%</div>` : ""}
          </button>
          <button class="plan ${plan === "month" ? "on" : ""}" type="button" role="radio" aria-checked="${plan === "month"}" data-plan="month">
            <div><div class="pt">Месяц</div><div class="pd">Продление каждые 30 дней, можно отменить</div></div>
            <div class="pp">${STAR}${fmt(prices.month)}</div>
          </button>
        </div>
        <div class="grow"></div>
        <div class="stack">
          <button class="primary" id="buy" type="button">Оформить за ${fmt(plan === "year" ? prices.year : prices.month)} Stars</button>
          ${trial ? `<button class="secondary" id="trial" type="button">Попробовать ${prices.trialDays} дня бесплатно</button>` : ""}
          <button class="link-btn" id="later" type="button">Не сейчас</button>
          <div class="small muted" style="text-align:center">Условия — команда /terms в чате с ботом · помощь — /paysupport</div>
        </div>
        </div>`;
      first = false;

      app.querySelectorAll("[data-plan]").forEach((b) =>
        b.addEventListener("click", () => { haptic("select"); plan = b.dataset.plan; draw(); })
      );
      document.getElementById("buy").addEventListener("click", (e) => buy(plan, e.currentTarget));
      if (trial) document.getElementById("trial").addEventListener("click", startTrial);
      document.getElementById("close").addEventListener("click", close);
      document.getElementById("later").addEventListener("click", close);
    }

    draw();
  }

  async function buy(plan, btn) {
    if (!tg?.openInvoice) return showAlert("Обновите Telegram, чтобы оплатить подписку.");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Открываю оплату…";
    let link;
    try {
      ({ link } = await api("/invoice", { method: "POST", body: { plan } }));
    } catch (e) {
      btn.disabled = false;
      btn.textContent = label;
      return showAlert("Не получилось открыть оплату. Попробуйте ещё раз.");
    }
    tg.openInvoice(link, (status) => {
      if (status === "paid") return waitForPremium();
      btn.disabled = false;
      btn.textContent = label;
      if (status === "failed") showAlert("Оплата не прошла. Попробуйте ещё раз.");
    });
  }

  // После оплаты Telegram уведомляет сервер через бота — ждём, пока Премиум включится
  async function waitForPremium() {
    setBack(null);
    app.innerHTML = `<div class="loading" style="margin-top:30vh"><div class="spinner" aria-hidden="true"></div><div>Активирую Премиум…</div></div>`;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        await loadState();
        if (state.premium?.active) {
          haptic("success");
          return renderPremiumDone();
        }
      } catch (e) {}
    }
    renderMessage("Оплата получена", "Премиум включится в течение минуты. Если этого не произошло — напишите /paysupport в чате с ботом.", true);
  }

  function renderPremiumDone() {
    setBack(null);
    app.innerHTML = `
      <div style="margin-top:24px">${LOGO}</div>
      <h2 class="q-title display" style="margin-top:18px">Премиум активирован</h2>
      <p class="q-sub">Доступ до ${dateText(state.premium.expiresAt)}. Распознавайте еду без ограничений.</p>
      <div class="grow"></div>
      <button class="primary" id="home" type="button">Отлично</button>`;
    document.getElementById("home").addEventListener("click", () => renderHome());
  }

  async function startTrial(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await api("/trial", { method: "POST" });
      await loadState();
      haptic("success");
      renderPremiumDone();
    } catch (err) {
      btn.disabled = false;
      showAlert(err.code === "trial_used" ? "Пробный период уже использован." : "Не получилось. Попробуйте ещё раз.");
    }
  }

  // ---------- Премиум: управление подпиской ----------
  function renderSubscription() {
    setBack(() => renderHome());
    const p = state.premium;
    const prices = state.prices || { month: 250, year: 1500 };
    const planName = p.plan === "trial" ? "Пробный период" : p.plan === "year" ? "Год" : "Месяц";

    let details = `<p class="note" style="margin:0">Действует до <strong>${dateText(p.expiresAt)}</strong></p>`;
    let action = "";
    if (p.plan === "month" && p.recurring && !p.canceled) {
      details += `<p class="note muted" style="margin:6px 0 0">Следующее списание — ${dateText(p.expiresAt)}, ${fmt(prices.month)} Stars</p>`;
      action = `<button class="secondary" id="cancel" type="button">Отменить автопродление</button>`;
    } else if (p.plan === "month" && p.canceled) {
      details += `<p class="note muted" style="margin:6px 0 0">Автопродление отключено. После этой даты Премиум выключится.</p>`;
    } else if (p.plan === "trial") {
      details += `<p class="note muted" style="margin:6px 0 0">После пробного периода звёзды не списываются автоматически.</p>`;
      action = `<button class="primary" id="upgrade" type="button">Оформить подписку</button>`;
    }

    app.innerHTML = `
      <div style="margin-top:8px">${LOGO}</div>
      <h2 class="q-title display" style="margin-top:18px">Hayanmi Премиум</h2>
      <section class="card" style="margin-top:12px">
        <div class="small muted" style="margin-bottom:6px">${planName}</div>
        ${details}
      </section>
      <div class="grow"></div>
      <div class="stack">
        ${action}
        <div class="small muted" style="text-align:center">Вопросы по оплате — /paysupport в чате с ботом</div>
      </div>`;

    const cancelBtn = document.getElementById("cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", async () => {
      const ok = await showConfirm("Отменить автопродление? Премиум сохранится до конца оплаченного периода.");
      if (!ok) return;
      cancelBtn.disabled = true;
      try {
        await api("/cancel", { method: "POST" });
        await loadState();
        haptic("success");
        renderSubscription();
      } catch (e) {
        cancelBtn.disabled = false;
        showAlert("Не получилось отменить. Напишите /paysupport в чате с ботом.");
      }
    });
    const up = document.getElementById("upgrade");
    if (up) up.addEventListener("click", () => {
      // во время пробного периода пейволл без кнопки «попробовать»
      state.premium = { ...state.premium, trialAvailable: false };
      renderPaywall();
    });
  }

  // ---------- Фото: результат с ползунками ----------
  function renderRecognized(dataUrl, aiItems, pendingId) {
    const items = aiItems.map((it) => ({ ...it, grams: Math.round(it.grams) }));
    let meal = defaultMeal();

    const calc = (it) => ({
      kcal: (it.per100.kcal * it.grams) / 100,
      protein: (it.per100.protein * it.grams) / 100,
      fat: (it.per100.fat * it.grams) / 100,
      carbs: (it.per100.carbs * it.grams) / 100,
    });

    function draw() {
      setBack(() => renderHome());
      const tot = items.reduce((t, it) => {
        const c = calc(it);
        return { kcal: t.kcal + c.kcal, p: t.p + c.protein, f: t.f + c.fat, c: t.c + c.carbs };
      }, { kcal: 0, p: 0, f: 0, c: 0 });

      app.innerHTML = `
        ${dataUrl
          ? `<img class="photo small" src="${dataUrl}" alt="Фото еды">`
          : `<h2 class="q-title display" style="font-size:22px;margin:4px 0 0">Распознано в чате</h2>`}
        <div class="chips" role="group" aria-label="Приём пищи">
          ${MEALS.map((m) => `<button class="chip ${m.id === meal ? "on" : ""}" type="button" data-meal="${m.id}" aria-pressed="${m.id === meal}">${m.t}</button>`).join("")}
        </div>
        <div class="totals">
          <div><div class="v display" style="color:var(--accent)" id="t-kcal">${fmt(tot.kcal)}</div><div class="k muted">ккал</div></div>
          <div><div class="v" id="t-p">${fmt(tot.p)} г</div><div class="k" style="color:var(--protein)">Белки</div></div>
          <div><div class="v" id="t-f">${fmt(tot.f)} г</div><div class="k" style="color:var(--fat)">Жиры</div></div>
          <div><div class="v" id="t-c">${fmt(tot.c)} г</div><div class="k" style="color:var(--carbs)">Углеводы</div></div>
        </div>
        ${items.length ? items.map((it, i) => {
          const c = calc(it);
          const max = Math.max(300, Math.ceil((it.grams * 2) / 50) * 50);
          return `
            <div class="item">
              <div class="top">
                <label class="name" for="r${i}">${esc(it.name)}</label>
                <span class="val" id="v${i}">${fmt(it.grams)} г · ${fmt(c.kcal)} ккал</span>
                <button class="icon-btn" type="button" data-rm="${i}" aria-label="Убрать: ${esc(it.name)}">${ICON_X}</button>
              </div>
              <input id="r${i}" type="range" min="5" max="${max}" step="5" value="${it.grams}" data-i="${i}">
            </div>`;
        }).join("") : `<p class="note muted">Все блюда убраны.</p>`}
        <div class="grow"></div>
        <div class="stack">
          <button class="primary" id="add" type="button" ${items.length ? "" : "disabled"}>Добавить в дневник</button>
        </div>`;

      app.querySelectorAll("[data-meal]").forEach((b) =>
        b.addEventListener("click", () => { haptic("select"); meal = b.dataset.meal; draw(); })
      );
      app.querySelectorAll("[data-rm]").forEach((b) =>
        b.addEventListener("click", () => { haptic(); items.splice(Number(b.dataset.rm), 1); draw(); })
      );
      app.querySelectorAll("input[type=range]").forEach((r) =>
        r.addEventListener("input", () => {
          const i = Number(r.dataset.i);
          items[i].grams = Number(r.value);
          const c = calc(items[i]);
          document.getElementById("v" + i).textContent = `${fmt(items[i].grams)} г · ${fmt(c.kcal)} ккал`;
          const t = items.reduce((t, it) => {
            const cc = calc(it);
            return { kcal: t.kcal + cc.kcal, p: t.p + cc.protein, f: t.f + cc.fat, c: t.c + cc.carbs };
          }, { kcal: 0, p: 0, f: 0, c: 0 });
          document.getElementById("t-kcal").textContent = fmt(t.kcal);
          document.getElementById("t-p").textContent = fmt(t.p) + " г";
          document.getElementById("t-f").textContent = fmt(t.f) + " г";
          document.getElementById("t-c").textContent = fmt(t.c) + " г";
        })
      );

      const addBtn = document.getElementById("add");
      addBtn.addEventListener("click", async () => {
        addBtn.disabled = true;
        addBtn.textContent = "Добавляю…";
        const payload = items.map((it) => {
          const c = calc(it);
          const r1 = (v) => Math.round(v * 10) / 10;
          return { name: it.name, grams: it.grams, kcal: Math.round(c.kcal), protein: r1(c.protein), fat: r1(c.fat), carbs: r1(c.carbs) };
        });
        try {
          const data = await api("/entries", { method: "POST", body: { date: state.date, meal, items: payload, pendingId } });
          state.entries = data.entries;
          haptic("success");
          renderHome();
        } catch (e) {
          haptic("error");
          addBtn.disabled = false;
          addBtn.textContent = "Добавить в дневник";
          showAlert("Не получилось сохранить. Попробуйте ещё раз.");
        }
      });
    }

    draw();
  }

  // ---------- Нижнее меню ----------
  const TAB_ICONS = {
    home: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11L12 4L20 11V20H14V14H10V20H4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
    progress: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19L10 12L14 15L20 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    recipes: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5C5 4.7 5.7 4 6.5 4H19V18H6.5C5.7 18 5 18.7 5 19.5M5 5.5V19.5M5 19.5C5 20.3 5.7 21 6.5 21H19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 8H15M9 11.5H13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    profile: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 20C5 16 8 14 12 14C16 14 19 16 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    coach: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5H19A1 1 0 0 1 20 6V15A1 1 0 0 1 19 16H10L6 19.5V16H5A1 1 0 0 1 4 15V6A1 1 0 0 1 5 5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8.5 10.5H8.51M12 10.5H12.01M15.5 10.5H15.51" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>`,
  };
  const TABS = [
    { id: "home", t: "Главная" },
    { id: "progress", t: "Прогресс" },
    { id: "plus" },
    { id: "recipes", t: "Рецепты" },
    { id: "coach", t: "Коуч" },
  ];

  // Залитые иконки для активной вкладки — как в приложениях Apple
  const TAB_ICONS_ON = {
    home: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11.2L12 3.8L20.5 11.2V19.5A1.5 1.5 0 0 1 19 21H14.5V15H9.5V21H5A1.5 1.5 0 0 1 3.5 19.5Z" fill="currentColor"/></svg>`,
    progress: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="currentColor"/><path d="M6.5 16L10 12L13 14L17.5 8.5" fill="none" stroke="#0E0F0C" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    recipes: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3H19.5V17H6.5A1.5 1.5 0 0 0 5 18.5V4.5A1.5 1.5 0 0 1 6.5 3Z" fill="currentColor"/><path d="M5 18.5A1.5 1.5 0 0 0 6.5 20H19.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M9 7.5H15.5M9 11H13.5" stroke="#0E0F0C" stroke-width="2" stroke-linecap="round"/></svg>`,
    coach: `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4H19A2 2 0 0 1 21 6V15A2 2 0 0 1 19 17H10.5L6 20.5V17H5A2 2 0 0 1 3 15V6A2 2 0 0 1 5 4Z" fill="currentColor"/><path d="M8.5 10.5H8.51M12 10.5H12.01M15.5 10.5H15.51" stroke="#0E0F0C" stroke-width="2.6" stroke-linecap="round"/></svg>`,
  };

  function tabbarHtml(active) {
    return `
      <div class="tab-spacer"></div>
      <nav class="tabbar" aria-label="Разделы">
        <div class="tabs-glass">
          ${TABS.map((t) => {
            if (t.id === "plus") {
              return `<button class="tab-plus" id="tab-plus" type="button" aria-label="Добавить еду по фото">
                  <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
                </button>`;
            }
            const on = t.id === active;
            return `<button class="tab ${on ? "on" : ""}" type="button" data-tab="${t.id}" ${on ? 'aria-current="page"' : ""}>
                ${on ? TAB_ICONS_ON[t.id] : TAB_ICONS[t.id]}<span>${t.t}</span>
              </button>`;
          }).join("")}
        </div>
      </nav>
      <input id="file" type="file" accept="image/*" hidden>`;
  }

  function bindTabs() {
    app.querySelectorAll("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        haptic("select");
        const go = { home: renderHome, progress: renderProgress, recipes: renderRecipes, coach: renderCoach }[b.dataset.tab];
        if (go) go();
      })
    );
    const fileInput = document.getElementById("file");
    document.getElementById("tab-plus").addEventListener("click", () => {
      haptic();
      const q = state.quota;
      if (q && !q.unlimited && q.left <= 0) return renderPaywall("limit");
      fileInput.click();
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        renderPhotoPreview(await resizeImage(file));
      } catch (e) {
        showAlert("Не удалось открыть это фото. Попробуйте другое.");
      }
    });
  }

  // ---------- Заставка ----------
  function renderSplash() {
    setBack(null);
    app.innerHTML = `
      <div class="splash" aria-label="Hayanmi загружается">
        <svg class="splash-logo" width="112" height="112" viewBox="0 0 96 96" aria-hidden="true">
          <circle cx="48" cy="48" r="40" fill="none" stroke="#2C2E33" stroke-width="8"/>
          <circle class="splash-ring" cx="48" cy="48" r="40" fill="none" stroke="#D4F25A" stroke-width="8" stroke-linecap="round" stroke-dasharray="251.3" stroke-dashoffset="251.3" transform="rotate(-90 48 48)"/>
          <path d="M37 29V67M37 51C37 45 41 42 46 42C52 42 59 45 59 53V67" fill="none" stroke="#F3F1EA" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="splash-word display">hayanmi</div>
      </div>`;
  }

  // ---------- Приветственные слайды ----------
  const INTRO = [
    {
      title: "Калории с одного фото",
      text: "Сфотографируй тарелку — Hayanmi распознает блюда и посчитает калории, белки, жиры и углеводы.",
      art: `<svg width="240" height="200" viewBox="0 0 240 200" aria-hidden="true">
        <rect x="30" y="16" width="180" height="168" rx="28" fill="#17181A" stroke="#2C2E33" stroke-width="2"/>
        <path d="M52 44V36A8 8 0 0 1 60 28H68M172 28H180A8 8 0 0 1 188 36V44M188 156V164A8 8 0 0 1 180 172H172M68 172H60A8 8 0 0 1 52 164V156" fill="none" stroke="#D4F25A" stroke-width="4" stroke-linecap="round"/>
        <circle cx="120" cy="100" r="48" fill="#202226" stroke="#2C2E33" stroke-width="2"/>
        <circle cx="120" cy="100" r="32" fill="none" stroke="#3A3D42" stroke-width="2"/>
        <circle cx="106" cy="92" r="10" fill="#E6DFCC"/><circle cx="132" cy="94" r="9" fill="#F4A259"/><circle cx="118" cy="114" r="9" fill="#86B6FF"/>
        <rect x="138" y="132" width="84" height="32" rx="16" fill="#D4F25A"/>
        <text x="180" y="153" text-anchor="middle" font-family="Manrope, sans-serif" font-size="14" font-weight="700" fill="#0E0F0C">590 ккал</text>
      </svg>`,
    },
    {
      title: "Твоя личная норма",
      text: "Ответь на 7 коротких вопросов — рассчитаем норму калорий и БЖУ под твою цель.",
      art: `<svg width="240" height="200" viewBox="0 0 240 200" aria-hidden="true">
        <circle cx="120" cy="100" r="74" fill="none" stroke="#2C2E33" stroke-width="14"/>
        <circle cx="120" cy="100" r="74" fill="none" stroke="#D4F25A" stroke-width="14" stroke-linecap="round" stroke-dasharray="300 465" transform="rotate(-90 120 100)"/>
        <text x="120" y="104" text-anchor="middle" font-family="Unbounded, sans-serif" font-size="30" font-weight="700" fill="#F3F1EA">2 250</text>
        <text x="120" y="128" text-anchor="middle" font-family="Manrope, sans-serif" font-size="13" fill="#A6A59E">ккал в день</text>
      </svg>`,
    },
    {
      title: "Всё внутри Telegram",
      text: "Присылай фото еды прямо в чат боту, а напоминания не дадут забыть про еду и воду.",
      art: `<svg width="240" height="200" viewBox="0 0 240 200" aria-hidden="true">
        <rect x="104" y="18" width="112" height="72" rx="18" fill="#2C4A1E"/>
        <rect x="118" y="30" width="84" height="48" rx="10" fill="#3B5E27"/>
        <circle cx="160" cy="54" r="15" fill="#202226"/><circle cx="154" cy="50" r="5" fill="#E6DFCC"/><circle cx="165" cy="57" r="5" fill="#F4A259"/>
        <rect x="24" y="104" width="160" height="80" rx="18" fill="#17181A" stroke="#2C2E33" stroke-width="2"/>
        <text x="42" y="132" font-family="Manrope, sans-serif" font-size="14" font-weight="700" fill="#F3F1EA">Обед · 590 ккал</text>
        <text x="42" y="152" font-family="Manrope, sans-serif" font-size="12" fill="#A6A59E">Осталось 1 240 ккал</text>
        <rect x="42" y="160" width="60" height="16" rx="8" fill="#D4F25A"/>
        <rect x="108" y="160" width="60" height="16" rx="8" fill="#2C2E33"/>
      </svg>`,
    },
  ];

  function renderIntro() {
    setBack(null);
    let i = 0;

    const finish = () => {
      storage.set("intro_seen", "1");
      draft = {};
      stepIndex = 0;
      renderStep();
    };

    function draw() {
      const s = INTRO[i];
      const last = i === INTRO.length - 1;
      app.innerHTML = `
        <div class="intro" id="intro">
          <div class="intro-top">
            ${last ? "<span></span>" : `<button class="link-btn intro-skip" id="skip" type="button">Пропустить</button>`}
          </div>
          <div class="intro-art">${s.art}</div>
          <h2 class="q-title display intro-title">${s.title}</h2>
          <p class="q-sub intro-text">${s.text}</p>
          <div class="dots" aria-hidden="true">${INTRO.map((_, k) => `<span class="${k === i ? "on" : ""}"></span>`).join("")}</div>
          <div class="grow"></div>
          <button class="primary" id="next" type="button">${last ? "Начать" : "Далее"}</button>
        </div>`;

      const next = () => { haptic("select"); if (last) finish(); else { i++; draw(); } };
      const prev = () => { if (i > 0) { haptic("select"); i--; draw(); } };
      document.getElementById("next").addEventListener("click", next);
      const skip = document.getElementById("skip");
      if (skip) skip.addEventListener("click", () => { haptic(); finish(); });

      // Листание свайпом
      const box = document.getElementById("intro");
      let x0 = null;
      box.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
      box.addEventListener("touchend", (e) => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0;
        x0 = null;
        if (dx < -50) next();
        else if (dx > 50) prev();
      });
    }

    draw();
  }

  // ---------- Прогресс ----------
  const WEEKDAYS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  const kg = (v) => (Math.round(v * 10) / 10).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const shortDate = (iso) => { const [, m, d] = iso.split("-"); return `${Number(d)}.${m}`; };

  function weightChart(points, target) {
    const W = 320, H = 150, padL = 8, padR = 44, padT = 16, padB = 24;
    const vals = points.map((p) => p.weight).concat(target ? [target] : []);
    let lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1;
    const X = (i) => points.length === 1 ? (padL + W - padR) / 2 : padL + (i / (points.length - 1)) * (W - padL - padR);
    const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
    const line = points.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.weight).toFixed(1)}`).join(" ");
    const last = points[points.length - 1];
    const lx = X(points.length - 1), ly = Y(last.weight);
    return `
      <svg width="100%" viewBox="0 0 ${W} ${H}" aria-label="График веса">
        ${target ? `<line x1="${padL}" x2="${W - padR}" y1="${Y(target).toFixed(1)}" y2="${Y(target).toFixed(1)}" stroke="#D4F25A" stroke-width="1.5" stroke-dasharray="4 5" opacity="0.7"/>
          <text x="${W - padR + 6}" y="${(Y(target) + 4).toFixed(1)}" font-size="11" fill="#D4F25A" font-family="Manrope, sans-serif">цель</text>` : ""}
        ${points.length > 1 ? `<path d="${line}" fill="none" stroke="#F3F1EA" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
        ${points.map((p, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.weight).toFixed(1)}" r="${i === points.length - 1 ? 5 : 3}" fill="${i === points.length - 1 ? "#D4F25A" : "#F3F1EA"}"/>`).join("")}
        <text x="${Math.min(lx + 8, W - 4)}" y="${(ly - 8).toFixed(1)}" font-size="12" font-weight="700" fill="#F3F1EA" font-family="Manrope, sans-serif" text-anchor="${lx > W - padR - 20 ? "end" : "start"}">${kg(last.weight)}</text>
        <text x="${padL}" y="${H - 4}" font-size="11" fill="#A6A59E" font-family="Manrope, sans-serif">${shortDate(points[0].date)}</text>
        ${points.length > 1 ? `<text x="${W - padR}" y="${H - 4}" font-size="11" fill="#A6A59E" font-family="Manrope, sans-serif" text-anchor="end">${shortDate(last.date)}</text>` : ""}
      </svg>`;
  }

  function weekChart(week, norm) {
    const W = 320, H = 150, padT = 12, padB = 24, gap = 10;
    const max = Math.max(norm * 1.25, ...week.map((d) => d.kcal));
    const bw = (W - gap * (week.length - 1)) / week.length;
    const Y = (v) => padT + (1 - v / max) * (H - padT - padB);
    const ny = Y(norm);
    return `
      <svg width="100%" viewBox="0 0 ${W} ${H}" aria-label="Калории за неделю">
        ${week.map((d, i) => {
          const x = i * (bw + gap);
          const y = Y(d.kcal);
          const today = i === week.length - 1;
          const color = d.kcal > norm * 1.05 ? "#F4A259" : today ? "#D4F25A" : "#5B5E55";
          const wd = WEEKDAYS[new Date(d.date + "T12:00:00").getDay()];
          return `
            ${d.kcal > 0 ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - padB - y).toFixed(1)}" rx="6" fill="${color}"/>` : `<rect x="${x.toFixed(1)}" y="${H - padB - 3}" width="${bw.toFixed(1)}" height="3" rx="1.5" fill="#2C2E33"/>`}
            <text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" font-size="11" text-anchor="middle" fill="${today ? "#F3F1EA" : "#A6A59E"}" font-weight="${today ? 700 : 400}" font-family="Manrope, sans-serif">${wd}</text>`;
        }).join("")}
        <line x1="0" x2="${W}" y1="${ny.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#F3F1EA" stroke-width="1" stroke-dasharray="3 5" opacity="0.6"/>
      </svg>`;
  }

  async function renderProgress() {
    setBack(null);
    app.innerHTML = `
      <div id="progress-root">
        <h1 class="display" style="font-size:22px;margin:4px 0 16px">Прогресс</h1>
        <div class="loading"><div class="spinner" aria-label="Загрузка"></div></div>
      </div>
      ${tabbarHtml("progress")}`;
    bindTabs();

    let data;
    try {
      data = await api("/progress?date=" + state.date);
    } catch (e) {
      const root = document.getElementById("progress-root");
      if (root) root.innerHTML = `<h1 class="display" style="font-size:22px;margin:4px 0 16px">Прогресс</h1>
        <section class="card empty"><p class="note muted" style="margin:0">Не получилось загрузить. Проверьте интернет.</p></section>`;
      return;
    }
    const root = document.getElementById("progress-root");
    if (!root) return; // пользователь уже ушёл на другой экран

    const a = state.profile.answers;
    const r = state.profile.result;
    const weights = data.weights.length ? data.weights : [{ date: state.date, weight: Number(a.weight) }];
    const start = weights[0].weight;
    const current = weights[weights.length - 1].weight;
    const diff = Math.round((current - start) * 10) / 10;
    const target = a.goal !== "keep" && a.target ? Number(a.target) : null;
    const bmi = Calc.bmi(current, a.height);

    let goalLine = "Цель — держать вес";
    let goalPct = null;
    if (target) {
      const total = Math.abs(start - target);
      const done = a.goal === "lose" ? start - current : current - start;
      goalPct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 1;
      const left = Math.abs(current - target);
      goalLine = `До цели ${kg(target)} кг осталось ${kg(left)} кг`;
    }

    const logged = data.week.filter((d) => d.kcal > 0);
    const avg = logged.length ? logged.reduce((s, d) => s + d.kcal, 0) / logged.length : 0;

    root.innerHTML = `
      <h1 class="display" style="font-size:22px;margin:4px 0 16px">Прогресс</h1>

      <div class="stat-row">
        <div class="stat"><div class="v display">${data.streak}</div><div class="k">${data.streak === 1 ? "день" : data.streak >= 2 && data.streak <= 4 ? "дня" : "дней"} подряд</div></div>
        <div class="stat"><div class="v display">${bmi.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}</div><div class="k">ИМТ</div></div>
        <div class="stat"><div class="v display">${fmt(avg)}</div><div class="k">ккал в среднем</div></div>
      </div>

      <section class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <div>
            <div class="small muted">Вес</div>
            <div class="display" style="font-size:30px;margin-top:4px">${kg(current)} <span style="font-size:16px">кг</span></div>
            <div class="small ${diff === 0 ? "muted" : ""}" style="margin-top:4px;color:${diff === 0 ? "" : (a.goal === "gain" ? diff > 0 : diff < 0) ? "var(--accent)" : "var(--fat)"}">
              ${diff === 0 ? "Без изменений с начала" : `${diff > 0 ? "+" : "−"}${kg(Math.abs(diff))} кг с начала`}
            </div>
          </div>
          <button class="water-add" id="log-weight" type="button" style="background:var(--accent)">Записать вес</button>
        </div>
        ${weightChart(weights, target)}
        <div class="small muted" style="margin-top:6px">${goalLine}</div>
        ${goalPct !== null ? `<div class="bar" style="margin-top:8px"><div style="width:${Math.round(goalPct * 100)}%;background:var(--accent)"></div></div>` : ""}
      </section>

      <section class="card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">
          <strong>Калории за 7 дней</strong>
          <span class="small muted">норма ${fmt(r.kcal)}</span>
        </div>
        ${weekChart(data.week, r.kcal)}
      </section>`;

    document.getElementById("log-weight").addEventListener("click", () => { haptic(); renderWeightInput(current); });
  }

  // ---------- Запись веса ----------
  function renderWeightInput(current) {
    setBack(() => renderProgress());
    app.innerHTML = `
      <h2 class="q-title display" style="margin-top:4px">Ваш вес сегодня</h2>
      <p class="q-sub">Лучше взвешиваться утром, до завтрака.</p>
      ${rulerHtml("weight", Number(current), "кг", "Вес в килограммах")}
      <div class="error" id="err" role="alert" style="text-align:center"></div>
      <div class="grow"></div>
      <button class="primary" id="save" type="button">Сохранить</button>`;

    const input = document.getElementById("num");
    const errEl = document.getElementById("err");
    mountRuler("weight", Number(current), () => { errEl.textContent = ""; });
    input.addEventListener("input", () => { errEl.textContent = ""; });

    const save = async () => {
      const w = Math.round(parseFloat(input.value.trim().replace(",", ".")) * 10) / 10;
      if (!isFinite(w) || w < 35 || w > 250) { errEl.textContent = "Введите вес от 35 до 250 кг."; haptic("error"); return; }
      const btn = document.getElementById("save");
      btn.disabled = true;
      btn.textContent = "Сохраняю…";
      try {
        await api("/weight", { method: "POST", body: { date: state.date, weight: w } });

        // Пересчитываем норму под новый вес; если цель достигнута — переходим на поддержание
        const answers = { ...state.profile.answers, weight: w };
        const reached = answers.target && (
          (answers.goal === "lose" && w <= answers.target) || (answers.goal === "gain" && w >= answers.target)
        );
        if (reached) { answers.goal = "keep"; delete answers.target; }
        const oldKcal = state.profile.result.kcal;
        const result = Calc.calculate(answers);
        const profile = { ...state.profile, answers, result, savedAt: new Date().toISOString() };
        await api("/profile", { method: "POST", body: { profile } });
        state.profile = profile;
        if (state.water) state.water.goal = Math.min(3500, Math.max(1500, Math.round((w * 30) / 100) * 100));
        haptic("success");

        if (reached) return renderGoalReached(w);
        if (Math.abs(result.kcal - oldKcal) >= 10) showAlert(`Норма обновлена под новый вес: ${fmt(result.kcal)} ккал в день.`);
        renderProgress();
      } catch (e) {
        haptic("error");
        btn.disabled = false;
        btn.textContent = "Сохранить";
        showAlert("Не получилось сохранить. Попробуйте ещё раз.");
      }
    };
    document.getElementById("save").addEventListener("click", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  }

  function renderGoalReached(w) {
    setBack(null);
    app.innerHTML = `
      <div style="margin-top:24px">${LOGO}</div>
      <h2 class="q-title display" style="margin-top:18px">Цель достигнута!</h2>
      <p class="q-sub">${kg(w)} кг — отличный результат. Мы перевели норму на поддержание веса: ${fmt(state.profile.result.kcal)} ккал в день.</p>
      <div class="grow"></div>
      <div class="stack">
        <button class="primary" id="new-goal" type="button">Поставить новую цель</button>
        <button class="secondary" id="later" type="button">Позже</button>
      </div>`;
    document.getElementById("new-goal").addEventListener("click", () => {
      draft = { ...state.profile.answers, _editing: true };
      stepIndex = visibleSteps().indexOf("goal");
      if (stepIndex < 0) stepIndex = 0;
      renderStep();
    });
    document.getElementById("later").addEventListener("click", () => renderProgress());
  }

  // ---------- ИИ-коуч ----------
  const PERSONA_INFO = {
    alina: { name: "Алина", about: "Тёплая и поддерживающая. Хвалит за маленькие шаги.", color: "#86B6FF" },
    max: { name: "Макс", about: "Прямой спортивный тренер. Коротко и по делу.", color: "#D4F25A" },
    karim: { name: "Карим", about: "Спокойный нутрициолог. Объясняет, почему это работает.", color: "#E6DFCC" },
    sonya: { name: "Соня", about: "С юмором, но советы серьёзные.", color: "#F4A259" },
  };
  const QUICK = ["Оцени мой день", "Что съесть на ужин?", "Как добрать белок?", "Почему вес стоит?"];
  const coach = { loaded: false, persona: "alina", messages: [], freeLeft: null, sending: false };

  const avatar = (id, size = 40) => {
    const p = PERSONA_INFO[id] || PERSONA_INFO.alina;
    return `<span class="avatar" style="width:${size}px;height:${size}px;background:${p.color};font-size:${Math.round(size * 0.42)}px">${p.name[0]}</span>`;
  };
  const msgHtml = (m) => `<div class="msg ${m.role === "user" ? "me" : "coach"}">${esc(m.text)}</div>`;

  async function renderCoach() {
    setBack(() => renderHome());
    if (!coach.loaded) {
      app.innerHTML = `<div class="loading" style="margin-top:30vh"><div class="spinner" aria-label="Загрузка"></div></div>`;
      try {
        const data = await api("/coach");
        Object.assign(coach, { loaded: true, persona: data.persona, messages: data.messages, freeLeft: data.freeLeft });
      } catch (e) {
        return renderMessage("Коуч недоступен", "Не получилось загрузить чат. Проверьте интернет.", false);
      }
    }
    drawCoach();
  }

  function drawCoach() {
    const p = PERSONA_INFO[coach.persona] || PERSONA_INFO.alina;
    const locked = coach.freeLeft === 0;
    const firstName = tg?.initDataUnsafe?.user?.first_name;
    const hello = `Привет${firstName ? ", " + firstName : ""}! Я ${p.name}, твой коуч по питанию. Я вижу твой дневник и норму — спрашивай что угодно про еду, вес и привычки.`;

    app.innerHTML = `
      <header class="coach-head">
        ${avatar(coach.persona, 44)}
        <div style="flex:1;min-width:0">
          <div style="font-size:17px;font-weight:700">${p.name}</div>
          <div class="small muted">ИИ-коуч · видит твой дневник</div>
        </div>
        <button class="badge" id="change" type="button">Сменить</button>
      </header>

      <div class="chat" id="chat">
        <div class="msg coach">${esc(hello)}</div>
        ${coach.messages.map(msgHtml).join("")}
        ${coach.sending ? `<div class="msg coach typing" aria-label="Коуч печатает"><span></span><span></span><span></span></div>` : ""}
      </div>

      ${!coach.messages.length && !coach.sending && !locked
        ? `<div class="quick">${QUICK.map((q) => `<button class="chip small" type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>`
        : ""}

      <div class="grow"></div>
      ${locked
        ? `<section class="promo" style="margin-top:12px">
             <div class="promo-title display">Бесплатные сообщения закончились</div>
             <p class="promo-text">С Hayanmi Премиум общайся с коучем без ограничений — здесь и прямо в чате с ботом.</p>
             <button class="primary promo-btn" id="get-premium" type="button">Подключить Премиум</button>
           </section>`
        : `<div class="composer">
             ${coach.freeLeft !== null ? `<div class="small muted" style="margin:0 4px 8px">Бесплатных сообщений осталось: ${coach.freeLeft}</div>` : ""}
             <div class="composer-row">
               <label for="msg" class="sr-only">Сообщение коучу</label>
               <textarea id="msg" rows="1" maxlength="1000" placeholder="Спроси коуча…" ${coach.sending ? "disabled" : ""}></textarea>
               <button class="send" id="send" type="button" aria-label="Отправить" ${coach.sending ? "disabled" : ""}>
                 <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12H19M13 6L19 12L13 18" fill="none" stroke="#0E0F0C" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
               </button>
             </div>
           </div>`}`;

    window.scrollTo(0, document.body.scrollHeight);

    document.getElementById("change").addEventListener("click", () => { haptic(); renderCoachPicker(); });
    app.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => sendCoach(b.dataset.q)));
    const gp = document.getElementById("get-premium");
    if (gp) gp.addEventListener("click", () => { haptic(); renderPaywall(); });

    const input = document.getElementById("msg");
    if (input) {
      const grow = () => { input.style.height = "auto"; input.style.height = Math.min(120, input.scrollHeight) + "px"; };
      input.addEventListener("input", grow);
      document.getElementById("send").addEventListener("click", () => sendCoach(input.value));
    }
  }

  async function sendCoach(text) {
    text = String(text || "").trim();
    if (!text || coach.sending) return;
    haptic("select");
    coach.messages.push({ role: "user", text });
    coach.sending = true;
    drawCoach();
    try {
      const data = await api("/coach/send", { method: "POST", body: { text, date: state.date } });
      coach.messages.push({ role: "coach", text: data.reply });
      coach.freeLeft = data.freeLeft;
      haptic("success");
    } catch (e) {
      coach.messages.pop(); // вопрос не ушёл — убираем
      if (e.code === "premium") coach.freeLeft = 0;
      else showAlert(e.code === "daily_limit"
        ? "На сегодня лимит сообщений коучу исчерпан. Продолжим завтра!"
        : "Коуч не ответил. Попробуйте ещё раз через минуту.");
    } finally {
      coach.sending = false;
      drawCoach();
    }
  }

  function renderCoachPicker() {
    setBack(() => drawCoach());
    app.innerHTML = `
      <h2 class="q-title display" style="margin-top:4px">Выбери коуча</h2>
      <p class="q-sub">Все коучи видят твой дневник и дают советы под твою норму. Отличается только характер.</p>
      <div class="options">
        ${Object.entries(PERSONA_INFO).map(([id, p]) => `
          <button class="option persona ${id === coach.persona ? "selected" : ""}" type="button" data-persona="${id}">
            ${avatar(id, 44)}
            <span style="display:flex;flex-direction:column;gap:4px"><span class="t">${p.name}</span><span class="d">${p.about}</span></span>
          </button>`).join("")}
      </div>
      <button class="link-btn" id="clear" type="button" style="margin-top:14px">Очистить историю переписки</button>`;

    app.querySelectorAll("[data-persona]").forEach((b) => b.addEventListener("click", async () => {
      haptic("select");
      const id = b.dataset.persona;
      try {
        await api("/coach/persona", { method: "POST", body: { persona: id } });
        coach.persona = id;
        drawCoach();
      } catch (e) {
        showAlert("Не получилось сменить коуча. Попробуйте ещё раз.");
      }
    }));
    document.getElementById("clear").addEventListener("click", async () => {
      if (!(await showConfirm("Удалить всю переписку с коучем?"))) return;
      try {
        await api("/coach/clear", { method: "POST" });
        coach.messages = [];
        haptic("success");
        drawCoach();
      } catch (e) {
        showAlert("Не получилось очистить. Попробуйте ещё раз.");
      }
    });
  }

  // ---------- Рецепты ----------
  const CATS = [
    { id: "all", t: "Все" }, { id: "breakfast", t: "Завтрак" }, { id: "lunch", t: "Обед" },
    { id: "dinner", t: "Ужин" }, { id: "snack", t: "Перекус" },
  ];
  const RTAGS = [
    { id: "protein", t: "Много белка" }, { id: "light", t: "До 400 ккал" },
    { id: "quick", t: "Быстро" }, { id: "veg", t: "Без мяса" },
  ];
  const LOCK = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="#A6A59E" stroke-width="2"/><path d="M8 11V8A4 4 0 0 1 16 8V11" fill="none" stroke="#A6A59E" stroke-width="2"/></svg>`;
  const CLOCK = `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7V12L15 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

  let catalog = null;
  const recipeFilter = { cat: "all", tags: [] };
  const hasPremiumAccess = () => !!(state.access?.premium || state.premium?.active);

  async function loadCatalog() {
    if (catalog) return catalog;
    const res = await fetch("/recipes.json");
    catalog = await res.json();
    return catalog;
  }

  function leftToday() {
    const r = state.profile.result;
    const eaten = totalsOf(state.entries);
    return { kcal: Math.round(r.kcal - eaten.kcal), protein: Math.round(r.protein - eaten.p) };
  }

  async function renderRecipes() {
    setBack(null);
    app.innerHTML = `
      <div id="recipes-root">
        <h1 class="display" style="font-size:22px;margin:4px 0 16px">Рецепты</h1>
        <div class="loading"><div class="spinner" aria-label="Загрузка"></div></div>
      </div>
      ${tabbarHtml("recipes")}`;
    bindTabs();

    let list;
    try {
      list = await loadCatalog();
    } catch (e) {
      const root = document.getElementById("recipes-root");
      if (root) root.innerHTML = `<h1 class="display" style="font-size:22px;margin:4px 0 16px">Рецепты</h1>
        <section class="card empty"><p class="note muted" style="margin:0">Не получилось загрузить рецепты. Проверьте интернет.</p></section>`;
      return;
    }
    const root = document.getElementById("recipes-root");
    if (!root) return;

    const left = leftToday();
    const premium = hasPremiumAccess();
    const shown = list.filter((r) =>
      (recipeFilter.cat === "all" || r.cat === recipeFilter.cat) &&
      recipeFilter.tags.every((t) => r.tags.includes(t))
    );

    root.innerHTML = `
      <h1 class="display" style="font-size:22px;margin:4px 0 16px">Рецепты</h1>

      <section class="promo chef">
        <div class="promo-top">
          <div class="promo-title display">ИИ-повар</div>
          ${premium ? "" : `<span class="pill">Премиум</span>`}
        </div>
        <p class="promo-text">${left.kcal > 0
          ? `Подберёт блюдо под то, что осталось на сегодня: ${fmt(left.kcal)} ккал.`
          : "Норма на сегодня выполнена — подберу лёгкий перекус."}</p>
        <button class="primary promo-btn" id="chef" type="button">Подобрать рецепт</button>
      </section>

      <div class="chips" role="group" aria-label="Приём пищи">
        ${CATS.map((c) => `<button class="chip ${recipeFilter.cat === c.id ? "on" : ""}" type="button" data-cat="${c.id}" aria-pressed="${recipeFilter.cat === c.id}">${c.t}</button>`).join("")}
      </div>
      <div class="chips" role="group" aria-label="Фильтры" style="margin-top:0">
        ${RTAGS.map((t) => { const on = recipeFilter.tags.includes(t.id); return `<button class="chip small ${on ? "on" : ""}" type="button" data-tag="${t.id}" aria-pressed="${on}">${t.t}</button>`; }).join("")}
      </div>

      ${shown.length ? shown.map((r) => {
        const locked = !r.free && !premium;
        return `
          <button class="recipe-card" type="button" data-rid="${r.id}">
            <div class="rc-main">
              <div class="rc-title">${esc(r.title)}</div>
              <div class="rc-meta">${fmt(r.kcal)} ккал · Б ${fmt(r.protein)} · Ж ${fmt(r.fat)} · У ${fmt(r.carbs)}</div>
            </div>
            <div class="rc-side">
              ${locked ? LOCK : `<span class="rc-time">${CLOCK}${r.minutes} мин</span>`}
            </div>
          </button>`;
      }).join("") : `<section class="card empty"><p class="note muted" style="margin:0">Нет рецептов с такими фильтрами.</p></section>`}
      ${premium ? "" : `<p class="small muted" style="text-align:center;margin:12px 0 4px">Открыто ${list.filter((r) => r.free).length} из ${list.length}. Все рецепты — в Премиуме.</p>`}`;

    root.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
      haptic("select"); recipeFilter.cat = b.dataset.cat; renderRecipes();
    }));
    root.querySelectorAll("[data-tag]").forEach((b) => b.addEventListener("click", () => {
      haptic("select");
      const t = b.dataset.tag;
      recipeFilter.tags = recipeFilter.tags.includes(t) ? recipeFilter.tags.filter((x) => x !== t) : [...recipeFilter.tags, t];
      renderRecipes();
    }));
    root.querySelectorAll("[data-rid]").forEach((b) => b.addEventListener("click", () => {
      haptic();
      const r = list.find((x) => String(x.id) === b.dataset.rid);
      if (!r.free && !hasPremiumAccess()) return renderPaywall();
      renderCatalogRecipe(r);
    }));
    document.getElementById("chef").addEventListener("click", () => {
      haptic();
      if (!hasPremiumAccess()) return renderPaywall();
      renderChef();
    });
  }

  // Общий вид страницы рецепта (для каталога и для ИИ-повара)
  function renderRecipeView(v) {
    setBack(v.onBack);
    let meal = v.meal || defaultMeal();

    function draw() {
      app.innerHTML = `
        ${v.badge ? `<div class="pill" style="align-self:flex-start;margin-bottom:10px">${v.badge}</div>` : ""}
        <h2 class="q-title display" style="font-size:24px;margin:4px 0 8px">${esc(v.title)}</h2>
        <div class="small muted" style="display:flex;gap:12px;align-items:center;margin-bottom:14px">
          <span class="rc-time">${CLOCK}${v.minutes} мин</span><span>${esc(v.portionText)}</span>
        </div>
        <div class="totals">
          <div><div class="v display" style="color:var(--accent)">${fmt(v.kcal)}</div><div class="k muted">ккал</div></div>
          <div><div class="v">${fmt(v.protein)} г</div><div class="k" style="color:var(--protein)">Белки</div></div>
          <div><div class="v">${fmt(v.fat)} г</div><div class="k" style="color:var(--fat)">Жиры</div></div>
          <div><div class="v">${fmt(v.carbs)} г</div><div class="k" style="color:var(--carbs)">Углеводы</div></div>
        </div>
        <div class="section-title"><span>Ингредиенты</span><span class="muted">${esc(v.ingredientsNote || "")}</span></div>
        <section class="card ingr">
          ${v.ingredients.map((i) => `<div class="kv"><span>${esc(i.name)}</span><span class="muted">${esc(i.amount)}</span></div>`).join("")}
        </section>
        <div class="section-title"><span>Приготовление</span></div>
        <ol class="steps">${v.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>

        <div class="section-title" style="margin-top:14px"><span>Добавить в дневник</span></div>
        <div class="chips" role="group" aria-label="Приём пищи" style="margin-top:0">
          ${MEALS.map((m) => `<button class="chip ${m.id === meal ? "on" : ""}" type="button" data-meal="${m.id}" aria-pressed="${m.id === meal}">${m.t}</button>`).join("")}
        </div>
        <div class="stack" style="margin-top:4px">
          <button class="primary" id="add-recipe" type="button">Добавить · ${fmt(v.kcal)} ккал</button>
          ${v.extraButton ? `<button class="secondary" id="extra" type="button">${v.extraButton.text}</button>` : ""}
        </div>`;

      app.querySelectorAll("[data-meal]").forEach((b) =>
        b.addEventListener("click", () => { haptic("select"); meal = b.dataset.meal; draw(); })
      );
      if (v.extraButton) document.getElementById("extra").addEventListener("click", () => v.extraButton.onClick(meal));

      const addBtn = document.getElementById("add-recipe");
      addBtn.addEventListener("click", async () => {
        addBtn.disabled = true;
        addBtn.textContent = "Добавляю…";
        try {
          const data = await api("/entries", {
            method: "POST",
            body: {
              date: state.date, meal, source: v.source,
              items: [{ name: v.title, grams: v.grams, kcal: v.kcal, protein: v.protein, fat: v.fat, carbs: v.carbs }],
            },
          });
          state.entries = data.entries;
          haptic("success");
          renderHome();
        } catch (e) {
          haptic("error");
          addBtn.disabled = false;
          addBtn.textContent = `Добавить · ${fmt(v.kcal)} ккал`;
          showAlert("Не получилось добавить. Попробуйте ещё раз.");
        }
      });
    }

    draw();
  }

  function renderCatalogRecipe(r) {
    const portions = r.servings === 1 ? "1 порция" : r.servings >= 2 && r.servings <= 4 ? `${r.servings} порции` : `${r.servings} порций`;
    renderRecipeView({
      title: r.title, minutes: r.minutes, source: "recipe",
      portionText: `порция ≈ ${fmt(r.grams)} г`,
      grams: r.grams, kcal: r.kcal, protein: r.protein, fat: r.fat, carbs: r.carbs,
      ingredientsNote: `на ${portions}`,
      ingredients: r.ingredients.map((i) => ({ name: i.name, amount: `${fmt(i.g)} г${i.note ? ` (${i.note})` : ""}` })),
      steps: r.steps,
      meal: ["breakfast", "lunch", "dinner", "snack"].includes(r.cat) ? r.cat : undefined,
      onBack: () => renderRecipes(),
    });
  }

  // ---------- ИИ-повар ----------
  function renderChef(prefMeal, prefWishes) {
    setBack(() => renderRecipes());
    let meal = prefMeal || defaultMeal();
    const left = leftToday();

    function draw() {
      const wishes = document.getElementById("wishes")?.value ?? prefWishes ?? "";
      app.innerHTML = `
        <h2 class="q-title display" style="margin-top:4px">ИИ-повар</h2>
        <p class="q-sub">${left.kcal > 0
          ? `На сегодня осталось ${fmt(left.kcal)} ккал и ${fmt(Math.max(0, left.protein))} г белка. Подберу блюдо, которое впишется в норму.`
          : "Норма на сегодня уже выполнена — подберу лёгкий вариант."}</p>
        <div class="label" style="margin-top:0">Для какого приёма пищи</div>
        <div class="chips" role="group" aria-label="Приём пищи" style="margin-top:0">
          ${MEALS.map((m) => `<button class="chip ${m.id === meal ? "on" : ""}" type="button" data-meal="${m.id}" aria-pressed="${m.id === meal}">${m.t}</button>`).join("")}
        </div>
        <label class="label" for="wishes">Пожелания (необязательно)</label>
        <input class="text-input" id="wishes" type="text" maxlength="200" autocomplete="off" value="${esc(wishes)}" placeholder="Например: из курицы, без молочного, за 15 минут">
        <div class="grow"></div>
        <button class="primary" id="go" type="button">Подобрать рецепт</button>`;

      app.querySelectorAll("[data-meal]").forEach((b) =>
        b.addEventListener("click", () => { haptic("select"); meal = b.dataset.meal; draw(); })
      );
      document.getElementById("go").addEventListener("click", () =>
        cook(meal, document.getElementById("wishes").value.trim(), [])
      );
    }

    draw();
  }

  async function cook(meal, wishes, seen) {
    setBack(null);
    app.innerHTML = `
      <div class="loading" style="margin-top:28vh">
        <div class="spinner" aria-hidden="true"></div>
        <div>ИИ-повар придумывает блюдо…</div>
        <div class="small muted">Обычно 5–15 секунд</div>
      </div>`;
    try {
      const data = await api("/recipes/suggest", {
        method: "POST",
        body: { date: state.date, meal, wishes, avoid: seen.join(", ") },
      });
      const r = data.recipe;
      haptic("success");
      renderRecipeView({
        badge: "ИИ-повар",
        title: r.title, minutes: r.minutes, source: "ai_recipe",
        portionText: `порция ≈ ${fmt(r.grams)} г`,
        grams: r.grams, kcal: r.kcal, protein: r.protein, fat: r.fat, carbs: r.carbs,
        ingredientsNote: "на 1 порцию",
        ingredients: r.ingredients,
        steps: r.steps,
        meal,
        onBack: () => renderChef(meal, wishes),
        extraButton: { text: "Другой вариант", onClick: (m) => cook(m, wishes, [...seen, r.title].slice(-6)) },
      });
    } catch (e) {
      haptic("error");
      if (e.code === "premium") return renderPaywall();
      renderChef(meal, wishes);
      showAlert(e.code === "daily_limit"
        ? "На сегодня лимит подборов исчерпан. Загляните завтра или выберите рецепт из каталога."
        : "ИИ-повар не ответил. Попробуйте ещё раз через минуту.");
    }
  }

  // ---------- Запуск ----------
  function renderMessage(title, text, retry) {
    setBack(null);
    app.innerHTML = `
      <div style="margin-top:24px">
        <h2 class="q-title display">${esc(title)}</h2>
        <p class="q-sub">${esc(text)}</p>
      </div>
      <div class="grow"></div>
      ${retry ? `<button class="primary" id="retry" type="button">Обновить</button>` : ""}`;
    if (retry) document.getElementById("retry").addEventListener("click", start);
  }

  async function start() {
    const splashStart = Date.now();
    renderSplash();

    if (!tg || !tg.initData) {
      return renderMessage("Откройте через Telegram", "Hayanmi работает внутри Telegram. Найдите бота @hayanmi_bot и нажмите кнопку «Hayanmi».", false);
    }

    state.date = localDate();
    const homeCheck = checkHomeScreen();
    const hsDismissed = storage.get("hs_dismissed");
    try {
      await loadState();
      state.homeScreen = await homeCheck;
      state.hsDismissed = !!(await hsDismissed);
      // Даём заставке доиграть, но не держим дольше ~1 секунды
      const wait = 1000 - (Date.now() - splashStart);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    } catch (e) {
      if (e.code === "no_db") {
        return renderMessage("Сервер настраивается", "База данных ещё не подключена. Загляните чуть позже.", true);
      }
      return renderMessage("Нет связи с сервером", "Проверьте интернет и попробуйте ещё раз.", true);
    }

    // Профиль из прошлой версии (хранился только в Telegram) — переносим на сервер
    if (!state.profile) {
      let saved = null;
      try { saved = JSON.parse(await storage.get("profile")); } catch (e) { saved = null; }
      if (saved && saved.result && saved.answers) {
        try {
          await api("/profile", { method: "POST", body: { profile: saved } });
          state.profile = saved;
        } catch (e) { /* не страшно — пользователь пройдёт анкету заново */ }
      }
    }

    // Открыли из чата кнопкой «Изменить граммы»
    const pendingId = new URLSearchParams(location.search).get("pending");
    if (state.profile && pendingId && /^\d+$/.test(pendingId)) {
      history.replaceState(null, "", location.pathname); // чтобы при обновлении не открылось снова
      try {
        const data = await api("/pending/" + pendingId);
        return renderRecognized(null, data.items, pendingId);
      } catch (e) {
        showAlert("Эта запись уже добавлена или устарела.");
      }
    }

    if (state.profile) {
      if (await shouldAutoPaywall()) {
        markPaywallShown();
        renderPaywall("auto");
      } else {
        renderHome();
      }
    } else {
      const seen = await storage.get("intro_seen");
      if (seen) {
        draft = {};
        stepIndex = 0;
        renderStep();
      } else {
        renderIntro();
      }
    }
  }

  start();
})();
