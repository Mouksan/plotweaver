// Plotweaver — три окна расширения.
//
// 1. openQuestionnaire() — конструктор промта (опросник).
// 2. openReview(text)    — окно с результатом генерации + кнопка "Сохранить".
//    Пока вызывается с заглушечным текстом вместо настоящей генерации —
//    это добавим на этапе "Генерация".
// 3. openNotebook()      — блокнот со страницами. Пока хранит фейковые
//    страницы прямо в этом файле (переменная `fakePages`) — реальное
//    сохранение в chatMetadata появится на этапе "Блокнот".
//
// Все три окна используют один и тот же способ показать поп-ап —
// context.Popup из самой таверны, это тот же механизм, которым
// пользуются стандартные диалоги ST (и Facets/Estate на твоих скринах).

import { SECTIONS, findQuestion } from './catalog.js';
import { buildContext, buildPrompt } from './prompt.js';
import { getDraft, saveDraftDebounced, getPagesStore, addPage, updatePage, deletePage, setActivePage } from './settings.js';
import { runGeneration, computeResponseLength, stopMainApiGeneration } from './generate.js';
import { renderMarkdown } from './markdown.js';
import { openAlter } from './alter.js';

/** Короткий алиас, чтобы не писать SillyTavern.getContext() в каждой строке. */
function ctx() {
    return SillyTavern.getContext();
}

// ---------------------------------------------------------------------------
// Общие мелкие помощники для вёрстки
// ---------------------------------------------------------------------------

/** Экранирует текст перед вставкой в HTML, чтобы кастомный ввод пользователя
 *  не мог случайно сломать вёрстку (например, если там окажутся символы < >).
 */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Окно 1 — Опросник
// ---------------------------------------------------------------------------

function chipHtml(question, option, activeIds) {
    const isActive = activeIds.includes(option.id);
    const titleAttr = option.hint ? ` title="${escapeHtml(option.hint)}"` : '';
    return `<div class="pw-chip ${isActive ? 'pw-chip--active' : ''}" data-qid="${question.id}" data-oid="${option.id}"${titleAttr}>${escapeHtml(option.label)}</div>`;
}

/** entry: { value, active } — кастомный чип, добавленный самим пользователем. */
function customChipHtml(question, entry) {
    const safeValue = escapeHtml(entry.value);
    return `
        <div class="pw-chip pw-chip--custom ${entry.active ? 'pw-chip--active' : ''}" data-qid="${question.id}" data-custom-value="${safeValue}">
            <span>${safeValue}</span>
            <span class="pw-chip-remove" title="Удалить">×</span>
        </div>
    `;
}

/** Чип-кнопка "+ свой" — клик по ней открывает строку ввода под чипами. */
function addChipHtml(question) {
    return `<div class="pw-chip pw-chip--add" data-qid="${question.id}">+ свой</div>`;
}

/** Текущее число активных чипов (пресет + кастом) у вопроса — для подписи лимита. */
function countActive(root, qid) {
    return $(root).find(`.pw-chip-row[data-qid="${qid}"] .pw-chip--active`).length;
}

/** Обновляет подпись "до N · выбрано M" рядом с заголовком вопроса. */
function updateLimitLabel(root, qid) {
    const question = findQuestion(qid);
    if (!question || !question.maxSelect || question.maxSelect <= 1) return;
    const count = countActive(root, qid);
    $(root).find(`.pw-question-limit[data-qid="${qid}"]`).text(`до ${question.maxSelect} · выбрано ${count}`);
}

function questionHtml(question, draftAnswers) {
    const answer = draftAnswers[question.id] || { ids: [], customValues: [] };
    const presetChipsHtml = (question.options || [])
        .map((opt) => chipHtml(question, opt, answer.ids || []))
        .join('');
    const customChipsHtml = (answer.customValues || [])
        .map((entry) => customChipHtml(question, entry))
        .join('');
    const activeCount = (answer.ids || []).length + (answer.customValues || []).filter((e) => e.active).length;
    const limitHtml = question.maxSelect && question.maxSelect > 1
        ? `<span class="pw-question-limit" data-qid="${question.id}">до ${question.maxSelect} · выбрано ${activeCount}</span>`
        : '';

    return `
        <div class="pw-question">
            <div class="pw-question-header">
                <div class="pw-question-label">${escapeHtml(question.label)} ${limitHtml}</div>
                <button type="button" class="pw-question-clear" data-qid="${question.id}">Clear</button>
            </div>
            ${question.hint ? `<div class="pw-question-hint">${escapeHtml(question.hint)}</div>` : ''}
            <div class="pw-chip-row" data-qid="${question.id}">
                ${presetChipsHtml}${customChipsHtml}${addChipHtml(question)}
            </div>
            <div class="pw-add-row" data-qid="${question.id}" style="display: none;">
                <input type="text" class="text_pole pw-custom-add-input" data-qid="${question.id}" placeholder="Свой вариант для «${escapeHtml(question.label)}»...">
                <button type="button" class="menu_button pw-custom-add-btn" data-qid="${question.id}">+</button>
            </div>
        </div>
    `;
}

function sectionHtml(section, index, draftAnswers) {
    return `
        <div class="inline-drawer pw-section">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>${index + 1}. ${escapeHtml(section.title)}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-up up"></div>
            </div>
            <div class="inline-drawer-content" style="display: block;">
                ${section.hint ? `<div class="pw-section-hint">${escapeHtml(section.hint)}</div>` : ''}
                ${section.questions.map((q) => renderQuestion(q, draftAnswers)).join('')}
            </div>
        </div>
    `;
}

