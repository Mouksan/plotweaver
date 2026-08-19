// Plotweaver — точка входа расширения.
//
// Три точки входа в панели настроек расширений (плюс дублирующие пункты
// в волшебной палочке):
//   - "Открыть Plotweaver" -> опросник-конструктор промта
//   - "Открыть Sketchbook" -> блокнот со страницами-сюжетами и персонами
//   - "Открыть Alter"      -> генератор стартовых точек для новых персонажей

import { openNotebook, openQuestionnaire } from './ui.js';
import { openAlter } from './alter.js';

const EXTENSION_NAME = 'Plotweaver';

/**
 * Добавляет в панель настроек расширений блок с тремя кнопками-модулями.
 */
function mountSettingsEntry() {
    const settingsHtml = `
        <div class="plotweaver-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b><i class="fa-solid fa-feather-pointed"></i> Plotweaver</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <button id="plotweaver_open_btn" class="menu_button pw-panel-btn">
                        <i class="fa-solid fa-feather-pointed"></i>
                        <span>Открыть Plotweaver</span>
                    </button>
                    <button id="plotweaver_notebook_btn" class="menu_button pw-panel-btn">
                        <i class="fa-solid fa-book"></i>
                        <span>Открыть Sketchbook</span>
                    </button>
                    <button id="plotweaver_alter_btn" class="menu_button pw-panel-btn">
                        <i class="fa-solid fa-user-pen"></i>
                        <span>Открыть Alter</span>
                    </button>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(settingsHtml);
    $('#plotweaver_open_btn').on('click', openQuestionnaire);
    $('#plotweaver_notebook_btn').on('click', openNotebook);
    $('#plotweaver_alter_btn').on('click', openAlter);
}

/**
 * Добавляет в меню волшебной палочки пункты Plotweaver, Sketchbook и Alter.
 */
function mountWandMenuEntry() {
    const menuItemsHtml = `
        <div id="plotweaver_wand_item" class="list-group-item flex-container flexGap5" title="Открыть Plotweaver">
            <div class="fa-solid fa-feather-pointed extensionsMenuExtensionButton"></div>
            <span>Plotweaver</span>
        </div>
        <div id="plotweaver_notebook_wand_item" class="list-group-item flex-container flexGap5" title="Открыть Sketchbook">
            <div class="fa-solid fa-book extensionsMenuExtensionButton"></div>
            <span>Sketchbook</span>
        </div>
        <div id="plotweaver_alter_wand_item" class="list-group-item flex-container flexGap5" title="Открыть Alter">
            <div class="fa-solid fa-user-pen extensionsMenuExtensionButton"></div>
            <span>Alter</span>
        </div>
    `;

    $('#extensionsMenu').append(menuItemsHtml);
    $('#plotweaver_wand_item').on('click', openQuestionnaire);
    $('#plotweaver_notebook_wand_item').on('click', openNotebook);
    $('#plotweaver_alter_wand_item').on('click', openAlter);
}

jQuery(async () => {
    mountSettingsEntry();
    mountWandMenuEntry();
    console.log(`[${EXTENSION_NAME}] расширение загружено`);
});
