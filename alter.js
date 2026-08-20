// Plotweaver — Alter: стартовые точки для новых персонажей.
//
// Маленький, самостоятельный модуль поверх уже готовой машинерии: контекст
// (карточка + первое сообщение + лорбук) берём из prompt.js, генерацию — из
// generate.js, сохранение — из settings.js (страница с kind: 'persona').
// Своего каталога-с-секциями тут не нужно — полей всего пять.

import { buildContext } from './prompt.js';
import { runGeneration, stopMainApiGeneration } from './generate.js';
import { addPage, getAlterDraft, saveAlterDraftDebounced } from './settings.js';
import { modelSectionHtml, loreSelectHtml, getDefaultCharacterLoreName } from './ui.js';

function ctx() {
    return SillyTavern.getContext();
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Все уникальные имена сохранённых Persona (для "избегать уже занятых имён"). */
function getAllPersonaNames() {
    try {
        const personas = ctx().powerUserSettings?.personas || {};
        return [...new Set(Object.values(personas))].filter(Boolean);
    } catch (error) {
        console.warn('[Plotweaver] не удалось получить список персон', error);
        return [];
    }
}

const GENDER_OPTIONS = [
    { id: 'male', label: 'Male' },
    { id: 'female', label: 'Female' },
    { id: 'any', label: 'Любой' },
];

const INVENTION_OPTIONS = [
    { id: 'canon', label: 'Строго канон' },
    { id: 'balanced', label: 'Средне' },
    { id: 'free', label: 'Смело' },
];

// Мускус и озон намеренно нет в списке и явно запрещены в промте — автор
// не хочет их видеть вообще, даже если бы модель решила добавить сама.
const PHEROMONE_OPTIONS = [
    { id: 'sweet_floral', label: 'Сладкий/цветочный', labelEn: 'sweet floral' },
    { id: 'spicy_woody', label: 'Пряный/древесный', labelEn: 'spicy woody' },
    { id: 'citrus', label: 'Цитрусовый', labelEn: 'citrus' },
    { id: 'berry_fruity', label: 'Ягодный/фруктовый', labelEn: 'berry/fruity' },
    { id: 'vanilla', label: 'Ванильный', labelEn: 'vanilla' },
    { id: 'salty_sea', label: 'Солоноватый/морской', labelEn: 'salty/sea air' },
    { id: 'smoky_resinous', label: 'Дымный/смолистый', labelEn: 'smoky/resinous' },
    { id: 'herbal_green', label: 'Травяной/зелёный', labelEn: 'herbal/green' },
    { id: 'metallic_cold', label: 'Металлический/холодный', labelEn: 'metallic/cold' },
    { id: 'honey', label: 'Медовый', labelEn: 'honey' },
    { id: 'coffee_chocolate', label: 'Кофейный/шоколадный', labelEn: 'coffee/chocolate' },
    { id: 'earthy', label: 'Землистый', labelEn: 'earthy' },
];

// ---------------------------------------------------------------------------
// Промт
// ---------------------------------------------------------------------------

const INVENTION_TEXT = {
    canon: 'Stick strictly to what is already established in the character card and lorebook. Do not invent worldbuilding facts that contradict them.',
    balanced: 'Rely on the card/lorebook where they say something; where they are silent, feel free to invent logical, fitting details.',
    free: 'The card/lorebook are binding wherever they establish something, but where material is missing, invent generously and boldly.',
};

/**
 * Собирает промт для Alter.
 * params: { contextText, gender, species, pheromoneLabels, notes, connection, invention, avoidNames }
 */
function buildAlterPrompt({ contextText, gender, species, pheromoneLabels, notes, connection, invention, avoidNames }) {
    const parts = [];

    parts.push(
        'You are helping generate a STARTING POINT for a brand-new roleplay character — '
        + 'not a finished character sheet, not prose, not a finished bio. The author will '
        + 'mix and match pieces afterward (a name from one option, a personality block from '
        + 'another) — so give independent, varied options, not five complete matching characters.',
    );
    parts.push('Write everything in English.');
    parts.push(
        'THIS IS A STARTING POINT, NOT A CHARACTER BIBLE.\n'
        + 'No atmospheric description, no backstory paragraphs, no flowery language. '
        + 'Personality is single-word traits only. Background is short, concrete bullet '
        + 'points — not a memoir. If a sentence could be cut without losing information, cut it.',
    );

    if (contextText) parts.push(contextText);

    const briefLines = [];
    if (gender) briefLines.push(`- Gender/pronouns: ${gender}`);
    if (species) briefLines.push(`- Race/species (take this into account for background and, if relevant, scent): ${species}`);
    if (connection) briefLines.push(`- Connection to this bot/story — this MUST be reflected in the background options: ${connection}`);
    if (briefLines.length) {
        parts.push(`# AUTHOR'S BRIEF (MANDATORY)\n${briefLines.join('\n')}`);
    }

    if (avoidNames && avoidNames.length) {
        parts.push(
            "# NAMES ALREADY IN USE (MANDATORY)\n"
            + 'Do not use any of these names for the new character — they already belong to '
            + `existing personas: ${avoidNames.join(', ')}.`,
        );
    }

    if (notes && notes.trim()) {
        parts.push(`# FREE-FORM NOTES AND WISHES (MANDATORY)\n${notes.trim()}`);
    }

    parts.push(`# HOW MUCH TO INVENT\n${INVENTION_TEXT[invention] || INVENTION_TEXT.balanced}`);

    const scentSection = pheromoneLabels.length
        ? `\n\n## SCENT\n5 variations of scent/pheromone notes, each incorporating: ${pheromoneLabels.join(', ')}. `
            + 'One short phrase per line, numbered 1-5.\n'
            + 'Never use "musk/musky" or "ozone" as a note, regardless of anything above — '
            + 'these are overused and specifically unwanted.'
        : '';

    parts.push(
        '# OUTPUT FORMAT (MANDATORY)\n'
        + 'Give exactly these sections, in this order, and nothing else:\n\n'
        + '## NAMES\n'
        + '10 full names (first + family name) fitting the setting. One per line, numbered 1-10.'
        + scentSection
        + '\n\n## PERSONALITY\n'
        + '5 variations. Each is 5-6 single-word traits, comma-separated '
        + '(e.g. "cheerful, clingy, melancholic, blunt, loyal"). One per line, numbered 1-5.\n\n'
        + '## BACKGROUND\n'
        + '5 variations. Each is 4-5 short bullet points — who they are, where they\'re from, '
        + 'and their connection to this bot/story. Concrete and factual, not a memoir. '
        + 'One numbered block (1-5) per variation.',
    );

    parts.push(
        'FINAL REMINDER: starting point, not prose. No atmosphere, no scene-setting, no '
        + 'sentimental phrasing — plain, mixable options within the limits above.',
    );

    return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Окно
// ---------------------------------------------------------------------------

function chipRowHtml(name, options, selectedIds) {
    return options
        .map((opt) => `<div class="pw-chip ${selectedIds.includes(opt.id) ? 'pw-chip--active' : ''}" data-name="${name}" data-value="${opt.id}">${escapeHtml(opt.label)}</div>`)
        .join('');
}

function segmentedRowHtml(name, options, activeId) {
    return options
        .map((opt) => `<button type="button" class="pw-seg pw-alter-seg" data-name="${name}" data-value="${opt.id}" aria-pressed="${opt.id === activeId}">${escapeHtml(opt.label)}</button>`)
        .join('');
}

/** Окно с результатом — тот же принцип, что у Plotweaver, но сохраняет kind: 'persona'. */
async function openAlterResult(text) {
    const root = document.createElement('div');
    root.classList.add('pw-dialog');

    root.innerHTML = `
        <h3 class="pw-title">Alter — стартовая точка персонажа</h3>
        <input type="text" class="text_pole pw-review-title" placeholder="Название страницы">
        <textarea class="text_pole pw-review-text" rows="16">${escapeHtml(text)}</textarea>
        <div class="pw-footer">
            <button class="menu_button pw-btn-lg pw-save-btn">
                <i class="fa-solid fa-floppy-disk"></i>
                Сохранить в Sketchbook
            </button>
        </div>
    `;

    const context = ctx();
    const popup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: false,
        cancelButton: 'Закрыть',
    });

    $(root).on('click', '.pw-save-btn', () => {
        const finalText = $(root).find('.pw-review-text').val();
        const title = $(root).find('.pw-review-title').val().trim();
        addPage({ title: title || undefined, text: finalText, kind: 'persona' });
        toastr.success('Сохранено в Sketchbook.', 'Alter');
        popup.complete(context.POPUP_RESULT.AFFIRMATIVE);
    });

    await popup.show();
}