/**
 * Сегментированный переключатель (как выбор языка ключевых слов у Facets) —
 * для вопросов, где по смыслу это не "чипы с кастомом", а строго один из
 * двух-трёх фиксированных вариантов. Сейчас применяется только к языку
 * генерации.
 */
function segmentedHtml(question, activeId) {
    const buttonsHtml = question.options
        .map((opt) => `
            <button type="button" class="pw-seg" data-qid="${question.id}" data-oid="${opt.id}" aria-pressed="${opt.id === activeId}"${opt.hint ? ` title="${escapeHtml(opt.hint)}"` : ''}>
                ${escapeHtml(opt.label)}
            </button>
        `)
        .join('');
    return `
        <div class="pw-question">
            <div class="pw-question-label">${escapeHtml(question.label)}</div>
            <div class="pw-segmented" data-qid="${question.id}">${buttonsHtml}</div>
            ${question.hint ? `<div class="pw-question-hint">${escapeHtml(question.hint)}</div>` : ''}
        </div>
    `;
}

const SEGMENTED_QUESTION_IDS = new Set(['output_language', 'format']);

function renderQuestion(question, draftAnswers) {
    if (SEGMENTED_QUESTION_IDS.has(question.id)) {
        const activeId = draftAnswers[question.id]?.ids?.[0] || question.options[0]?.id;
        return segmentedHtml(question, activeId);
    }
    return questionHtml(question, draftAnswers);
}

/**
 * Список сохранённых профилей подключения (Connection Manager) для
 * выпадающего списка "Модель". Если профилей нет или таверна их не
 * поддерживает в этой версии — просто вернём пустой список, и в
 * селекте останется только "Использовать текущее подключение".
 */
export function getConnectionProfiles() {
    try {
        return ctx().ConnectionManagerRequestService?.getSupportedProfiles?.() || [];
    } catch (error) {
        console.warn('[Plotweaver] не удалось получить профили подключения', error);
        return [];
    }
}

