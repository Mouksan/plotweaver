// Plotweaver — фактический вызов ИИ и очистка ответа.
//
// Этот файл ничего не рисует и не сохраняет — только берёт готовый промт
// и настройки, отправляет их модели (через основной API чата или через
// выбранный профиль подключения) и возвращает уже очищенный текст.

function ctx() {
    return SillyTavern.getContext();
}

/** Генерация через то подключение, что сейчас активно в самом чате. */
async function generateViaMainApi(prompt, responseLength) {
    const context = ctx();
    const reply = await context.generateRaw({
        prompt,
        responseLength,
        trimNames: false,
    });
    return typeof reply === 'string' ? reply : (reply ?? '');
}

/** Генерация через сохранённый профиль подключения (Connection Manager). */
async function generateViaProfile(profileId, prompt, responseLength, signal) {
    const context = ctx();
    const service = context.ConnectionManagerRequestService;
    if (!service) throw new Error('Connection Manager недоступен в этой версии таверны.');

    const result = await service.sendRequest(profileId, prompt, responseLength, {
        stream: false,
        extractData: true,
        includePreset: true,
        signal,
    });
    const content = result?.content;
    return content && typeof content === 'object' ? JSON.stringify(content) : String(content || '');
}

/**
 * Убирает видимое "мышление" модели, если оно просочилось прямо в текст
 * ответа (актуально для моделей без отдельного канала рассуждений).
 * Второе правило подчищает и случай, когда виден только хвост мышления —
 * открывающий тег обрезан, а закрывающий остался.
 */
export function stripReasoning(text) {
    return String(text || '')
        .replace(/<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi, '')
        .replace(/^[\s\S]*?<\/(?:think|thinking|reasoning|thought)>/i, '')
        .trim();
}

/**
 * Модель видит в истории чата формат самого ролплея (например
 * <horae>/<horaeevent> метаданные или { ... } строку состояния сцены) и по
 * инерции иногда продолжает этим же форматом уже в плане, где это не нужно.
 * Промт просит этого не делать (см. CRAFT_GUIDE в prompt.js), а это —
 * подстраховка на случай, если модель всё равно проскользнёт.
 */
export function stripRoleplayArtifacts(text) {
    return String(text || '')
        .replace(/<horae>[\s\S]*?<\/horae>/gi, '')
        .replace(/<horaeevent>[\s\S]*?<\/horaeevent>/gi, '')
        .replace(/^\s*\{[^\n{}]*\}\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const REASONING_HEADROOM = 4096; // запас на "невидимое" мышление reasoning-моделей
const FORMAT_RESPONSE_LENGTH = {
    nudge: 600,
    arc: 1500,
    volume: 4000,
    saga: 8000,
};

/** Сколько токенов запрашивать на ответ — зависит от выбранного формата. */
export function computeResponseLength(answers) {
    const formatId = answers?.format?.ids?.[0] || 'arc';
    const base = FORMAT_RESPONSE_LENGTH[formatId] || FORMAT_RESPONSE_LENGTH.arc;
    return base + REASONING_HEADROOM;
}

/**
 * Запускает генерацию и возвращает уже очищенный от "мышления" текст.
 * params: { prompt, profileId, responseLength, signal }
 * Без profileId идёт через основной API чата.
 */
export async function runGeneration({ prompt, profileId, responseLength, signal }) {
    const rawReply = profileId
        ? await generateViaProfile(profileId, prompt, responseLength, signal)
        : await generateViaMainApi(prompt, responseLength);
    return stripRoleplayArtifacts(stripReasoning(rawReply));
}

/**
 * Останавливает генерацию через основной API чата (для профилей отмена
 * идёт через AbortController/signal, это отдельный путь только для
 * основного подключения).
 */
export function stopMainApiGeneration() {
    try {
        ctx().stopGeneration?.();
    } catch (error) {
        console.warn('[Plotweaver] не удалось остановить генерацию через основной API', error);
    }
}
