// Форма карточки места для @moderation_route_Bot.
//
// Всё на одном экране вместо цепочки кнопок в чате. Данные читаются и
// пишутся только через функцию бота (`catalog-admin-bot/form-api`): у
// страницы нет ключей базы, а кто её открыл, сервер узнаёт по подписи
// Telegram (`initData`). Гостевой Mini App эта страница не трогает.
//
// Сохранение — само, по ходу ввода: изменённые поля копятся и через
// полсекунды тишины уходят одним запросом. На проверку черновик уходит
// только кнопкой внизу.
//
// `?mock=1` — режим без сервера и без Telegram, с выдуманным черновиком:
// им форму проверяют в обычном браузере.

const API = "https://jtekqkwuhgocoiouhmzg.supabase.co/functions/v1/catalog-admin-bot/form-api/";
const SAVE_DELAY_MS = 600;
const CUISINE_PREVIEW = 12;

const tg = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const MOCK = params.get("mock") === "1";
const draftId = params.get("draft") || tg?.initDataUnsafe?.start_param || "";

const $app = document.getElementById("app");
const $save = document.getElementById("save");
const $title = document.getElementById("title");

let data = null;        // ответ load: справочники, машинные факты, права
let draft = null;       // рабочая копия черновика
let pending = {};       // изменённые, ещё не сохранённые поля
let timer = null;
let saving = null;
let showAllCuisine = false;
let sectionsOpen = false;   // выбранный раздел — свёрнуто: двадцать кнопок нужны, только когда меняешь

/* ------------------------------------------------------------------ *
 * Сервер
 * ------------------------------------------------------------------ */

async function api(action, body) {
  if (MOCK) return mockApi(action, body);
  const res = await fetch(API + action, {
    method: "POST",
    headers: { "content-type": "application/json", "x-init-data": tg?.initData ?? "" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, reason: "bad_response" }));
  return { status: res.status, ...json };
}

const REASONS = {
  unauthorized: "Форма открыта не из бота или слишком давно. Закройте её и откройте заново из @moderation_route_Bot.",
  forbidden: "У вас нет доступа к этой карточке.",
  not_found: "Черновик не найден — возможно, его удалили.",
  bad_draft: "Не указан черновик. Откройте форму кнопкой в боте.",
  not_editable: "Карточка уже у модератора или в партии — править её здесь нельзя.",
  unknown_tag: "Такого тега нет в справочнике.",
  empty_name: "Название не может быть пустым.",
};

/* ------------------------------------------------------------------ *
 * Справочники и правила показа
 * ------------------------------------------------------------------ */

const catById = (id) => data.dict.categories.find((c) => c.id === id);
const groupsOf = (ids) => new Set(ids.map((id) => catById(id)?.group_id).filter(Boolean));

/** Кухня — у еды, вид спорта — у спорта; уже стоящее видно всегда. */
function visibleKinds() {
  const groups = groupsOf(draft.categories);
  return ["cuisine", "sport"].filter((kind) =>
    !groups.size || groups.has(data.dict.kindHome[kind]) ||
    draft.tags.some((t) => data.dict.tags[kind].includes(t)));
}

/** Удобства — по главному разделу, как в боте; отвеченные видны всегда. */
function visibleFacts() {
  const main = draft.categories[0];
  const groups = groupsOf(main ? [main] : draft.categories);
  return data.dict.facts.filter((f) =>
    f.id in draft.facts || !groups.size || f.groups.some((g) => groups.has(g)));
}

/** Кухни деревом: общее, за ним частные, потом остальные. */
function cuisineOrder(list) {
  const tree = data.dict.cuisineTree;
  const children = new Set(Object.values(tree).flat());
  const out = [];
  const walk = (t) => {
    if (out.includes(t)) return;
    if (list.includes(t)) out.push(t);
    for (const c of tree[t] ?? []) walk(c);
  };
  for (const root of Object.keys(tree)) if (!children.has(root)) walk(root);
  return [...out, ...list.filter((t) => !out.includes(t))];
}

/* ------------------------------------------------------------------ *
 * Сохранение
 * ------------------------------------------------------------------ */

function change(field, value) {
  draft[field] = value;
  pending[field] = value;
  setSave("Изменено");
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DELAY_MS);
}