export function modelSectionHtml(selectedProfileId) {
    const profiles = getConnectionProfiles().filter((p) => p?.id);
    const optionsHtml = profiles
        .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === selectedProfileId ? 'selected' : ''}>${escapeHtml(p.name || p.id)}</option>`)
        .join('');

    return `
        <div class="pw-question">
            <div class="pw-question-label">Модель</div>
            <select class="text_pole pw-model-select">
                <option value="" ${selectedProfileId ? '' : 'selected'}>Использовать текущее подключение</option>
                ${optionsHtml}
            </select>
            <div class="pw-hint">
                Можно выбрать сохранённый профиль подключения, чтобы сгенерировать
                этим планом через другую модель, а не ту, что сейчас активна в чате.
            </div>
        </div>
    `;
}

function contextToggleHtml(ctxId, label, checked) {
    return `
        <label class="pw-toggle">
            <input type="checkbox" class="pw-ctx-toggle" data-ctx-id="${ctxId}" ${checked ? 'checked' : ''}>
            <span>${escapeHtml(label)}</span>
        </label>
    `;
}

/**
 * Список всех лорбуков, которые вообще есть в системе (не только
 * привязанные к этому чату) — нужен для выпадающего списка выбора.
 */
export function getLoreNames() {
    try {
        return ctx().getWorldInfoNames?.() || [];
    } catch (error) {
        console.warn('[Plotweaver] не удалось получить список лорбуков', error);
        return [];
    }
}

/** Имя лорбука, привязанного к текущей карточке персонажа (если есть) — используется как дефолт. */
export function getDefaultCharacterLoreName() {
    try {
        const context = ctx();
        const character = context.characters?.[context.characterId];
        return character?.data?.extensions?.world || '';
    } catch (error) {
        return '';
    }
}

export function loreSelectHtml(selectedNames) {
    const names = getLoreNames();
    if (!names.length) {
        return '<div class="pw-hint">Лорбуков в системе не найдено.</div>';
    }
    const itemsHtml = names
        .map((name) => `
            <label class="pw-lore-item">
                <input type="checkbox" class="pw-lore-checkbox" value="${escapeHtml(name)}" ${selectedNames.includes(name) ? 'checked' : ''}>
                <span>${escapeHtml(name)}</span>
            </label>
        `)
        .join('');
    return `
        <input type="text" class="text_pole pw-lore-search" placeholder="Поиск лорбука...">
        <div class="pw-lore-list">${itemsHtml}</div>
        <div class="pw-hint">
            Можно выбрать несколько. Берутся ВСЕ записи выбранных лорбуков целиком —
            без активации по ключевым словам или векторам.
        </div>
    `;
}

function contextSectionHtml(generation) {
    return `
        <div class="pw-question">
            <div class="pw-question-label">Контекст для чтения</div>
            <div class="pw-toggle-row">
                ${contextToggleHtml('card', 'Карточка персонажа', generation.useCard)}
                ${contextToggleHtml('persona', 'Описание персоны', generation.usePersona)}
                ${contextToggleHtml('lore', 'Лорбук', generation.useLore)}
                ${contextToggleHtml('history', 'Недавние сообщения', generation.useHistory)}
            </div>
            <div class="pw-context-columns">
                <div class="pw-field pw-lore-field">
                    <div class="pw-question-label">Какие лорбуки</div>
                    ${loreSelectHtml(generation.loreNames || [])}
                </div>
                <div class="pw-field pw-history-count-field">
                    <div class="pw-question-label">Сколько сообщений</div>
                    <input type="number" class="text_pole pw-history-count" min="0" max="200" step="1" value="${Number(generation.historyCount) || 20}">
                </div>
            </div>
        </div>
    `;
}

/**
 * Читает текущее состояние опросника прямо из DOM: какие пресет-чипы
 * активны и какие кастомные чипы существуют (и активны ли они). Возвращает
 * объект вида { questionId: { ids: [...], customValues: [{value, active}] } }.
 */
function collectAnswers(root) {
    const answers = {};

    $(root).find('.pw-chip').each(function () {
        const $chip = $(this);
        const qid = $chip.data('qid');
        if (!answers[qid]) answers[qid] = { ids: [], customValues: [] };

        if ($chip.hasClass('pw-chip--custom')) {
            const value = $chip.attr('data-custom-value') || '';
            if (value) {
                answers[qid].customValues.push({ value, active: $chip.hasClass('pw-chip--active') });
            }
        } else if ($chip.hasClass('pw-chip--active')) {
            answers[qid].ids.push($chip.data('oid'));
        }
    });

    $(root).find('.pw-seg[aria-pressed="true"]').each(function () {
        const $btn = $(this);
        const qid = $btn.data('qid');
        if (!answers[qid]) answers[qid] = { ids: [], customValues: [] };
        answers[qid].ids.push($btn.data('oid'));
    });

    return answers;
}

/** Читает блок "Модель" + "Контекст для чтения" из DOM. */
function collectGenerationSettings(root) {
    const ctxToggle = (id) => $(root).find(`.pw-ctx-toggle[data-ctx-id="${id}"]`).prop('checked');
    const loreNames = $(root).find('.pw-lore-checkbox:checked').map(function () { return $(this).val(); }).get();
    return {
        profileId: $(root).find('.pw-model-select').val() || '',
        useCard: ctxToggle('card'),
        usePersona: ctxToggle('persona'),
        useLore: ctxToggle('lore'),
        useHistory: ctxToggle('history'),
        historyCount: Number($(root).find('.pw-history-count').val()) || 0,
        loreNames,
    };
}

/**
 * Открывает окно опросника-конструктора.
 * Сейчас кнопка "Сгенерировать" просто открывает окно результата
 * с текстом-заглушкой — реальный сбор промта и обращение к ИИ
 * появятся на следующих этапах. Блок "Модель" и "Контекст для чтения"
 * пока тоже только рисуются — читать их значения при генерации начнём
 * на этапе "Генерация".
 */
export async function openQuestionnaire() {
    const draft = getDraft();
    // Если ни разу не выбирали лорбук вручную — подставим тот, что привязан
    // к карточке персонажа, просто чтобы список не был пустым при первом
    // открытии. Дальше твой собственный выбор всегда сохраняется поверх.
    if (!draft.generation.loreNames || !draft.generation.loreNames.length) {
        const defaultLore = getDefaultCharacterLoreName();
        draft.generation.loreNames = defaultLore ? [defaultLore] : [];
    }

    const root = document.createElement('div');
    root.classList.add('pw-dialog');

    root.innerHTML = `
        <h3 class="pw-title">Plotweaver — конструктор сюжета</h3>
        <p class="pw-hint">
            Заполняй только то, что важно для этого плана — пустые пункты
            просто не попадут в запрос к ИИ.
        </p>
        <div class="pw-sections">
            ${SECTIONS.map((section, index) => sectionHtml(section, index, draft.answers)).join('')}
        </div>
        <div class="pw-question">
            <div class="pw-question-label">Свободные заметки и хотелки</div>
            <textarea class="text_pole pw-notes" rows="4" placeholder="Всё, что не влезло в вопросы выше...">${escapeHtml(draft.notes || '')}</textarea>
        </div>
        <div class="pw-generation-settings">
            ${modelSectionHtml(draft.generation.profileId)}
            ${contextSectionHtml(draft.generation)}
        </div>
        <div class="pw-prompt-preview-wrap" style="display: none;">
            <div class="pw-question-label">Предпросмотр промта (то, что уйдёт модели)</div>
            <textarea class="text_pole pw-prompt-preview" rows="12" readonly></textarea>
        </div>
        <div class="pw-footer">
            <button class="menu_button pw-preview-btn">
                <i class="fa-solid fa-eye"></i>
                Показать промт
            </button>
            <div class="pw-footer-right">
                <button class="menu_button pw-cancel-btn" style="display: none;">
                    <i class="fa-solid fa-xmark"></i>
                    Отмена
                </button>
                <button class="menu_button pw-generate-btn">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    Сгенерировать сюжет
                </button>
            </div>
        </div>
    `;

    // Сохраняет текущее состояние формы в chatMetadata (с debounce внутри),
    // чтобы закрытие окна — случайное или нет — не сбрасывало прогресс.
    const persistDraft = () => {
        saveDraftDebounced({
            answers: collectAnswers(root),
            notes: $(root).find('.pw-notes').val(),
            generation: collectGenerationSettings(root),
        });
    };

    // Отслеживаем, закрыла ли ты окно вручную, пока идёт генерация — от
    // этого зависит, куда девать результат (см. обработчик ниже).
    const popupState = { closed: false };

    // Текущая генерация этого окна (если идёт) — нужна кнопке "Отмена".
    let activeAbort = null;
    let activeUsesProfile = false;

    // Клик по чипу: у 'single'-вопросов новый выбор снимает предыдущий,
    // у 'multi' — переключается сам по себе, но с проверкой лимита (если
    // у вопроса есть maxSelect) — активировать сверх лимита нельзя, вместо
    // этого тост-подсказка. Деактивировать можно всегда без ограничений.
    // Крестик у кастомных чипов и сама кнопка "+ свой" обрабатываются
    // отдельно, ниже — поэтому явно исключаем их здесь через :not().
    $(root).on('click', '.pw-chip:not(.pw-chip--add)', function () {
        const $chip = $(this);
        const qid = $chip.data('qid');
        const question = findQuestion(qid);
        if (!question) return;

        if (question.type === 'single') {
            $chip.siblings('.pw-chip').removeClass('pw-chip--active');
            $chip.toggleClass('pw-chip--active');
        } else {
            const activating = !$chip.hasClass('pw-chip--active');
            if (activating && question.maxSelect && countActive(root, qid) >= question.maxSelect) {
                toastr.info(`Можно выбрать не больше ${question.maxSelect}.`, question.label);
                return;
            }
            $chip.toggleClass('pw-chip--active');
        }
        updateLimitLabel(root, qid);
        persistDraft();
    });

    // Клик по сегментированной кнопке (язык генерации) — строго один
    // активный вариант в своей группе, как радио-кнопки.
    $(root).on('click', '.pw-seg', function () {
        const $btn = $(this);
        $btn.siblings('.pw-seg').attr('aria-pressed', 'false');
        $btn.attr('aria-pressed', 'true');
        persistDraft();
    });

    // Клик по чипу "+ свой" — открывает строку ввода под чипами (а не
    // держит её вечно видимой, как раньше).
    $(root).on('click', '.pw-chip--add', function () {
        const qid = $(this).data('qid');
        const question = findQuestion(qid);
        if (question && question.maxSelect && countActive(root, qid) >= question.maxSelect) {
            toastr.info(`Можно выбрать не больше ${question.maxSelect}.`, question.label);
            return;
        }
        const $addRow = $(root).find(`.pw-add-row[data-qid="${qid}"]`);
        $addRow.slideDown(150);
        $addRow.find('.pw-custom-add-input').trigger('focus');
    });

    // "Clear" у конкретного вопроса — снимает пресет-чипы и удаляет
    // кастомные насовсем (не просто гасит выделение).
    $(root).on('click', '.pw-question-clear', function () {
        const qid = $(this).data('qid');
        const $question = $(this).closest('.pw-question');
        $question.find('.pw-chip').each(function () {
            const $chip = $(this);
            if ($chip.hasClass('pw-chip--add')) return;
            if ($chip.hasClass('pw-chip--custom')) {
                $chip.remove();
            } else {
                $chip.removeClass('pw-chip--active');
            }
        });
        $question.find('.pw-add-row').hide();
        updateLimitLabel(root, qid);
        persistDraft();
    });

    // Крестик на кастомном чипе — удаляет его насовсем (не просто снимает
    // выделение). stopPropagation, чтобы клик не долетел до обработчика
    // самого чипа выше и не переключил его вместо удаления.
    $(root).on('click', '.pw-chip-remove', function (event) {
        event.stopPropagation();
        const qid = $(this).closest('.pw-chip').data('qid');
        $(this).closest('.pw-chip').fadeOut(120, function () {
            $(this).remove();
            updateLimitLabel(root, qid);
            persistDraft();
        });
    });

    // Кнопка "+" рядом с полем "Свой вариант" — превращает введённый текст
    // в новый чип. Для 'single'-вопросов — заменяет предыдущий кастомный
    // чип (только один осмысленный выбор), для 'multi' — просто добавляется.
    const addCustomChip = ($input) => {
        const qid = $input.data('qid');
        const value = String($input.val() || '').trim();
        if (!value) return;

        const question = findQuestion(qid);
        if (!question) return;

        const $row = $(root).find(`.pw-chip-row[data-qid="${qid}"]`);
        if (question.type === 'single') {
            $row.find('.pw-chip').not('.pw-chip--add').removeClass('pw-chip--active');
            $row.find('.pw-chip--custom').remove();
        } else if (question.maxSelect && countActive(root, qid) >= question.maxSelect) {
            toastr.info(`Можно выбрать не больше ${question.maxSelect}.`, question.label);
            return;
        }
        $(customChipHtml(question, { value, active: true }))
            .hide()
            .insertBefore($row.find('.pw-chip--add'))
            .fadeIn(150);
        $input.val('');
        $(root).find(`.pw-add-row[data-qid="${qid}"]`).slideUp(150);
        updateLimitLabel(root, qid);
        persistDraft();
    };

    $(root).on('click', '.pw-custom-add-btn', function () {
        addCustomChip($(root).find(`.pw-custom-add-input[data-qid="${$(this).data('qid')}"]`));
    });
    $(root).on('keydown', '.pw-custom-add-input', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        addCustomChip($(this));
    });

    // Любое изменение заметок/тумблеров/модели/выбора лорбука — тоже сохраняем.
    $(root).on('input change', '.pw-notes, .pw-model-select, .pw-ctx-toggle, .pw-history-count, .pw-lore-checkbox', persistDraft);

    // Если сняли галку "Недавние сообщения" — поле "Сколько сообщений"
    // прячем целиком (как и с лорбуком ниже), а не просто гасим.
    const syncHistoryCountField = (animate) => {
        const historyOn = $(root).find('.pw-ctx-toggle[data-ctx-id="history"]').prop('checked');
        const $field = $(root).find('.pw-history-count-field');
        if (animate) historyOn ? $field.slideDown(150) : $field.slideUp(150);
        else $field.toggle(historyOn);
    };
    $(root).on('change', '.pw-ctx-toggle[data-ctx-id="history"]', () => syncHistoryCountField(true));
    syncHistoryCountField(false);

    // Если сняли галку "Лорбук" — список выбора книг вообще прячем,
    // он бесполезен, пока лорбук не читается.
    const syncLoreField = (animate) => {
        const loreOn = $(root).find('.pw-ctx-toggle[data-ctx-id="lore"]').prop('checked');
        const $field = $(root).find('.pw-lore-field');
        if (animate) loreOn ? $field.slideDown(150) : $field.slideUp(150);
        else $field.toggle(loreOn);
    };
    $(root).on('change', '.pw-ctx-toggle[data-ctx-id="lore"]', () => syncLoreField(true));
    syncLoreField(false);

    // Поиск по списку лорбуков — просто прячет несовпавшие строки,
    // выбор (галки) при этом не трогает.
    $(root).on('input', '.pw-lore-search', function () {
        const query = String($(this).val() || '').trim().toLowerCase();
        $(root).find('.pw-lore-item').each(function () {
            const text = $(this).text().trim().toLowerCase();
            $(this).toggle(!query || text.includes(query));
        });
    });

    // Клик по кнопке "Показать промт" — собирает реальный контекст (карточка/
    // персона/лорбук/история) и реальные ответы опросника, склеивает финальный
    // промт и показывает его текстом. Повторный клик, пока промт уже открыт,
    // просто закрывает блок — без пересчёта.
    // buildContext асинхронная (лорбук отдаётся Promise-ом), поэтому await.
    $(root).on('click', '.pw-preview-btn', async () => {
        const $wrap = $(root).find('.pw-prompt-preview-wrap');
        const $btn = $(root).find('.pw-preview-btn');

        if ($wrap.is(':visible')) {
            $wrap.slideUp(150);
            $btn.html('<i class="fa-solid fa-eye"></i> Показать промт');
            return;
        }

        const answers = collectAnswers(root);
        const notes = $(root).find('.pw-notes').val();
        const settings = collectGenerationSettings(root);

        const contextText = await buildContext(settings);
        const prompt = buildPrompt({ contextText, answers, notes });

        $(root).find('.pw-prompt-preview').val(prompt);
        $wrap.slideDown(150);
        $btn.html('<i class="fa-solid fa-eye-slash"></i> Скрыть промт');
    });

    // Клик по кнопке "Сгенерировать" — собирает промт и реально отправляет
    // его модели (основной API чата или выбранный профиль подключения).
    // Если окно к моменту готовности результата уже закрыто — результат
    // сам сохраняется страницей в блокнот и блокнот открывается; если
    // окно всё ещё открыто — как раньше, показываем окно результата
    // для правки перед сохранением.
    $(root).on('click', '.pw-generate-btn', async () => {
        const answers = collectAnswers(root);
        const notes = $(root).find('.pw-notes').val();
        const settings = collectGenerationSettings(root);

        const $generateBtn = $(root).find('.pw-generate-btn');
        const $cancelBtn = $(root).find('.pw-cancel-btn');
        $generateBtn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Идёт генерация...');
        $cancelBtn.show();

        const abortController = new AbortController();
        activeAbort = abortController;
        activeUsesProfile = Boolean(settings.profileId);

        try {
            const contextText = await buildContext(settings);
            const prompt = buildPrompt({ contextText, answers, notes });
            const responseLength = computeResponseLength(answers);

            const text = await runGeneration({
                prompt,
                profileId: settings.profileId,
                responseLength,
                signal: abortController.signal,
            });

            if (popupState.closed) {
                addPage({ text, answers, notes });
                toastr.success('Сюжет готов и сохранён в Sketchbook.', 'Plotweaver');
                openNotebook();
            } else {
                openReview(text, { answers, notes });
            }
        } catch (error) {
            if (error?.name === 'AbortError') {
                toastr.info('Генерация отменена.', 'Plotweaver');
            } else {
                console.error('[Plotweaver] ошибка генерации', error);
                toastr.error(String(error?.message || error), 'Plotweaver: не удалось сгенерировать');
            }
        } finally {
            activeAbort = null;
            $generateBtn.prop('disabled', false).html('<i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать сюжет');
            $cancelBtn.hide();
        }
    });

    $(root).on('click', '.pw-cancel-btn', () => {
        if (!activeAbort) return;
        activeAbort.abort(new DOMException('Cancelled by user', 'AbortError'));
        if (!activeUsesProfile) stopMainApiGeneration();
    });

    const context = ctx();
    const popup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: 'Закрыть',
    });

    // popup.show() резолвится, когда окно закрыто — используем это как
    // сигнал "юзер ушёл", независимо от того, идёт ли ещё генерация.
    const closePromise = popup.show();
    closePromise.then(() => { popupState.closed = true; });
    await closePromise;
}

// ---------------------------------------------------------------------------
// Окно 2 — Результат генерации
// ---------------------------------------------------------------------------

/**
 * Открывает окно с готовым (или пока заглушечным) текстом сюжета.
 * meta: { answers, notes } — снимок ответов опросника на момент генерации,
 * сохраняется вместе со страницей, чтобы потом можно было открыть "Открыть
 * в опроснике" и перегенерировать с теми же настройками.
 */
export async function openReview(text, meta = {}) {
    const root = document.createElement('div');
    root.classList.add('pw-dialog');

    root.innerHTML = `
        <h3 class="pw-title">Готовый сюжет</h3>
        <input type="text" class="text_pole pw-review-title" placeholder="Название страницы">
        <textarea class="text_pole pw-review-text" rows="16">${escapeHtml(text)}</textarea>
        <div class="pw-footer">
            <button class="menu_button pw-save-btn">
                <i class="fa-solid fa-floppy-disk"></i>
                Сохранить в Sketchbook
            </button>
        </div>
    `;

    $(root).on('click', '.pw-save-btn', () => {
        const finalText = $(root).find('.pw-review-text').val();
        const title = $(root).find('.pw-review-title').val().trim();
        addPage({
            title: title || undefined,
            text: finalText,
            answers: meta.answers || {},
            notes: meta.notes || '',
        });
        toastr.success('Сохранено в Sketchbook.', 'Plotweaver');
        popup.complete(context.POPUP_RESULT.AFFIRMATIVE);
    });

    const context = ctx();
    const popup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: 'Закрыть',
    });

    await popup.show();
}

// ---------------------------------------------------------------------------
// Окно 3 — Sketchbook (блокнот)
// ---------------------------------------------------------------------------

/** Старые страницы, сохранённые до появления режимов, считаются 'plot'. */
function pageKind(page) {
    return page.kind === 'persona' ? 'persona' : 'plot';
}

/** Список всех тегов, встречающихся хоть на одной странице этого режима. */
function allTags(pages) {
    const set = new Set();
    for (const page of pages) {
        (page.tags || []).forEach((tag) => set.add(tag));
    }
    return [...set].sort((a, b) => a.localeCompare(b));
}

function tagFilterPanelHtml(pages, activeTags) {
    const tags = allTags(pages);
    if (!tags.length) {
        return '<div class="pw-hint">Тегов пока нет — добавь их на странице.</div>';
    }
    return tags
        .map((tag) => `<div class="pw-chip pw-filter-tag ${activeTags.has(tag) ? 'pw-chip--active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</div>`)
        .join('');
}

