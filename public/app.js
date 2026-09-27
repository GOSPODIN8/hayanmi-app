// Hayanmi — Mini App: анкета, результат, главная.
(function () {
  const tg = window.Telegram?.WebApp;
  const Calc = window.HayanmiCalc;
  const app = document.getElementById("app");

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor("#0E0F0C"); tg.setBackgroundColor("#0E0F0C"); } catch (e) {}
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
  const state = { profile: null, entries: [], quota: null, premium: null, prices: null, date: localDate() };

  async function loadState() {
    const data = await api("/state?date=" + state.date);
    state.profile = data.profile;
    state.entries = data.entries || [];
    state.quota = data.quota || null;
    state.premium = data.premium || null;
    state.prices = data.prices || null;
    return data;
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
    setBack(stepIndex > 0 ? () => { stepIndex--; renderStep(); } : (draft._editing ? () => renderHome() : null));

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

  function renderNumber(step) {
    const cfg = NUMBER_STEPS[step];
    const sub = step === "target"
      ? `Сейчас: ${String(draft.weight).replace(".", ",")} кг`
      : step === "age" ? "Норма калорий зависит от возраста." : "";
    const val = draft[step] != null ? String(draft[step]).replace(".", ",") : "";
    app.innerHTML = `
      ${progressHtml()}
      <h2 class="q-title display">${esc(cfg.title)}</h2>
      <p class="q-sub">${esc(sub)}</p>
      <label class="field" for="num">
        <input id="num" type="text" inputmode="${cfg.int ? "numeric" : "decimal"}" autocomplete="off" value="${esc(val)}" aria-label="${esc(cfg.title)}">
        <span class="unit">${cfg.unit}</span>
      </label>
      <div class="error" id="err" role="alert"></div>
      <div class="grow"></div>
      <button class="primary" id="next" type="button">Далее</button>`;

    const input = document.getElementById("num");
    const errEl = document.getElementById("err");
    setTimeout(() => input.focus(), 150);

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
      state.profile = profile;
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
        <button class="badge ${state.premium?.active ? "on" : ""}" id="premium" type="button">Премиум</button>
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

      ${mealsHtml || `<section class="card empty"><p class="note muted" style="margin:0">Пока пусто. Сфотографируй еду — и калории посчитаются сами.</p></section>`}

      <div class="grow"></div>
      ${quotaHtml}
      <button class="primary" id="add-photo" type="button">Добавить еду по фото</button>
      <div class="links">
        <button class="link-btn" id="edit" type="button">Мои данные</button>
        <button class="link-btn" id="sub" type="button">Подписка</button>
      </div>
      <input id="file" type="file" accept="image/*" hidden>`;

    const openSub = () => { haptic(); state.premium?.active ? renderSubscription() : renderPaywall(); };
    document.getElementById("premium").addEventListener("click", openSub);
    document.getElementById("sub").addEventListener("click", openSub);

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

    const fileInput = document.getElementById("file");
    document.getElementById("add-photo").addEventListener("click", () => {
      haptic();
      if (q && !q.unlimited && q.left <= 0) return renderPaywall("limit");
      fileInput.click();
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      try {
        const dataUrl = await resizeImage(file);
        renderPhotoPreview(dataUrl);
      } catch (e) {
        showAlert("Не удалось открыть это фото. Попробуйте другое.");
      }
    });

    document.getElementById("edit").addEventListener("click", () => {
      haptic();
      draft = { ...state.profile.answers, _editing: true };
      stepIndex = 0;
      renderStep();
    });
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

  // ---------- Премиум: пейволл ----------
  const STAR = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L14.6 9L21 9.5L16 13.6L17.6 20L12 16.5L6.4 20L8 13.6L3 9.5L9.4 9Z" fill="#F4C84A"/></svg>`;
  const CHECK = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5L10 17L19 7" fill="none" stroke="#D4F25A" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const LOGO = `<svg width="44" height="44" viewBox="0 0 96 96" aria-label="Hayanmi"><circle cx="48" cy="48" r="40" fill="none" stroke="#2C2E33" stroke-width="8"/><circle cx="48" cy="48" r="40" fill="none" stroke="#D4F25A" stroke-width="8" stroke-linecap="round" stroke-dasharray="180 252" transform="rotate(-90 48 48)"/><path d="M37 29V67M37 51C37 45 41 42 46 42C52 42 59 45 59 53V67" fill="none" stroke="#F3F1EA" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const dateText = (iso) => new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

  function renderPaywall(reason) {
    setBack(() => renderHome());
    const prices = state.prices || { month: 250, year: 1500, trialDays: 3 };
    const perMonth = Math.round(prices.year / 12);
    const save = Math.round((1 - prices.year / (prices.month * 12)) * 100);
    const trial = state.premium?.trialAvailable;
    let plan = "year";

    function draw() {
      app.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">${LOGO}</div>
        <div style="margin:18px 0 20px">
          <h2 class="q-title display" style="font-size:30px;margin-bottom:10px">Hayanmi<br><span style="color:var(--accent)">Премиум</span></h2>
          <p class="q-sub" style="margin:0">${reason === "limit"
            ? "Бесплатные распознавания закончились. С Премиумом — без ограничений."
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
          ${trial ? `<button class="link-btn" id="trial" type="button" style="color:var(--text)">Попробовать ${prices.trialDays} дня бесплатно</button>` : ""}
          <div class="small muted" style="text-align:center">Условия — команда /terms в чате с ботом · помощь — /paysupport</div>
        </div>`;

      app.querySelectorAll("[data-plan]").forEach((b) =>
        b.addEventListener("click", () => { haptic("select"); plan = b.dataset.plan; draw(); })
      );
      document.getElementById("buy").addEventListener("click", (e) => buy(plan, e.currentTarget));
      if (trial) document.getElementById("trial").addEventListener("click", startTrial);
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
  function renderRecognized(dataUrl, aiItems) {
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
        <img class="photo small" src="${dataUrl}" alt="Фото еды">
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
          const data = await api("/entries", { method: "POST", body: { date: state.date, meal, items: payload } });
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
    app.innerHTML = `<div class="grow" style="display:flex;align-items:center;justify-content:center"><div class="spinner" aria-label="Загрузка"></div></div>`;

    if (!tg || !tg.initData) {
      return renderMessage("Откройте через Telegram", "Hayanmi работает внутри Telegram. Найдите бота @hayanmi_bot и нажмите кнопку «Hayanmi».", false);
    }

    state.date = localDate();
    try {
      await loadState();
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

    if (state.profile) {
      renderHome();
    } else {
      draft = {};
      stepIndex = 0;
      renderStep();
    }
  }

  start();
})();