async function flush() {
  clearTimeout(timer);
  if (saving) await saving;
  const patch = pending;
  if (!Object.keys(patch).length) return true;
  if ("name" in patch && !String(patch.name).trim()) {
    setSave("Название пустое — не сохранено", true);
    return false;
  }
  pending = {};
  setSave("Сохраняю…");
  saving = api("save", { draft_id: draftId, patch });
  const res = await saving;
  saving = null;
  if (!res.ok) {
    pending = { ...patch, ...pending };   // не теряем введённое
    setSave(REASONS[res.reason] ?? "Не сохранилось — проверьте связь", true);
    return false;
  }
  // Теги удобств меняет сервер (ответ «да» ставит тег): берём его версию.
  if (res.tags && !("tags" in pending)) draft.tags = res.tags;
  setSave("Сохранено");
  return true;
}

function setSave(text, error = false) {
  $save.textContent = text;
  $save.classList.toggle("err", error);
}

/* ------------------------------------------------------------------ *
 * Экран
 * ------------------------------------------------------------------ */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function render() {
  const ro = !data.editable;
  $title.textContent = draft.name || "Карточка места";
  $app.innerHTML = [
    draft.review_comment ? `<div class="card warn"><h2>Комментарий модератора</h2>${esc(draft.review_comment)}</div>` : "",
    ro ? `<div class="card warn">${REASONS.not_editable}</div>` : "",
    `<div class="card"><h2>Название <span class="req">·&nbsp;обязательно</span></h2>
      <input type="text" data-field="name" value="${esc(draft.name)}" maxlength="120" ${ro ? "disabled" : ""}></div>`,
    `<div class="card" id="sections"></div>`,
    `<div id="tags"></div>`,
    `<div class="card" id="facts"></div>`,
    `<div class="card"><h2>Адрес и точка</h2>
      <label class="f">Адрес</label><input type="text" data-field="address" value="${esc(draft.address)}" maxlength="200" ${ro ? "disabled" : ""}>
      <label class="f">Район</label><input type="text" data-field="district" value="${esc(draft.district)}" maxlength="80" placeholder="как в каталоге: Даниловский" ${ro ? "disabled" : ""}>
      <p class="hint">${draft.lat != null ? `Точка на карте: ${draft.lat.toFixed(5)}, ${draft.lng.toFixed(5)}` : "<b>Точки на карте нет</b> — без неё на проверку не отправить."}
        ${draft.metro.length ? `<br>Метро: ${esc(draft.metro.join(", "))}` : ""}
        <br>Точку и метро пока ставят в боте: блок «Адрес и точка».</p></div>`,
    `<div class="card"><h2>Чек и часы</h2>
      <label class="f">Средний чек</label><input type="text" data-field="avg_check" value="${esc(draft.avg_check)}" maxlength="60" placeholder="800 ₽ · 1000–2500 ₽ · 600 ₽/час · бесплатно" ${ro ? "disabled" : ""}>
      <label class="f">Часы работы</label><input type="text" data-field="opening_hours" value="${esc(draft.opening_hours)}" maxlength="200" placeholder="ежедневно 10:00–22:00" ${ro ? "disabled" : ""}></div>`,
    `<div class="card"><h2>Описание и фото</h2>
      <textarea data-field="summary" maxlength="400" placeholder="Одна-две строки для карточки" ${ro ? "disabled" : ""}>${esc(draft.summary)}</textarea>
      <p class="hint">Фото: ${data.photos || "нет"}. Пока добавляются в боте: блок «Фото и описание».</p></div>`,
    `<div class="card"><h2>Заметка для модератора</h2>
      <textarea data-field="editor_note" maxlength="600" placeholder="Почему это место достойно Route. В каталог не уходит." ${ro ? "disabled" : ""}>${esc(draft.editor_note)}</textarea></div>`,
  ].join("");
  renderSections();
  renderTags();
  renderFacts();
  renderSend();
}