function pageTabHtml(page, activePageId) {
    return `
        <div class="pw-page-tab ${page.id === activePageId ? 'pw-page-tab--active' : ''}" data-page-id="${page.id}">
            <span class="pw-page-fav ${page.favorite ? 'pw-page-fav--on' : ''}" data-page-id="${page.id}" title="В избранное">★</span>
            <span class="pw-page-tab-title">${escapeHtml(page.title)}</span>
        </div>
    `;
}

/** mode: 'plot' | 'persona' — какие страницы вообще видны в этом режиме. */
function notebookPageListHtml(pagesStore, mode, activeTags) {
    let pages = pagesStore.pages.filter((p) => pageKind(p) === mode);
    if (activeTags.size) {
        pages = pages.filter((page) => (page.tags || []).some((tag) => activeTags.has(tag)));
    }
    if (!pages.length) {
        const hasAnyInMode = pagesStore.pages.some((p) => pageKind(p) === mode);
        return hasAnyInMode
            ? '<div class="pw-hint">Ни одна страница не подходит под выбранные теги.</div>'
            : '<div class="pw-hint">Пока пусто в этом режиме.</div>';
    }

    const favorites = pages.filter((p) => p.favorite);
    const rest = pages.filter((p) => !p.favorite);
    const divider = favorites.length && rest.length ? '<div class="pw-page-divider"></div>' : '';

    return favorites.map((p) => pageTabHtml(p, pagesStore.activePageId)).join('')
        + divider
        + rest.map((p) => pageTabHtml(p, pagesStore.activePageId)).join('');
}