/** Открывает окно Alter — маленький опросник для стартовой точки персонажа. */
export async function openAlter() {
    const root = document.createElement('div');
    root.classList.add('pw-dialog');

    const draft = getAlterDraft();
    const loreNamesForForm = draft.loreNames.length ? draft.loreNames : [getDefaultCharacterLoreName()].filter(Boolean);

    root.innerHTML = `
        <h3 class="pw-title">Alter — стартовая точка персонажа</h3>
        <p class="pw-hint">
            Никаких готовых персонажей — просто набор имён, запахов, характеров и бэкграундов,
            чтобы собрать своего.
        </p>

        <div class="pw-question">
            <div class="pw-question-label">Пол/местоимения</div>
            <div class="pw-segmented">${segmentedRowHtml('gender', GENDER_OPTIONS, draft.gender)}</div>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Раса/вид</div>
            <div class="pw-question-hint">Пиши как хочешь — модель учтёт это в фоне и запахе (если он выбран).</div>
            <input type="text" class="text_pole pw-alter-species" placeholder="Например: омега, демон, эльф..." value="${escapeHtml(draft.species)}">
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Феромоны/запах</div>
            <div class="pw-chip-row" id="pw-alter-pheromones">${chipRowHtml('pheromones', PHEROMONE_OPTIONS, draft.pheromoneIds)}</div>
        </div>

        <div class="pw-question">
            <label class="pw-toggle">
                <input type="checkbox" class="pw-alter-avoid-names" ${draft.avoidNames !== false ? 'checked' : ''}>
                <span>Избегать уже занятых имён (${getAllPersonaNames().length} персон в библиотеке)</span>
            </label>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Связь с ботом/сюжетом</div>
            <div class="pw-question-hint">Уйдёт в бэкграунд, отдельным блоком в выводе не станет.</div>
            <textarea class="text_pole pw-alter-connection" rows="2" placeholder="Например: детство вместе, случайная встреча, похищен...">${escapeHtml(draft.connection)}</textarea>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Свободные заметки и хотелки</div>
            <textarea class="text_pole pw-alter-notes" rows="3" placeholder="Всё, что не влезло выше...">${escapeHtml(draft.notes)}</textarea>
        </div>

        <div class="pw-question">
            <div class="pw-question-label">Сколько выдумывать</div>
            <div class="pw-segmented">${segmentedRowHtml('invention', INVENTION_OPTIONS, draft.invention)}</div>
        </div>

        <div class="pw-generation-settings">
            ${modelSectionHtml(draft.profileId)}
            <div class="pw-question">
                <div class="pw-question-label">Какие лорбуки</div>
                ${loreSelectHtml(loreNamesForForm)}
            </div>
        </div>

        <div class="pw-footer">
            <button class="menu_button pw-btn-lg pw-alter-cancel-btn" style="display: none;">
                <i class="fa-solid fa-xmark"></i>
                Отмена
            </button>
            <div class="pw-footer-right">
                <button class="menu_button pw-generate-btn pw-alter-generate-btn">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                    Сгенерировать
                </button>
            </div>
        </div>
    `;

    // Собирает текущее состояние формы и сохраняет его как черновик Alter.
    const persistAlterDraft = () => {
        saveAlterDraftDebounced({
            gender: $(root).find('.pw-alter-seg[data-name="gender"][aria-pressed="true"]').data('value') || 'male',
            species: $(root).find('.pw-alter-species').val().trim(),
            pheromoneIds: $(root).find('#pw-alter-pheromones .pw-chip--active').map(function () { return $(this).data('value'); }).get(),
            connection: $(root).find('.pw-alter-connection').val(),
            notes: $(root).find('.pw-alter-notes').val(),
            invention: $(root).find('.pw-alter-seg[data-name="invention"][aria-pressed="true"]').data('value') || 'balanced',
            profileId: $(root).find('.pw-model-select').val() || '',
            loreNames: $(root).find('.pw-lore-checkbox:checked').map(function () { return $(this).val(); }).get(),
            avoidNames: $(root).find('.pw-alter-avoid-names').prop('checked'),
        });
    };

    // Чипы феромонов — множественный выбор, без лимита.
    $(root).on('click', '.pw-chip', function () {
        $(this).toggleClass('pw-chip--active');
        persistAlterDraft();
    });

    // Сегментированные ряды (пол, сколько выдумывать) — один активный в своей группе.
    $(root).on('click', '.pw-alter-seg', function () {
        const $btn = $(this);
        $btn.siblings(`[data-name="${$btn.data('name')}"]`).attr('aria-pressed', 'false');
        $btn.attr('aria-pressed', 'true');
        persistAlterDraft();
    });

    // Любое изменение текстовых полей/модели/лорбуков/тумблера имён — тоже сохраняем.
    $(root).on('input change', '.pw-alter-species, .pw-alter-connection, .pw-alter-notes, .pw-model-select, .pw-lore-checkbox, .pw-alter-avoid-names', persistAlterDraft);

    let activeAbort = null;
    let activeUsesProfile = false;
    let popupClosed = false;

    $(root).on('click', '.pw-alter-generate-btn', async () => {
        const gender = $(root).find('.pw-alter-seg[data-name="gender"][aria-pressed="true"]').data('value') || 'male';
        const invention = $(root).find('.pw-alter-seg[data-name="invention"][aria-pressed="true"]').data('value') || 'balanced';
        const species = $(root).find('.pw-alter-species').val().trim();
        const connection = $(root).find('.pw-alter-connection').val().trim();
        const notes = $(root).find('.pw-alter-notes').val().trim();
        const pheromoneIds = $(root).find('#pw-alter-pheromones .pw-chip--active').map(function () {
            return $(this).data('value');
        }).get();
        const pheromoneLabels = PHEROMONE_OPTIONS
            .filter((opt) => pheromoneIds.includes(opt.id))
            .map((opt) => opt.labelEn);
        const profileId = $(root).find('.pw-model-select').val() || '';
        const loreNames = $(root).find('.pw-lore-checkbox:checked').map(function () { return $(this).val(); }).get();

        const $generateBtn = $(root).find('.pw-alter-generate-btn');
        const $cancelBtn = $(root).find('.pw-alter-cancel-btn');
        $generateBtn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Идёт генерация...');
        $cancelBtn.show();

        const abortController = new AbortController();
        activeAbort = abortController;
        activeUsesProfile = Boolean(profileId);

        try {
            const genderLabel = GENDER_OPTIONS.find((o) => o.id === gender)?.label || 'Male';
            const contextText = await buildContext({
                useCard: true,
                usePersona: false,
                useLore: true,
                loreNames,
                useHistory: true,
                historyCount: 1,
            });

            const prompt = buildAlterPrompt({
                contextText,
                gender: genderLabel,
                species,
                pheromoneLabels,
                notes,
                connection,
                invention,
                avoidNames: $(root).find('.pw-alter-avoid-names').prop('checked') ? getAllPersonaNames() : [],
            });

            const text = await runGeneration({
                prompt,
                profileId,
                responseLength: 4096,
                signal: abortController.signal,
            });

            if (popupClosed) {
                addPage({ text, kind: 'persona' });
                toastr.success('Готово и сохранено в Sketchbook.', 'Alter');
            } else {
                openAlterResult(text);
            }
        } catch (error) {
            if (error?.name === 'AbortError') {
                toastr.info('Генерация отменена.', 'Alter');
            } else {
                console.error('[Plotweaver] ошибка генерации Alter', error);
                toastr.error(String(error?.message || error), 'Alter: не удалось сгенерировать');
            }
        } finally {
            activeAbort = null;
            $generateBtn.prop('disabled', false).html('<i class="fa-solid fa-wand-magic-sparkles"></i> Сгенерировать');
            $cancelBtn.hide();
        }
    });

    $(root).on('click', '.pw-alter-cancel-btn', () => {
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

    const closePromise = popup.show();
    closePromise.then(() => { popupClosed = true; });
    await closePromise;
}