function renderSections() {
  const ro = !data.editable;
  const el = document.getElementById("sections");
  const chosen = draft.categories;
  const chip = (c) => {
    const cls = chosen[0] === c.id ? "chip main" : chosen.includes(c.id) ? "chip on" : "chip";
    return `<button class="${cls}" data-sec="${c.id}" ${ro ? "disabled" : ""}>${chosen[0] === c.id ? "● " : ""}${esc(c.label)}</button>`;
  };
  const known = new Set(data.dict.groups.map((g) => g.id));
  const blocks = [
    ...data.dict.groups.map((g) => ({ label: g.label, cats: data.dict.categories.filter((c) => c.group_id === g.id) })),
    { label: "Прочее", cats: data.dict.categories.filter((c) => !known.has(c.group_id)) },
  ].filter((b) => b.cats.length);
  const mainPick = chosen.length > 1
    ? `<p class="hint">Главный раздел — первый, он даёт подпись и значок. Сделать главным:</p>
       <div class="chips">${chosen.map((id) => `<button class="chip ${id === chosen[0] ? "main" : ""}" data-main="${id}" ${ro ? "disabled" : ""}>${esc(catById(id)?.label ?? id)}</button>`).join("")}</div>`
    : "";
  const head = `<h2>Разделы <span class="req">·&nbsp;обязательно</span></h2>`;
  if (chosen.length && !sectionsOpen) {
    el.innerHTML = head +
      `<div class="chips">${chosen.map((id) => chip(catById(id) ?? { id, label: id })).join("")}</div>` +
      (ro ? "" : `<button class="more" data-open="sections">Изменить разделы</button>`);
    return;
  }
  el.innerHTML = head +
    blocks.map((b) => `<div class="group">${esc(b.label)}</div><div class="chips">${b.cats.map(chip).join("")}</div>`).join("") +
    mainPick +
    (chosen.length ? `<button class="more" data-open="done">Готово</button>` : "");
}

function renderTags() {
  const ro = !data.editable;
  const el = document.getElementById("tags");
  const kinds = visibleKinds();
  el.innerHTML = kinds.map((kind) => {
    let list = kind === "cuisine" ? cuisineOrder(data.dict.tags.cuisine) : data.dict.tags.sport;
    let more = "";
    if (kind === "cuisine" && !showAllCuisine && list.length > CUISINE_PREVIEW) {
      const hidden = list.length - CUISINE_PREVIEW;
      list = [...new Set([...list.slice(0, CUISINE_PREVIEW), ...list.filter((t) => draft.tags.includes(t))])];
      more = `<button class="more" data-more="cuisine">Ещё ${hidden}</button>`;
    }
    const title = kind === "cuisine" ? "Кухня" : "Вид спорта";
    const hint = kind === "cuisine"
      ? `<p class="hint">Ставьте самое точное: «Суши» найдётся и по «Японской», и по «Азиатской».</p>` : "";
    return `<div class="card"><h2>${title}</h2><div class="chips">${list.map((t) =>
      `<button class="chip ${draft.tags.includes(t) ? "on" : ""}" data-tag="${esc(t)}" ${ro ? "disabled" : ""}>${esc(t)}</button>`).join("")}</div>${more}${hint}</div>`;
  }).join("");
}

function renderFacts() {
  const ro = !data.editable;
  const el = document.getElementById("facts");
  const list = visibleFacts();
  const seg = (f) => {
    const v = draft.facts[f.id];
    const b = (val, text, cls) =>
      `<button data-fact="${f.id}" data-val="${val}" class="${v === (val === "y" ? true : val === "n" ? false : undefined) ? cls : ""}" ${ro ? "disabled" : ""}>${text}</button>`;
    return `<div class="seg">${b("y", "Да", "y")}${b("n", "Нет", "n")}${b("u", "?", "u")}</div>`;
  };
  const machine = (f) => {
    const m = data.machineFacts?.[f.id];
    return typeof m === "boolean" && !(f.id in draft.facts) ? `<span class="map">по карте: ${m ? "да" : "нет"}</span>` : "";
  };
  el.innerHTML = `<h2>Удобства · что видели сами</h2>` +
    list.map((f) => `<div class="fact"><div>${esc(f.short)}${machine(f)}</div>${seg(f)}</div>`).join("") +
    `<p class="hint">Не уверены — «?»: подбор честно сочтёт это неизвестным. «Нет» убирает место из подбора по этому признаку.</p>`;
}