/** Чипы тегов текущей страницы + кнопка "+ тег". */
function pageTagsHtml(page) {
    const tagsHtml = (page.tags || [])
        .map((tag) => `
            <div class="pw-chip pw-chip--custom pw-chip--active pw-page-tag" data-tag="${escapeHtml(tag)}">
                <span>${escapeHtml(tag)}</span>
                <span class="pw-chip-remove" title="Удалить">×</span>
            </div>
        `)
        .join('');
    return `
        <div class="pw-chip-row">
            ${tagsHtml}
            <div class="pw-chip pw-chip--add pw-page-tag-add">+ тег</div>
        </div>
        <div class="pw-add-row pw-page-tag-add-row" style="display: none;">
            <input type="text" class="text_pole pw-page-tag-input" placeholder="Новый тег...">
            <button type="button" class="menu_button pw-page-tag-add-btn">+</button>
        </div>
    `;
}

/** Тулбар декораций текста — оборачивает выделенный кусок textarea маркерами. */
const MD_TOOLBAR_HTML = `
    <div class="pw-md-toolbar">
        <button type="button" class="pw-md-btn" data-before="**" title="Жирный"><b>Ж</b></button>
        <button type="button" class="pw-md-btn" data-before="*" title="Курсив"><i>К</i></button>
        <button type="button" class="pw-md-btn" data-before="++" title="Подчёркнутый"><u>Ч</u></button>
        <button type="button" class="pw-md-btn" data-before="~~" title="Зачёркнутый"><s>З</s></button>
        <span class="pw-md-hl-group">
            <button type="button" class="pw-md-hl pw-hl-yellow" data-color="yellow" title="Жёлтый хайлайт"></button>
            <button type="button" class="pw-md-hl pw-hl-pink" data-color="pink" title="Розовый хайлайт"></button>
            <button type="button" class="pw-md-hl pw-hl-green" data-color="green" title="Зелёный хайлайт"></button>
            <button type="button" class="pw-md-hl pw-hl-blue" data-color="blue" title="Синий хайлайт"></button>
        </span>
    </div>
`;

