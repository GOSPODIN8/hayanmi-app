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

  // ---------- Проверка входа на сервере ----------
  let loginStatus = "checking"; // checking | ok | fail | outside
  async function checkLogin() {
    if (!tg || !tg.initData) { loginStatus = "outside"; return; }
    try {
      const res = await fetch("/api/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: tg.initData }),
      });
      const data = await res.json();
      loginStatus = data.ok ? "ok" : "fail";
    } catch (e) {
      loginStatus = "fail";
    }
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
      const ok = await storage.set("profile", JSON.stringify(profile));
      if (!ok) {
        haptic("error");
        btn.disabled = false;
        btn.textContent = "Сохранить и начать";
        const msg = "Не получилось сохранить. Попробуйте ещё раз.";
        tg?.showAlert ? tg.showAlert(msg) : alert(msg);
        return;
      }
      haptic("success");
      currentProfile = profile;
      renderHome();
    });
  }

  // ---------- Главная ----------
  let currentProfile = null;

  function macroRow(name, color, eaten, goal) {
    const pct = goal > 0 ? Math.min(100, Math.round((eaten / goal) * 100)) : 0;
    return `
      <div class="macro">
        <div class="row"><span>${name}</span><span class="muted">${fmt(eaten)} / ${fmt(goal)} г</span></div>
        <div class="bar"><div style="width:${pct}%;background:${color}"></div></div>
      </div>`;
  }

  function statusHtml() {
    if (loginStatus === "ok") return `<div class="status ok">Подключено</div>`;
    if (loginStatus === "outside") return `<div class="status">Откройте через бота</div>`;
    if (loginStatus === "fail") return `<div class="status">Нет связи</div>`;
    return `<div class="status">Проверка…</div>`;
  }

  function renderHome() {
    setBack(null);
    const r = currentProfile.result;
    const eaten = { kcal: 0, p: 0, f: 0, c: 0 }; // дневник появится на следующем этапе
    const left = Math.max(0, r.kcal - eaten.kcal);
    const circumference = 2 * Math.PI * 62;
    const filled = Math.min(1, eaten.kcal / r.kcal) * circumference;
    const firstName = tg?.initDataUnsafe?.user?.first_name;

    app.innerHTML = `
      <header>
        <div>
          <div class="hello muted">${firstName ? "Привет, " + esc(firstName) + "!" : "Привет!"}</div>
          <h1 class="display">Сегодня</h1>
        </div>
        <div id="status-slot">${statusHtml()}</div>
      </header>

      <section class="card ring-wrap" aria-label="Калории за день">
        <div class="ring">
          <svg width="148" height="148" viewBox="0 0 148 148" aria-hidden="true">
            <circle cx="74" cy="74" r="62" fill="none" stroke="#2C2E33" stroke-width="12"/>
            <circle cx="74" cy="74" r="62" fill="none" stroke="#D4F25A" stroke-width="12" stroke-linecap="round"
                    stroke-dasharray="${filled.toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(-90 74 74)"/>
          </svg>
          <div class="center">
            <div class="num display">${fmt(left)}</div>
            <div class="lbl muted">ккал осталось</div>
          </div>
        </div>
        <div class="macros">
          ${macroRow("Белки", "var(--protein)", eaten.p, r.protein)}
          ${macroRow("Жиры", "var(--fat)", eaten.f, r.fat)}
          ${macroRow("Углеводы", "var(--carbs)", eaten.c, r.carbs)}
          <div class="small muted">Съедено ${fmt(eaten.kcal)} из ${fmt(r.kcal)}</div>
        </div>
      </section>

      <section class="card">
        <p class="note" style="margin:0">Скоро здесь появится дневник: фото тарелки — и калории посчитаются сами.</p>
      </section>

      <div class="grow"></div>
      <button class="secondary" id="edit" type="button">Изменить данные</button>`;

    document.getElementById("edit").addEventListener("click", () => {
      haptic();
      draft = { ...currentProfile.answers, _editing: true };
      stepIndex = 0;
      renderStep();
    });
  }

  function refreshStatus() {
    const slot = document.getElementById("status-slot");
    if (slot) slot.innerHTML = statusHtml();
  }

  // ---------- Запуск ----------
  async function start() {
    app.innerHTML = `<div class="grow" style="display:flex;align-items:center;justify-content:center"><div class="muted">Загрузка…</div></div>`;
    checkLogin().then(refreshStatus);

    let saved = null;
    try { saved = JSON.parse(await storage.get("profile")); } catch (e) { saved = null; }

    if (saved && saved.result && saved.answers) {
      currentProfile = saved;
      renderHome();
    } else {
      draft = {};
      stepIndex = 0;
      renderStep();
    }
  }

  start();
})();