function renderSend(gaps) {
  let bar = document.querySelector(".send");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "send";
    document.body.appendChild(bar);
  }
  const canSend = data.editable && ["draft", "changes_requested"].includes(draft.status);
  bar.innerHTML = canSend
    ? `${gaps?.length ? `<div class="gaps">Не хватает: ${esc(gaps.join(", "))}</div>` : ""}<button id="send">Отправить на проверку</button>`
    : `<button id="close">Закрыть</button>`;
}

/* ------------------------------------------------------------------ *
 * Нажатия
 * ------------------------------------------------------------------ */

document.addEventListener("input", (e) => {
  const field = e.target?.dataset?.field;
  if (!field) return;
  change(field, e.target.value);
  if (field === "name") $title.textContent = e.target.value || "Карточка места";
});

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t || t.disabled) return;
  tg?.HapticFeedback?.selectionChanged?.();

  if (t.dataset.open) {
    sectionsOpen = t.dataset.open === "sections";
    renderSections();
  } else if (t.dataset.sec) {
    const id = t.dataset.sec;
    // В свёрнутом виде видны только выбранные: нажатие открывает список, а не снимает раздел.
    if (!sectionsOpen && draft.categories.length) {
      sectionsOpen = true;
      renderSections();
      return;
    }
    const list = draft.categories.includes(id) ? draft.categories.filter((c) => c !== id) : [...draft.categories, id];
    change("categories", list);
    renderSections(); renderTags(); renderFacts();
  } else if (t.dataset.main) {
    const id = t.dataset.main;
    change("categories", [id, ...draft.categories.filter((c) => c !== id)]);
    renderSections(); renderFacts();
  } else if (t.dataset.tag) {
    const tag = t.dataset.tag;
    change("tags", draft.tags.includes(tag) ? draft.tags.filter((x) => x !== tag) : [...draft.tags, tag]);
    renderTags();
  } else if (t.dataset.more) {
    showAllCuisine = true;
    renderTags();
  } else if (t.dataset.fact) {
    const facts = { ...draft.facts };
    const val = t.dataset.val;
    if (val === "u") delete facts[t.dataset.fact];
    else facts[t.dataset.fact] = val === "y";
    change("facts", facts);
    renderFacts();
  } else if (t.id === "send") {
    t.disabled = true;
    if (!(await flush())) { t.disabled = false; return; }
    const res = await api("send", { draft_id: draftId });
    if (res.ok) {
      draft.status = "review";
      setSave("Отправлено на проверку");
      renderSend();
      tg?.HapticFeedback?.notificationOccurred?.("success");
    } else {
      renderSend(res.gaps ?? [REASONS[res.reason] ?? res.reason ?? "не получилось"]);
    }
  } else if (t.id === "close") {
    await flush();
    tg?.close?.();
  }
});

// Уходя, досохраняем: закрыть форму на середине ввода — обычное дело.
window.addEventListener("pagehide", () => { if (Object.keys(pending).length) flush(); });

/* ------------------------------------------------------------------ *
 * Запуск
 * ------------------------------------------------------------------ */

async function start() {
  tg?.ready?.();
  tg?.expand?.();
  if (!draftId && !MOCK) {
    $app.innerHTML = `<div class="card warn">${REASONS.bad_draft}</div>`;
    return;
  }
  const res = await api("load", { draft_id: draftId });
  if (!res.ok) {
    $app.innerHTML = `<div class="card warn">${esc(REASONS[res.reason] ?? "Не удалось открыть карточку. Проверьте связь и откройте заново.")}</div>`;
    return;
  }
  data = res;
  draft = { ...res.draft, categories: [...res.draft.categories], tags: [...res.draft.tags], facts: { ...res.draft.facts } };
  // Главный раздел — первым: так его и хранит сервер.
  if (draft.category_id && draft.categories[0] !== draft.category_id) {
    draft.categories = [draft.category_id, ...draft.categories.filter((c) => c !== draft.category_id)];
  }
  render();
  setSave(data.editable ? "Сохраняется само" : "Только просмотр");
}

/* ------------------------------------------------------------------ *
 * Режим без сервера (?mock=1)
 * ------------------------------------------------------------------ */

let mockStore = null;
async function mockApi(action, body) {
  if (!mockStore) mockStore = (await import("./mock.js")).default();
  return mockStore(action, body);
}

start();