function notebookViewerHtml(pagesStore, previewMode) {
    const page = pagesStore.pages.find((p) => p.id === pagesStore.activePageId);
    if (!page) return '<p class="pw-hint">Выбери страницу слева — или создай новую.</p>';

    const bodyHtml = previewMode
        ? `<div class="pw-notebook-preview">${renderMarkdown(page.text)}</div>`
        : `<textarea class="text_pole pw-notebook-text">${escapeHtml(page.text)}</textarea>`;

    return `
        <div class="pw-page-viewer-top">
            <input type="text" class="text_pole pw-page-title" value="${escapeHtml(page.title)}">
            <div class="pw-question-label">Теги</div>
            ${pageTagsHtml(page)}
            ${previewMode ? '' : MD_TOOLBAR_HTML}
        </div>
        <div class="pw-page-viewer-scroll">
            ${bodyHtml}
        </div>
        <div class="pw-footer">
            <button class="menu_button pw-btn-lg pw-page-preview-toggle">
                <i class="fa-solid fa-${previewMode ? 'pen' : 'eye'}"></i>
                ${previewMode ? 'Редактировать' : 'Просмотр'}
            </button>
            <div class="pw-footer-right">
                <button class="menu_button pw-btn-lg pw-page-reopen-btn">
                    <i class="fa-solid fa-arrow-rotate-left"></i>
                    ${pageKind(page) === 'persona' ? 'Открыть в Alter' : 'Открыть в опроснике'}
                </button>
                <button class="menu_button pw-btn-lg pw-page-duplicate-btn">
                    <i class="fa-solid fa-copy"></i>
                    Дублировать
                </button>
                <button class="menu_button pw-btn-lg pw-page-delete-btn">
                    <i class="fa-solid fa-trash"></i>
                    Удалить
                </button>
            </div>
        </div>
    `;
}

