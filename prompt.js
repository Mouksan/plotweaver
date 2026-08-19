// Plotweaver — сборщик контекста и промта.
//
// Этот файл ничего не отправляет ИИ и не открывает окон — только берёт
// (а) состояние текущего чата в таверне (карточка/персона/лорбук/история)
// и (б) ответы опросника, и склеивает из этого готовый текстовый промт.
// Настоящая отправка в модель появится на этапе "Генерация".
//
// Важно: весь служебный текст промта (заголовки блоков, инструкции модели,
// названия вопросов/вариантов) — на английском, это осознанное решение
// (модели обычно лучше следуют инструкциям на английском). Сам ролевой
// контент — карточка, история чата, кастомные ответы пользователя — остаётся
// как есть, на том языке, на котором был написан изначально. Сам план тоже
// явно просим писать на языке ролплея, а не на английском.

import { SECTIONS } from './catalog.js';

function ctx() {
    return SillyTavern.getContext();
}

/** Обрезает текст до примерной длины, стараясь не рвать слово на середине. */
function clip(text, maxLength) {
    const str = String(text || '').trim();
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength).replace(/\s+\S*$/, '') + '…';
}

/**
 * Убирает из сообщения чата всё, кроме самого нарратива:
 *  - <!-- [THREADS] ... --> — служебный комментарий с тредами;
 *  - HTML-карточки с картинками (внутри ещё и промт для генерации картинки —
 *    чистый мусор для планировщика сюжета);
 *  - [FAWN]...[/FAWN] — шуточные мета-комментарии/фейковые форумные реплики;
 *  - <horae>...</horae> и <horaeevent>...</horaeevent> — структурные блоки,
 *    по сути мини-пересказ того же нарратива, доп. информации не несут;
 *  - строку-инфоблок { ... } в начале сообщения (время/локация/поза/настрой).
 */
