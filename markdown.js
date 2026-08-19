// Plotweaver — маленький собственный рендерер разметки для Sketchbook.
//
// Не полноценный CommonMark — ровно то, что нужно нам: заголовки, буллеты
// и декорации, которые ты применяешь через тулбар (жирный/курсив/подчёркнутый/
// зачёркнутый/хайлайт). Без внешних библиотек — текст сначала экранируется
// (безопасно даже если внутри окажутся <, > или что-то похожее на HTML), а
// уже потом мы сами вставляем ровно те теги, которые сами же и разрешили.
//
// Синтаксис:
//   **жирный**       -> <strong>
//   *курсив*         -> <em>
//   ++подчёркнутый++ -> <u>   (у маркдауна нет стандартного синтаксиса для
//                              подчёркивания, поэтому свой — плюсы визуально
//                              напоминают "добавление" черты снизу)
//   ~~зачёркнутый~~  -> <s>
//   ==текст==            -> хайлайт жёлтым (цвет по умолчанию)
//   ==pink:текст==       -> хайлайт конкретным цветом (yellow/pink/green/blue)
//   # / ## / ### в начале строки -> заголовки
//   - в начале строки -> пункт списка

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const HIGHLIGHT_COLORS = new Set(['yellow', 'pink', 'green', 'blue']);

export function renderMarkdown(rawText) {
    let html = escapeHtml(rawText || '');

    // Заголовки — построчно, от самых длинных решёток к самым коротким.
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Декорации.
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\+\+(.+?)\+\+/g, '<u>$1</u>');
    html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');
    html = html.replace(/==(?:([a-z]+):)?(.+?)==/g, (match, color, inner) => {
        const safeColor = HIGHLIGHT_COLORS.has(color) ? color : 'yellow';
        return `<mark class="pw-hl-${safeColor}">${inner}</mark>`;
    });
    // Курсив — после жирного/остальных, иначе одиночная звёздочка из "**"
    // расфасует их раньше времени.
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Буллеты — подряд идущие "- " строки группируем в один <ul>.
    html = html.replace(/(^|\n)((?:- .+(?:\n|$))+)/g, (match, prefix, block) => {
        const items = block
            .trim()
            .split('\n')
            .map((line) => `<li>${line.replace(/^- /, '')}</li>`)
            .join('');
        return `${prefix}<ul>${items}</ul>`;
    });

    // Оставшийся текст — абзацы по пустой строке, одиночный перенос — <br>.
    html = html
        .split(/\n{2,}/)
        .map((block) => {
            const trimmed = block.trim();
            if (!trimmed) return '';
            // Блоки, уже являющиеся заголовком/списком, не заворачиваем в <p>.
            if (/^<(h1|h2|h3|ul)/.test(trimmed)) return trimmed;
            return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
        })
        .join('\n');

    return html;
}