/** Оборачивает выделение в textarea маркерами (или ставит курсор между ними, если ничего не выделено). */
function wrapTextareaSelection(textarea, before, after = before) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    const selected = value.slice(start, end);
    textarea.value = value.slice(0, start) + before + selected + after + value.slice(end);
    const newStart = start + before.length;
    textarea.setSelectionRange(newStart, newStart + selected.length);
    textarea.focus();
}

/**
 * Открывает Sketchbook — страницы-планы для текущего чата, из chatMetadata
 * (см. settings.js). Поддерживает избранное (звёздочка в списке), теги с
 * фильтром, и переключение черновик/просмотр с рендером маркдауна.
 */
export async function openNotebook() {
    const root = document.createElement('div');
    root.classList.add('pw-dialog', 'pw-notebook-dialog');

    // Состояние экрана, которое не хранится между открытиями окна — только
    // пока оно открыто сейчас.
    let mode = 'plot'; // 'plot' | 'persona'
    let previewMode = false;
    const activeTagFilters = new Set();
    let filterPanelOpen = false;

    const render = () => {
        const pagesStore = getPagesStore();
        const pagesInMode = pagesStore.pages.filter((p) => pageKind(p) === mode);
        const activePage = pagesStore.pages.find((p) => p.id === pagesStore.activePageId);
        // Если активная страница принадлежит другому режиму — вьюер её не
        // показывает (переключаемся на неё только явным кликом по вкладке).
        const viewerPagesStore = activePage && pageKind(activePage) === mode
            ? pagesStore
            : { pages: pagesStore.pages, activePageId: null };

        root.innerHTML = `
            <h3 class="pw-title">Sketchbook</h3>
            <div class="pw-notebook-mode-switch pw-segmented">
                <button type="button" class="pw-seg pw-notebook-mode-btn" data-mode="plot" aria-pressed="${mode === 'plot'}">Сюжеты</button>
                <button type="button" class="pw-seg pw-notebook-mode-btn" data-mode="persona" aria-pressed="${mode === 'persona'}">Персоны</button>
            </div>
            <div class="pw-notebook-layout">
                <div class="pw-page-list">
                    <div class="pw-page-list-header">
                        <button type="button" class="pw-filter-btn ${activeTagFilters.size ? 'pw-filter-btn--active' : ''}" title="Фильтр по тегам">
                            <i class="fa-solid fa-filter"></i>
                        </button>
                    </div>
                    <div class="pw-filter-panel" style="display: ${filterPanelOpen ? 'flex' : 'none'};">
                        ${tagFilterPanelHtml(pagesInMode, activeTagFilters)}
                    </div>
                    <div class="pw-page-tabs-scroll">
                        ${notebookPageListHtml(pagesStore, mode, activeTagFilters)}
                    </div>
                    <button class="menu_button pw-new-page-btn">
                        <i class="fa-solid fa-plus"></i> Новая страница
                    </button>
                </div>
                <div class="pw-page-viewer">
                    ${notebookViewerHtml(viewerPagesStore, previewMode)}
                </div>
            </div>
        `;
    };
    render();

    $(root).on('click', '.pw-notebook-mode-btn', function () {
        mode = $(this).data('mode');
        previewMode = false;
        activeTagFilters.clear();
        render();
    });

    $(root).on('click', '.pw-page-tab', function () {
        setActivePage($(this).data('page-id'));
        previewMode = false;
        render();
    });

    // Звёздочка — переключает избранное прямо в списке, не открывая страницу.
    // stopPropagation, чтобы клик не долетел до обработчика вкладки выше.
    $(root).on('click', '.pw-page-fav', function (event) {
        event.stopPropagation();
        const pageId = $(this).data('page-id');
        const pagesStore = getPagesStore();
        const page = pagesStore.pages.find((p) => p.id === pageId);
        if (!page) return;
        updatePage(pageId, { favorite: !page.favorite });
        render();
    });

    $(root).on('click', '.pw-filter-btn', () => {
        filterPanelOpen = !filterPanelOpen;
        const $panel = $(root).find('.pw-filter-panel');
        filterPanelOpen ? $panel.slideDown(150) : $panel.slideUp(150);
        $(root).find('.pw-filter-btn').toggleClass('pw-filter-btn--active', activeTagFilters.size > 0);
    });

    $(root).on('click', '.pw-filter-tag', function () {
        const tag = $(this).attr('data-tag');
        if (activeTagFilters.has(tag)) activeTagFilters.delete(tag);
        else activeTagFilters.add(tag);
        render();
        // render() пересобирает всё окно заново — открытая панель фильтра
        // сама себя не помнит между рендерами, поэтому переоткрываем её,
        // раз юзер явно ей сейчас пользуется.
        filterPanelOpen = true;
        $(root).find('.pw-filter-panel').show();
    });

    $(root).on('click', '.pw-new-page-btn', () => {
        addPage({ text: '', kind: mode });
        previewMode = false;
        render();
    });

    $(root).on('change', '.pw-page-title', function () {
        const pagesStore = getPagesStore();
        updatePage(pagesStore.activePageId, { title: $(this).val().trim() || 'Без названия' });
    });

    $(root).on('change', '.pw-notebook-text', function () {
        const pagesStore = getPagesStore();
        updatePage(pagesStore.activePageId, { text: $(this).val() });
    });

    // Тулбар декораций — оборачивает выделение в textarea маркерами и сам
    // же вызывает 'change', чтобы автосохранение (обработчик выше) сработало.
    $(root).on('click', '.pw-md-btn', function () {
        const textarea = $(root).find('.pw-notebook-text').get(0);
        if (!textarea) return;
        wrapTextareaSelection(textarea, String($(this).data('before')));
        $(textarea).trigger('change');
    });
    $(root).on('click', '.pw-md-hl', function () {
        const textarea = $(root).find('.pw-notebook-text').get(0);
        if (!textarea) return;
        const color = $(this).data('color');
        wrapTextareaSelection(textarea, `==${color}:`, '==');
        $(textarea).trigger('change');
    });

    // Просмотр ⇄ Редактирование.
    $(root).on('click', '.pw-page-preview-toggle', () => {
        previewMode = !previewMode;
        render();
    });

    // Теги страницы — тот же принцип "+ чип", что и в опроснике.
    $(root).on('click', '.pw-page-tag-add', function () {
        $(root).find('.pw-page-tag-add-row').slideDown(150);
        $(root).find('.pw-page-tag-input').trigger('focus');
    });
    const addPageTag = () => {
        const $input = $(root).find('.pw-page-tag-input');
        const value = String($input.val() || '').trim();
        if (!value) return;
        const pagesStore = getPagesStore();
        const page = pagesStore.pages.find((p) => p.id === pagesStore.activePageId);
        if (!page) return;
        const tags = Array.from(new Set([...(page.tags || []), value]));
        updatePage(page.id, { tags });
        render();
    };
    $(root).on('click', '.pw-page-tag-add-btn', addPageTag);
    $(root).on('keydown', '.pw-page-tag-input', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        addPageTag();
    });
    $(root).on('click', '.pw-page-tag .pw-chip-remove', function (event) {
        event.stopPropagation();
        const tag = $(this).closest('.pw-page-tag').attr('data-tag');
        const pagesStore = getPagesStore();
        const page = pagesStore.pages.find((p) => p.id === pagesStore.activePageId);
        if (!page) return;
        updatePage(page.id, { tags: (page.tags || []).filter((t) => t !== tag) });
        render();
    });

    $(root).on('click', '.pw-page-duplicate-btn', () => {
        const pagesStore = getPagesStore();
        const page = pagesStore.pages.find((p) => p.id === pagesStore.activePageId);
        if (!page) return;
        addPage({
            title: `${page.title} (копия)`,
            text: page.text,
            answers: page.answers,
            notes: page.notes,
            tags: page.tags,
            kind: pageKind(page),
        });
        render();
    });

    $(root).on('click', '.pw-page-delete-btn', () => {
        const pagesStore = getPagesStore();
        if (!pagesStore.activePageId) return;
        deletePage(pagesStore.activePageId);
        render();
    });

    // "Открыть в опроснике"/"Открыть в Alter" — для сюжетных страниц
    // подставляет ответы в черновик опросника и открывает его; для персон
    // (у Alter пока нет черновика-состояния) просто открывает Alter с
    // чистого листа.
    $(root).on('click', '.pw-page-reopen-btn', () => {
        const pagesStore = getPagesStore();
        const page = pagesStore.pages.find((p) => p.id === pagesStore.activePageId);
        if (!page) return;

        if (pageKind(page) === 'persona') {
            openAlter();
            return;
        }

        const currentDraft = getDraft();
        saveDraftDebounced({
            answers: page.answers || {},
            notes: page.notes || '',
            generation: currentDraft.generation,
        });
        openQuestionnaire();
    });

    const context = ctx();
    const popup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: 'Закрыть',
    });

    await popup.show();
}
