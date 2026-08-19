// Plotweaver — данные, привязанные к конкретному чату: черновик опросника,
// черновик Alter и страницы блокнота.
//
// Что выбрано в чипах, что написано в кастомных полях и заметках, какая
// модель и какие тумблеры контекста стоят, а также сами сохранённые сюжеты —
// всё это хранится в chatMetadata. Это штатное хранилище таверны, которое
// живёт прямо в файле чата, поэтому данные переживают закрытие окна и
// относятся именно к этому чату, а не ко всем сразу.

const DRAFT_KEY = 'plotweaver_draft';
const SAVE_DELAY = 600; // мс — не пишем файл чата на каждый отдельный клик

function ctx() {
    return SillyTavern.getContext();
}

/** @returns {object|null} живой chatMetadata текущего чата, или null, если чата нет. */
function chatMetadataStore() {
    const context = ctx();
    return context.chatMetadata && typeof context.chatMetadata === 'object' ? context.chatMetadata : null;
}

/** Черновик по умолчанию — когда в чате ещё ничего не сохранено. */
function emptyDraft() {
    return {
        answers: {},
        notes: '',
        generation: {
            profileId: '',
            useCard: true,
            usePersona: true,
            useLore: true,
            useHistory: true,
            historyCount: 20,
            loreNames: [],
        },
    };
}

/** Читает черновик опросника для текущего чата (с подстраховкой дефолтами). */
export function getDraft() {
    const store = chatMetadataStore();
    const saved = store?.[DRAFT_KEY];
    if (!saved || typeof saved !== 'object') return emptyDraft();

    const fallback = emptyDraft();
    return {
        ...fallback,
        ...saved,
        generation: { ...fallback.generation, ...(saved.generation || {}) },
    };
}

let saveTimer = null;

/** Сохраняет черновик с небольшой задержкой — burst кликов даёт одну запись. */
export function saveDraftDebounced(draft) {
    const store = chatMetadataStore();
    if (!store) return;
    store[DRAFT_KEY] = draft;

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            ctx().saveMetadata?.();
        } catch (error) {
            console.warn('[Plotweaver] не удалось сохранить черновик опросника', error);
        }
    }, SAVE_DELAY);
}

// ---------------------------------------------------------------------------
// Черновик Alter — отдельный ключ, чтобы не путаться с черновиком опросника
// ---------------------------------------------------------------------------

const ALTER_DRAFT_KEY = 'plotweaver_alter_draft';

function emptyAlterDraft() {
    return {
        gender: 'male',
        species: '',
        pheromoneIds: [],
        connection: '',
        notes: '',
        invention: 'balanced',
        profileId: '',
        loreNames: [],
    };
}

/** Читает черновик Alter для текущего чата (с подстраховкой дефолтами). */
export function getAlterDraft() {
    const store = chatMetadataStore();
    const saved = store?.[ALTER_DRAFT_KEY];
    if (!saved || typeof saved !== 'object') return emptyAlterDraft();
    return { ...emptyAlterDraft(), ...saved };
}

let alterSaveTimer = null;

/** Сохраняет черновик Alter с небольшой задержкой — тот же принцип, что у опросника. */
export function saveAlterDraftDebounced(draft) {
    const store = chatMetadataStore();
    if (!store) return;
    store[ALTER_DRAFT_KEY] = draft;

    clearTimeout(alterSaveTimer);
    alterSaveTimer = setTimeout(() => {
        alterSaveTimer = null;
        try {
            ctx().saveMetadata?.();
        } catch (error) {
            console.warn('[Plotweaver] не удалось сохранить черновик Alter', error);
        }
    }, SAVE_DELAY);
}

// ---------------------------------------------------------------------------
// Блокнот — страницы с сюжетами, привязанные к этому чату
// ---------------------------------------------------------------------------

const PAGES_KEY = 'plotweaver_pages';
const PAGE_SOFT_CAP = 30; // не жёсткий лимит — просто предупреждение в консоль

function emptyPagesStore() {
    return { pages: [], activePageId: null };
}

function persistPagesStore(pagesStore) {
    const store = chatMetadataStore();
    if (!store) return;
    store[PAGES_KEY] = pagesStore;
    try {
        ctx().saveMetadata?.();
    } catch (error) {
        console.warn('[Plotweaver] не удалось сохранить блокнот', error);
    }
}

function makePageId() {
    return `pw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Читает страницы блокнота для текущего чата (с подстраховкой дефолтами). */
export function getPagesStore() {
    const store = chatMetadataStore();
    const saved = store?.[PAGES_KEY];
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.pages)) return emptyPagesStore();
    return {
        pages: saved.pages,
        activePageId: saved.activePageId ?? (saved.pages[0]?.id || null),
    };
}

/**
 * Добавляет новую страницу и делает её активной.
 * payload: { title?, text?, answers?, notes? }
 */
export function addPage(payload = {}) {
    const pagesStore = getPagesStore();
    const page = {
        id: makePageId(),
        title: payload.title || `Черновик ${pagesStore.pages.length + 1}`,
        createdAt: Date.now(),
        text: payload.text || '',
        answers: payload.answers || {},
        notes: payload.notes || '',
        favorite: Boolean(payload.favorite),
        tags: Array.isArray(payload.tags) ? payload.tags : [],
        // 'plot' — страница из основного опросника Plotweaver, 'persona' —
        // из Alter. Старые страницы без этого поля считаются 'plot'
        // (см. pageKind() в ui.js).
        kind: payload.kind === 'persona' ? 'persona' : 'plot',
    };
    pagesStore.pages.push(page);
    pagesStore.activePageId = page.id;

    if (pagesStore.pages.length > PAGE_SOFT_CAP) {
        console.warn(`[Plotweaver] в блокноте этого чата уже больше ${PAGE_SOFT_CAP} страниц — стоит прибрать старые вручную.`);
    }

    persistPagesStore(pagesStore);
    return page;
}

/** Правит поля существующей страницы (например text/title после редактирования). */
export function updatePage(pageId, patch) {
    const pagesStore = getPagesStore();
    const page = pagesStore.pages.find((p) => p.id === pageId);
    if (!page) return null;
    Object.assign(page, patch);
    persistPagesStore(pagesStore);
    return page;
}

/** Удаляет страницу; если она была активной — активной становится первая из оставшихся. */
export function deletePage(pageId) {
    const pagesStore = getPagesStore();
    pagesStore.pages = pagesStore.pages.filter((p) => p.id !== pageId);
    if (pagesStore.activePageId === pageId) {
        pagesStore.activePageId = pagesStore.pages[0]?.id || null;
    }
    persistPagesStore(pagesStore);
    return pagesStore;
}

/** Просто переключает, какая страница считается активной (для вкладок). */
export function setActivePage(pageId) {
    const pagesStore = getPagesStore();
    pagesStore.activePageId = pageId;
    persistPagesStore(pagesStore);
}