function stripDecorations(text) {
    return String(text || '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<div[^>]*>\s*<img[\s\S]*?<\/div>\s*/gi, '')
        .replace(/\[FAWN\][\s\S]*?\[\/FAWN\]/gi, '')
        .replace(/<horae>[\s\S]*?<\/horae>/gi, '')
        .replace(/<horaeevent>[\s\S]*?<\/horaeevent>/gi, '')
        .replace(/^\s*\{[^\n{}]*\}\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Читает лорбук(и) целиком через loadWorldInfo(name) — все записи подряд,
 * без активации по ключевым словам и без векторного поиска. Отключённые
 * записи (disable: true) пропускаем, остальные берём как есть.
 */
async function loadLoreEntries(context, names) {
    const blocks = [];
    for (const name of names) {
        if (!name) continue;
        try {
            const book = await context.loadWorldInfo?.(name);
            const entries = book?.entries && typeof book.entries === 'object' ? Object.values(book.entries) : [];
            for (const entry of entries) {
                if (entry?.disable) continue;
                const content = String(entry?.content || '').trim();
                if (!content) continue;
                const label = entry?.comment ? `${entry.comment}: ` : '';
                blocks.push(`${label}${content}`);
            }
        } catch (error) {
            console.warn(`[Plotweaver] не удалось прочитать лорбук "${name}"`, error);
        }
    }
    return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Контекст: карточка, персона, лорбук, история
// ---------------------------------------------------------------------------

/**
 * Собирает текстовые блоки контекста — только те, что включены галочками.
 * options: { useCard, usePersona, useLore, useHistory, historyCount }
 *
 * Это АСИНХРОННАЯ функция — потому что таверна отдаёт лорбук через
 * getWorldInfoPrompt(), а это Promise. Вызывать buildContext нужно с await.
 */
export async function buildContext(options) {
    const context = ctx();
    const blocks = [];

    // Карточка и персона — с большим запасом по длине: в отличие от Facets
    // (там короткое досье вкусов), нам для планирования сюжета нужна вся
    // карточка целиком — характер, бэкграунд, отношения, а не только начало.
    if (options.useCard || options.usePersona) {
        let fields = {};
        try {
            fields = context.getCharacterCardFields?.() || {};
        } catch (error) {
            console.warn('[Plotweaver] не удалось прочитать карточку персонажа', error);
        }
        if (options.useCard && fields.description) {
            blocks.push(`# CHARACTER CARD\n${clip(fields.description, 16000)}`);
        }
        if (options.usePersona && fields.persona) {
            blocks.push(`# USER PERSONA\n${clip(fields.persona, 8000)}`);
        }
    }

    // Лорбук — читаем файл(ы) целиком через loadWorldInfo(), в обход любой
    // активации (ни по ключевым словам, ни по векторам) — берём вообще все
    // записи выбранных книг. Это надёжнее, чем родной конвейер активации,
    // который заточен под "что сейчас релевантно", а не "дай всё".
    if (options.useLore && Array.isArray(options.loreNames) && options.loreNames.length) {
        const loreText = await loadLoreEntries(context, options.loreNames);
        if (loreText) {
            blocks.push(`# LOREBOOK\n${clip(loreText, 20000)}`);
        }
    }

    // История — ровно столько сообщений, сколько выбрано в "Сколько
    // сообщений", без скрытого урезания по бюджету символов. Пользователь
    // сам решает, сколько его модель потянет — не наше дело подрезать
    // втихую то, что явно выбрано слайдером.
    if (options.useHistory) {
        const chat = Array.isArray(context.chat) ? context.chat : [];
        const messages = chat
            .filter((msg) => !msg.is_system)
            .slice(-Math.max(0, options.historyCount || 0))
            .map((msg) => `${msg.name}: ${stripDecorations(msg.mes)}`)
            .join('\n\n');
        if (messages) {
            blocks.push(`# RECENT CHAT MESSAGES\n${messages}`);
        }
    }

    return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Бриф: ответы опросника в читаемый текст (на английском)
// ---------------------------------------------------------------------------

/**
 * Достаёт текст ответа на конкретный вопрос: английские labelEn выбранных
 * пресет-чипов + значения активных кастомных чипов (как есть, не переводим —
 * это собственные слова автора).
 */
function answerText(question, answer) {
    if (!answer) return '';

    const optionLabels = (answer.ids || [])
        .map((oid) => question.options?.find((opt) => opt.id === oid)?.labelEn)
        .filter(Boolean);

    const customLabels = (answer.customValues || [])
        .filter((entry) => entry.active)
        .map((entry) => entry.value);

    return [...optionLabels, ...customLabels].join(', ');
}

/**
 * Превращает ответы опросника в читаемый бриф по группам, на английском.
 * Секцию "Настройки генерации" сюда не включаем — она превращается
 * в отдельные явные инструкции ниже (buildPrompt), а не в бриф.
 */
export function buildBrief(answers) {
    const lines = [];
    for (const section of SECTIONS) {
        if (section.id === 'generation') continue;

        const sectionLines = [];
        for (const question of section.questions) {
            const text = answerText(question, answers[question.id]);
            if (text) sectionLines.push(`- ${question.labelEn}: ${text}`);
        }
        if (sectionLines.length) {
            lines.push(`## ${section.titleEn}\n${sectionLines.join('\n')}`);
        }
    }
    return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Итоговый промт
// ---------------------------------------------------------------------------

const INVENTION_INSTRUCTIONS = {
    canon: 'Stick strictly to what is already established in the character card, persona, lorebook, and chat history. Do not invent new facts about the world or the characters.',
    balanced: 'Rely on the card/lorebook/history wherever they say something; where they are silent, feel free to invent logical, fitting details.',
    free: 'The card/lorebook/history are binding wherever they establish something, but where material is missing, invent generously and boldly.',
};

const FORMAT_INSTRUCTIONS = {
    nudge: 'Do not write arcs, volumes, or scenes. Instead, give exactly 3 '
        + 'independent possible directions the story could take from this point '
        + 'forward. Hard limit: 3 sentences per option — a specific, concrete '
        + 'direction, not a vague theme.\n\n'
        + 'Template shape to follow (write your own content, do not copy this wording):\n'
        + 'Option 1: [up to 3 sentences — a specific, concrete direction]\n'
        + 'Option 2: [up to 3 sentences — a different concrete direction]\n'
        + 'Option 3: [up to 3 sentences — a third concrete direction]',

    arc: 'Give exactly 1 arc: a title, a one-line focus, and 3 scenes. Hard '
        + 'limit: each scene is 2-3 sentences MAXIMUM — concrete: who does what, '
        + 'what changes. Do not go over this length.\n\n'
        + 'Template shape to follow (write your own content, do not copy this wording):\n'
        + '## [Arc title]\n'
        + 'Focus: [one line — the throughline of this arc]\n'
        + '- Scene 1. [2-3 sentences]\n'
        + '- Scene 2. [2-3 sentences]\n'
        + '- Scene 3. [2-3 sentences]',

    volume: 'Give exactly 1 volume containing 3 arcs. Each arc: a title, a '
        + 'one-line focus, and 3 scenes. Hard limit: each scene is 2-3 sentences '
        + 'MAXIMUM. Do not go over this length.\n\n'
        + 'Template shape to follow (write your own content, do not copy this wording):\n'
        + '# [Volume title]\n'
        + '## Arc 1: [title]\n'
        + 'Focus: [one line]\n'
        + '- Scene 1. [2-3 sentences]\n'
        + '- Scene 2. [2-3 sentences]\n'
        + '- Scene 3. [2-3 sentences]\n'
        + '## Arc 2: [title] — same shape as Arc 1\n'
        + '## Arc 3: [title] — same shape as Arc 1',

    saga: 'Give a multi-volume saga: around 5 volumes — a soft target, not a '
        + 'literal count to hit exactly, but do not significantly exceed it. Each '
        + 'volume contains about 3 arcs. Each arc: a title, a one-line focus, and '
        + '2 scenes. Hard limit: each scene is 3 sentences MAXIMUM. Do not go over '
        + 'this length, even at this scale.\n\n'
        + 'This scope limit is independent of the ending type requested above. An '
        + '"open ending" means the relationship/conflict does not have to fully '
        + 'resolve — it does NOT mean the plan may keep expanding indefinitely. '
        + 'Bring the saga to a stopping point within roughly 5 volumes even if the '
        + 'ending is meant to feel open; do not let the volume count balloon in an '
        + 'attempt to "properly" resolve everything.\n\n'
        + 'Template shape for each volume (write your own content, do not copy this '
        + 'wording; repeat this shape roughly 5 times total):\n'
        + '# [Volume title]\n'
        + '## Arc 1: [title]\n'
        + 'Focus: [one line]\n'
        + '- Scene 1. [max 3 sentences]\n'
        + '- Scene 2. [max 3 sentences]\n'
        + '## Arc 2: [title] — same shape as Arc 1\n'
        + '## Arc 3: [title] — same shape as Arc 1',
};

function formatInstruction(answers) {
    const formatId = answers.format?.ids?.[0] || 'arc';
    return FORMAT_INSTRUCTIONS[formatId] || FORMAT_INSTRUCTIONS.arc;
}

const PLANNING_REGISTER = [
    'THIS IS A PLANNING DOCUMENT, NOT PROSE.',
    'You are writing an outline for the author to work from later — not a '
        + 'narrative scene, not fanfiction, not a finished piece of writing. Every '
        + 'beat/scene must be a plain, functional statement of what happens: the '
        + 'action, the decision, the turn, the reveal — nothing else.',
    'Do not write: atmospheric or sensory description, quoted dialogue, internal '
        + 'monologue, scene-setting for its own sake, or literary phrasing ("she '
        + 'fell silent — for now"). If a sentence could be cut without losing plot '
        + 'information, cut it.',
    'Think "writer\'s room outline", not "finished chapter". Density over atmosphere.',
].join('\n');

const CRAFT_GUIDE = [
    'HOW TO WRITE IT',
    '- Be concrete. Name what actually happens in each beat/scene — a specific '
        + 'action, a specific line of conflict, a specific turn — not a vague '
        + 'summary like "they grow closer" or "tension rises".',
    '- Follow the requested output format exactly (see OUTPUT FORMAT below) — '
        + 'the same structure and template shape every single time.',
    '- Do not restate the brief back to the author. They already know what '
        + 'they asked for — go straight to the plan itself, no preamble summarizing the inputs.',
    '- Stay consistent with what the character card, lorebook, and chat '
        + 'history already establish — carry forward names, relationships, '
        + 'unresolved threads, and the emotional state the characters are '
        + 'currently in. Do not contradict or quietly reset anything already established.',
    '- Give conflict real teeth: obstacles should have consequences, not just '
        + 'be mentioned and resolved in the same beat.',
    '- Do not pad the plan with a wrap-up paragraph, a summary, or commentary '
        + 'after the last beat. End on the last beat of the plan.',
    '- Do not use the roleplay\'s in-chat formatting or metadata tags (things '
        + 'like <horae> blocks, <horaeevent> blocks, or a leading {time | location | '
        + '...} scene-state line) anywhere in the plan, even though the chat history '
        + 'above uses that format.',
    '- This still applies after reading all the roleplay prose above: stay in '
        + 'plan mode for the entire response, from the first line to the last. '
        + 'Do not let the narrative voice of the chat history above bleed into how '
        + 'you write the plan — no quoted dialogue, no scene-setting, no internal '
        + 'monologue, at any point, no matter how long the plan gets.',
].join('\n');

const LANGUAGE_INSTRUCTIONS = {
    ru: 'These instructions are in English, but write the plan itself in Russian, '
        + 'regardless of what language the roleplay itself is in.',
    en: 'Write the plan itself in English, regardless of what language the '
        + 'roleplay itself is in.',
};

/**
 * Собирает финальный текст промта.
 * params: { contextText, answers, notes }
 */
export function buildPrompt({ contextText, answers, notes }) {
    const parts = [];

    parts.push(
        'You are a co-writer helping plan the development of a roleplay chat. '
        + 'Output ONLY the finished plan — no reasoning, no drafts, no self-directed '
        + 'questions, and no preamble like "Sure, here is the plan".',
    );

    const languageId = answers.output_language?.ids?.[0] || 'ru';
    parts.push(LANGUAGE_INSTRUCTIONS[languageId] || LANGUAGE_INSTRUCTIONS.ru);

    parts.push(PLANNING_REGISTER);

    if (contextText) {
        parts.push(contextText);
    }

    const brief = buildBrief(answers);
    if (brief) {
        parts.push(
            "# AUTHOR'S CREATIVE BRIEF (MANDATORY)\n"
            + 'Everything below is a hard requirement chosen by the author, not a '
            + 'loose suggestion. Incorporate every one of these points into the plan '
            + 'exactly as stated — do not soften, skip, or reinterpret any of them.\n\n'
            + brief,
        );
    }

    if (notes && notes.trim()) {
        parts.push(`# FREE-FORM NOTES AND WISHES (MANDATORY)\n${notes.trim()}`);
    }

    parts.push(CRAFT_GUIDE);

    const inventionId = answers.invention?.ids?.[0] || 'balanced';
    parts.push(`# HOW MUCH TO INVENT\n${INVENTION_INSTRUCTIONS[inventionId] || INVENTION_INSTRUCTIONS.balanced}`);
    parts.push(`# OUTPUT FORMAT (MANDATORY)\n${formatInstruction(answers)}`);

    // Самое последнее, что видит модель перед тем, как начать писать —
    // сюда специально продублирован ключевой запрет на прозу, потому что
    // после десятков тысяч символов ролевой прозы в истории чата абстрактное
    // правило в начале промта теряет влияние сильнее, чем то, что стоит
    // прямо перед стартом генерации.
    parts.push(
        'FINAL REMINDER: this is a plan, not a scene. No quoted dialogue, no '
        + 'atmosphere, no internal monologue — plain statements of what happens, '
        + 'within the sentence limits above. Do not drift into the roleplay\'s '
        + 'prose style, no matter how long this document gets.',
    );

    return parts.join('\n\n');
}
