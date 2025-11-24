// メイン画面のJavaScript

let currentConfig = null;
let allApps = [];
let selectedBackupId = null;
let availableRecords = [];
let currentVirtualScroller = null;

// ========== ユーティリティ関数 ==========

// HTML エスケープ
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ファイルサイズフォーマット
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ========== フィールド表示ロジック ==========

/**
 * フィールド型に応じた表示用 HTML を生成
 */
function getFieldDisplayValue(field, fieldType, fieldProperty = null) {
    const value = field.value;

    if (value === null || value === undefined || value === '') {
        return '-';
    }

    switch (fieldType) {
        // 単純な文字列・数値型
        case 'SINGLE_LINE_TEXT':
        case 'NUMBER':
        case 'CALC':
        case 'RADIO_BUTTON':
        case 'DROP_DOWN':
        case 'DATE':
        case 'TIME':
        case 'RECORD_NUMBER':
            return escapeHtml(String(value));

        // 複数行テキスト
        case 'MULTI_LINE_TEXT':
            return escapeHtml(String(value)).replace(/\n/g, '<br>');

        // リッチテキスト（HTML エスケープ）
        case 'RICH_TEXT':
            return `<div style="max-height: 100px; overflow-y: auto; font-size: 0.85em; background: #f9f9f9; padding: 4px; border-radius: 3px;">${escapeHtml(String(value))}</div>`;

        // 日時型（ローカル時刻に変換）
        case 'DATETIME':
        case 'CREATED_TIME':
        case 'UPDATED_TIME':
            return formatDateTime(value);

        // リンク
        case 'LINK':
            return `<a href="${escapeHtml(value)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a>`;

        // チェックボックス、複数選択
        case 'CHECK_BOX':
        case 'MULTI_SELECT':
            if (!Array.isArray(value) || value.length === 0) return '-';
            return value.map((v) => escapeHtml(String(v))).join('<br>');

        // ユーザー選択、組織選択、グループ選択
        case 'USER_SELECT':
        case 'ORGANIZATION_SELECT':
        case 'GROUP_SELECT':
            if (!Array.isArray(value) || value.length === 0) return '-';
            return value.map((item) => escapeHtml(item.name || item.code || '')).join('<br>');

        // 作成者、更新者
        case 'CREATOR':
        case 'MODIFIER':
            if (typeof value === 'object' && value.name) {
                return escapeHtml(value.name);
            }
            return '-';

        // 添付ファイル
        case 'FILE':
            if (!Array.isArray(value) || value.length === 0) return '-';
            return value
                .map((file) => {
                    const size = file.size ? ` (${formatFileSize(file.size)})` : '';
                    return escapeHtml(file.name) + size;
                })
                .join('<br>');

        // サブテーブル
        case 'SUBTABLE':
            if (!Array.isArray(value) || value.length === 0) return '-';
            return renderSubtable(value, fieldProperty?.fields || {});

        // その他
        default:
            try {
                return `<pre style="font-size: 0.85em; max-height: 100px; overflow: auto;">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
            } catch (e) {
                return escapeHtml(String(value));
            }
    }
}

/**
 * サブテーブルの HTML を生成
 */
function renderSubtable(subtableValue, subtableFields) {
    if (!Array.isArray(subtableValue) || subtableValue.length === 0) {
        return '-';
    }

    const firstRow = subtableValue[0];
    const fieldCodes = Object.keys(firstRow.value || {});

    if (fieldCodes.length === 0) {
        return '-';
    }

    let html =
        '<table class="subtable" style="width: 100%; border-collapse: collapse; font-size: 0.9em; background: #f9f9f9; margin: 4px 0; max-height: 300px; overflow-y: auto; display: block;">';

    // ヘッダー
    html += '<thead style="position: sticky; top: 0; background: #e9ecef; z-index: 1;"><tr>';
    fieldCodes.forEach((code) => {
        const label = subtableFields[code]?.label || code;
        html += `<th style="padding: 6px 8px; border: 1px solid #ddd; text-align: left; font-weight: 600; font-size: 0.85em; color: #495057; white-space: nowrap;" title="${escapeHtml(
            code
        )}">${escapeHtml(label)}</th>`;
    });
    html += '</tr></thead>';

    // ボディ
    html += '<tbody>';
    subtableValue.forEach((row) => {
        html += '<tr>';
        fieldCodes.forEach((code) => {
            const field = row.value[code];
            html += '<td style="padding: 6px 8px; border: 1px solid #ddd; background: white;">';
            if (field) {
                html += getFieldDisplayValue(field, field.type, subtableFields[code]);
            } else {
                html += '-';
            }
            html += '</td>';
        });
        html += '</tr>';
    });
    html += '</tbody>';

    html += '</table>';
    return html;
}

// ========== 軽量仮想スクロール実装 ==========

class SimpleVirtualScroller {
    constructor(container, records, fieldCodes, fieldProperties, options = {}) {
        this.container = container;
        this.records = records;
        this.fieldCodes = fieldCodes;
        this.fieldProperties = fieldProperties;
        this.showCheckbox = options.showCheckbox !== false;
        this.selectedRecordIds = new Set();

        this.rowHeight = 100; // 固定値
        this.bufferRows = 200;
        this.visibleStart = 0;
        this.visibleEnd = 0;

        this.scrollContainer = null;
        this.tableBody = null;

        this.render();
        this.attachScrollListener();
    }

    render() {
        this.container.innerHTML = '';

        // スクロールコンテナ
        this.scrollContainer = document.createElement('div');
        this.scrollContainer.className = 'virtual-scroll-container';
        this.scrollContainer.style.cssText = 'height: 500px; overflow: auto; position: relative; border: 1px solid #e0e0e0; border-radius: 6px; background: white;';

        // テーブル
        const table = document.createElement('table');
        table.className = 'records-table';
        table.style.cssText = 'width: 100%; border-collapse: collapse; table-layout: auto; font-size: 14px;';

        // ヘッダー
        const thead = document.createElement('thead');
        thead.style.cssText = 'position: sticky; top: 0; z-index: 20; background: #f8f9fa;';
        const headerRow = document.createElement('tr');

        if (this.showCheckbox) {
            const th = document.createElement('th');
            th.style.cssText =
                'padding: 10px 12px; text-align: left; border: 1px solid #e0e0e0; position: sticky; left: 0; z-index: 30; background: #f8f9fa; width: 50px; box-shadow: 2px 0 4px rgba(0,0,0,0.1); white-space: nowrap;';
            th.innerHTML = '<input type="checkbox" id="selectAllRecordsTable" />';
            headerRow.appendChild(th);

            // 全選択イベント
            setTimeout(() => {
                const selectAllCheckbox = document.getElementById('selectAllRecordsTable');
                if (selectAllCheckbox) {
                    selectAllCheckbox.addEventListener('change', (e) => {
                        if (e.target.checked) {
                            this.records.forEach((record, index) => {
                                const recordId = record.$id?.value || index;
                                this.selectedRecordIds.add(String(recordId));
                            });
                        } else {
                            this.selectedRecordIds.clear();
                        }
                        this.updateVisibleRows();
                    });
                }
            }, 0);
        }

        this.fieldCodes.forEach((fieldCode) => {
            const th = document.createElement('th');
            const label = this.fieldProperties[fieldCode]?.label || fieldCode;
            th.textContent = label;
            th.title = `${label} (${fieldCode})`;
            th.style.cssText =
                'padding: 10px 12px; text-align: left; border: 1px solid #e0e0e0; font-weight: 600; color: #555; min-width: 150px; white-space: nowrap; border-bottom: 2px solid #667eea; box-shadow: 0 2px 4px rgba(0,0,0,0.1);';
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // ボディ
        this.tableBody = document.createElement('tbody');
        table.appendChild(this.tableBody);

        this.scrollContainer.appendChild(table);
        this.container.appendChild(this.scrollContainer);

        this.updateVisibleRows();
    }

    attachScrollListener() {
        this.scrollContainer.addEventListener('scroll', () => {
            this.updateVisibleRows();
        });
    }

    updateVisibleRows() {
        const scrollTop = this.scrollContainer.scrollTop;
        const containerHeight = this.scrollContainer.clientHeight;

        const startIndex = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.bufferRows);
        const endIndex = Math.min(this.records.length, Math.ceil((scrollTop + containerHeight) / this.rowHeight) + this.bufferRows);

        if (startIndex === this.visibleStart && endIndex === this.visibleEnd) {
            // チェックボックス状態のみ更新
            this.updateCheckboxStates();
            return;
        }

        this.visibleStart = startIndex;
        this.visibleEnd = endIndex;

        // 上部パディング
        const topPadding = startIndex * this.rowHeight;
        // 下部パディング
        const bottomPadding = (this.records.length - endIndex) * this.rowHeight;

        this.tableBody.innerHTML = '';

        // 上部スペーサー
        if (topPadding > 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = this.fieldCodes.length + (this.showCheckbox ? 1 : 0);
            td.style.cssText = `height: ${topPadding}px; padding: 0; border: none;`;
            tr.appendChild(td);
            this.tableBody.appendChild(tr);
        }

        // 可視行
        for (let i = startIndex; i < endIndex; i++) {
            const record = this.records[i];
            const recordId = record.$id?.value || i;
            const tr = document.createElement('tr');
            tr.style.cssText = 'height: ' + this.rowHeight + 'px;';
            tr.addEventListener('mouseenter', () => {
                tr.style.background = '#f0f4ff';
            });
            tr.addEventListener('mouseleave', () => {
                tr.style.background = '';
            });

            if (this.showCheckbox) {
                const td = document.createElement('td');
                td.style.cssText =
                    'padding: 10px 12px; text-align: left; border: 1px solid #e0e0e0; vertical-align: top; position: sticky; left: 0; z-index: 10; background: white; box-shadow: 2px 0 4px rgba(0,0,0,0.1);';
                const checked = this.selectedRecordIds.has(String(recordId)) ? 'checked' : '';
                td.innerHTML = `<input type="checkbox" class="record-checkbox" data-record-id="${recordId}" ${checked} />`;
                tr.appendChild(td);

                // チェックボックスイベント
                const checkbox = td.querySelector('.record-checkbox');
                checkbox.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        this.selectedRecordIds.add(String(recordId));
                    } else {
                        this.selectedRecordIds.delete(String(recordId));
                    }
                });
            }

            this.fieldCodes.forEach((fieldCode) => {
                const td = document.createElement('td');
                td.style.cssText = 'padding: 10px 12px; text-align: left; border: 1px solid #e0e0e0; vertical-align: top; max-width: 400px; overflow: hidden;';
                const field = record[fieldCode];

                if (!field) {
                    td.textContent = '-';
                } else {
                    const fieldType = field.type;
                    const displayHtml = getFieldDisplayValue(field, fieldType, this.fieldProperties[fieldCode]);
                    td.innerHTML = displayHtml;
                }

                tr.appendChild(td);
            });

            this.tableBody.appendChild(tr);
        }

        // 下部スペーサー
        if (bottomPadding > 0) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = this.fieldCodes.length + (this.showCheckbox ? 1 : 0);
            td.style.cssText = `height: ${bottomPadding}px; padding: 0; border: none;`;
            tr.appendChild(td);
            this.tableBody.appendChild(tr);
        }
    }

    updateCheckboxStates() {
        const checkboxes = this.tableBody.querySelectorAll('.record-checkbox');
        checkboxes.forEach((cb) => {
            const recordId = cb.dataset.recordId;
            cb.checked = this.selectedRecordIds.has(String(recordId));
        });
    }

    getSelectedRecordIds() {
        return Array.from(this.selectedRecordIds);
    }
}

// ========== レコードテーブル描画関数 ==========

async function renderRecordsTable(records, containerElement, appId, options = {}) {
    const { showCheckbox = true } = options;

    if (records.length === 0) {
        containerElement.innerHTML = '<p>レコードがありません</p>';
        return null;
    }

    // フィールド情報の取得
    let fieldProperties = {};
    try {
        fieldProperties = await window.electronAPI.getAppFields(appId);
    } catch (error) {
        console.error('Failed to get field properties:', error);
    }

    // フィールドコードリストを抽出（システムフィールドを先頭に）
    const firstRecord = records[0];
    const allFieldCodes = Object.keys(firstRecord);
    const systemFields = ['$id', '$revision'];
    const otherFields = allFieldCodes.filter((code) => !systemFields.includes(code));
    const orderedFieldCodes = [...systemFields, ...otherFields];

    // 仮想スクロールテーブルを作成
    const scroller = new SimpleVirtualScroller(containerElement, records, orderedFieldCodes, fieldProperties, {
        showCheckbox,
    });

    return scroller;
}

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // 設定の読み込み
        currentConfig = await window.electronAPI.getConfig();

        if (!currentConfig || !currentConfig.kintone || !currentConfig.apps) {
            // セットアップが必要
            alert('初回セットアップが必要です');
            // セットアップ画面を開く処理（今回は未実装）
            return;
        }

        // 初期データの読み込み
        await loadInitialData();
        setupEventListeners();
    } catch (error) {
        console.error('Initialization error:', error);
        alert('初期化エラー: ' + error.message);
    }
});

// 初期データの読み込み
async function loadInitialData() {
    await loadStatistics();
    await loadAppsForBackup();
    await loadBackupHistory();
}

// イベントリスナーの設定
function setupEventListeners() {
    // タブ切り替え
    document.querySelectorAll('.nav-tab').forEach((tab) => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // バックアップ実行
    document.getElementById('runBackupBtn').addEventListener('click', runManualBackup);

    // 復元関連
    document.getElementById('restoreAppSelect').addEventListener('change', loadBackupsForApp);
    document.getElementById('selectAllRecords').addEventListener('change', toggleSelectAllRecords);
    document.getElementById('executeRestoreBtn').addEventListener('click', executeRestore);

    // 設定ボタン
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
}

// タブ切り替え
function switchTab(tabName) {
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));

    document.querySelector(`.nav-tab[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`${tabName}Tab`).classList.add('active');

    // 復元タブに切り替えたときにアプリ一覧を読み込む
    if (tabName === 'restore') {
        loadAppsForRestore();
    }
}

// 統計情報の読み込み
async function loadStatistics() {
    try {
        const history = await window.electronAPI.getBackupHistory({ limit: 1000 });
        const apps = currentConfig.apps || [];

        document.getElementById('totalApps').textContent = apps.length;
        document.getElementById('totalBackups').textContent = history.length;

        if (history.length > 0) {
            const lastBackup = history[0];
            const date = new Date(lastBackup.start_time);
            document.getElementById('lastBackupTime').textContent = formatDate(date);

            const totalRecords = history.reduce((sum, h) => sum + (h.record_count || 0), 0);
            document.getElementById('totalRecords').textContent = totalRecords.toLocaleString();
        }
    } catch (error) {
        console.error('Failed to load statistics:', error);
    }
}

// バックアップ用アプリリストの読み込み
async function loadAppsForBackup() {
    const container = document.getElementById('backupAppsList');
    container.innerHTML = '';

    const apps = currentConfig.apps || [];

    apps.forEach((app) => {
        const div = document.createElement('div');
        div.className = 'app-item';
        div.innerHTML = `
            <label class="checkbox-label">
                <input type="checkbox" class="backup-app-checkbox" data-app-id="${app.appId}" checked>
                <span class="app-name">${app.appName}</span>
                <span class="app-id">ID: ${app.appId}</span>
            </label>
        `;
        container.appendChild(div);
    });
}

// 手動バックアップの実行
async function runManualBackup() {
    const backupType = document.querySelector('input[name="backupType"]:checked').value;
    const selectedCheckboxes = document.querySelectorAll('.backup-app-checkbox:checked');

    if (selectedCheckboxes.length === 0) {
        alert('少なくとも1つのアプリを選択してください');
        return;
    }

    const selectedApps = Array.from(selectedCheckboxes).map((cb) => ({
        appId: cb.dataset.appId,
    }));

    const progressDiv = document.getElementById('backupProgress');
    const progressFill = document.getElementById('backupProgressFill');
    const progressText = document.getElementById('backupProgressText');

    progressDiv.style.display = 'block';
    document.getElementById('runBackupBtn').disabled = true;

    let completedCount = 0;
    const totalCount = selectedApps.length;
    const results = [];

    for (const app of selectedApps) {
        const appInfo = currentConfig.apps.find((a) => a.appId === app.appId);
        progressText.textContent = `バックアップ中: ${appInfo.appName} (${completedCount + 1}/${totalCount})`;

        try {
            const paths = await window.electronAPI.getAppPaths();
            const result = await window.electronAPI.runBackup({
                appId: app.appId,
                backupType,
                triggerType: '手動',
                hostname: paths.hostname,
                appVersion: paths.appVersion,
            });

            results.push({ ...result, success: true });
            completedCount++;
        } catch (error) {
            console.error(`Backup failed for app ${app.appId}:`, error);
            results.push({ appId: app.appId, success: false, error: error.message });
            completedCount++;
        }

        const progress = (completedCount / totalCount) * 100;
        progressFill.style.width = progress + '%';
    }

    // 完了
    progressText.textContent = 'バックアップ完了!';
    document.getElementById('runBackupBtn').disabled = false;

    // 結果表示
    const successCount = results.filter((r) => r.success).length;
    const failureCount = results.filter((r) => !r.success).length;

    alert(`バックアップが完了しました\n成功: ${successCount}件\n失敗: ${failureCount}件`);

    // 統計情報と履歴を再読み込み
    await loadStatistics();
    await loadBackupHistory();

    setTimeout(() => {
        progressDiv.style.display = 'none';
        progressFill.style.width = '0%';
    }, 2000);
}

// 復元用アプリリストの読み込み
async function loadAppsForRestore() {
    const select = document.getElementById('restoreAppSelect');
    select.innerHTML = '<option value="">選択してください</option>';

    const apps = currentConfig.apps || [];

    apps.forEach((app) => {
        const option = document.createElement('option');
        option.value = app.appId;
        option.textContent = `${app.appName} (ID: ${app.appId})`;
        select.appendChild(option);
    });
}

// アプリのバックアップ一覧を読み込む
async function loadBackupsForApp() {
    const appId = document.getElementById('restoreAppSelect').value;
    const backupsListDiv = document.getElementById('restoreBackupsList');
    const recordsListDiv = document.getElementById('restoreRecordsList');

    recordsListDiv.style.display = 'none';

    if (!appId) {
        backupsListDiv.style.display = 'none';
        return;
    }

    try {
        const backups = await window.electronAPI.getBackupHistory({
            app_id: appId,
            status: '成功',
            limit: 50,
        });

        const container = document.getElementById('backupsListContainer');
        container.innerHTML = '';

        if (backups.length === 0) {
            container.innerHTML = '<p>バックアップが見つかりません</p>';
        } else {
            backups.forEach((backup) => {
                const div = document.createElement('div');
                div.className = 'app-item';
                div.style.cursor = 'pointer';
                div.innerHTML = `
                    <div>
                        <strong>${formatDateTime(backup.start_time)}</strong>
                        <span class="badge badge-${backup.backup_type === '全体' ? 'success' : 'warning'}">${backup.backup_type}</span>
                        <span style="margin-left: 10px; color: #666;">${backup.record_count}件</span>
                    </div>
                `;
                div.addEventListener('click', () => loadRecordsFromBackup(backup.id));
                container.appendChild(div);
            });
        }

        backupsListDiv.style.display = 'block';
    } catch (error) {
        console.error('Failed to load backups:', error);
        alert('バックアップ一覧の取得に失敗しました');
    }
}

// バックアップからレコード一覧を読み込む
async function loadRecordsFromBackup(backupId) {
    selectedBackupId = backupId;

    try {
        const records = await window.electronAPI.getBackupDetails(backupId);
        availableRecords = records;

        // バックアップ情報からアプリ ID を取得
        const history = await window.electronAPI.getBackupHistory({ limit: 1000 });
        const currentBackup = history.find((b) => b.id === backupId);
        const appId = currentBackup?.app_id;

        const container = document.getElementById('recordsListContainer');

        // 仮想スクロールテーブル形式で描画
        currentVirtualScroller = await renderRecordsTable(records, container, appId, {
            showCheckbox: true,
        });

        document.getElementById('restoreRecordsList').style.display = 'block';
    } catch (error) {
        console.error('Failed to load records:', error);
        alert('レコード一覧の取得に失敗しました');
    }
}

// すべてのレコードを選択/解除
function toggleSelectAllRecords(e) {
    const checkboxes = document.querySelectorAll('.record-checkbox');
    checkboxes.forEach((cb) => {
        cb.checked = e.target.checked;
    });
}

// 復元実行
async function executeRestore() {
    if (!currentVirtualScroller) {
        alert('レコードが読み込まれていません');
        return;
    }

    const selectedRecordIds = currentVirtualScroller.getSelectedRecordIds();

    if (selectedRecordIds.length === 0) {
        alert('少なくとも1つのレコードを選択してください');
        return;
    }

    const confirm = await window.electronAPI.showDialog({
        type: 'warning',
        buttons: ['キャンセル', '復元実行'],
        defaultId: 0,
        title: '復元の確認',
        message: `${selectedRecordIds.length}件のレコードを復元します。よろしいですか?`,
    });

    if (confirm.response !== 1) {
        return;
    }

    try {
        document.getElementById('executeRestoreBtn').disabled = true;
        document.getElementById('executeRestoreBtn').textContent = '復元中...';

        const paths = await window.electronAPI.getAppPaths();
        await window.electronAPI.restoreRecords({
            backupId: selectedBackupId,
            selectedRecordIds,
            hostname: paths.hostname,
            appVersion: paths.appVersion,
        });

        alert('復元が完了しました');

        // 履歴を再読み込み
        await loadBackupHistory();

        // リセット
        document.getElementById('restoreAppSelect').value = '';
        document.getElementById('restoreBackupsList').style.display = 'none';
        document.getElementById('restoreRecordsList').style.display = 'none';
        currentVirtualScroller = null;
    } catch (error) {
        console.error('Restore failed:', error);
        alert('復元に失敗しました: ' + error.message);
    } finally {
        document.getElementById('executeRestoreBtn').disabled = false;
        document.getElementById('executeRestoreBtn').textContent = '復元実行';
    }
}

// バックアップ履歴の読み込み
async function loadBackupHistory() {
    try {
        const history = await window.electronAPI.getBackupHistory({ limit: 100 });
        const tbody = document.querySelector('#historyTable tbody');
        tbody.innerHTML = '';

        if (history.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">履歴がありません</td></tr>';
            return;
        }

        history.forEach((item) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDateTime(item.start_time)}</td>
                <td>${item.app_name || '-'}</td>
                <td><span class="badge badge-${getBadgeType(item.backup_type)}">${item.backup_type}</span></td>
                <td>${item.record_count || 0}件</td>
                <td><span class="badge badge-${getStatusBadge(item.status)}">${item.status}</span></td>
                <td>${item.duration_seconds ? item.duration_seconds.toFixed(2) + '秒' : '-'}</td>
                <td><button class="btn btn-danger btn-sm" onclick="deleteBackup(${item.id})">削除</button></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (error) {
        console.error('Failed to load history:', error);
    }
}

// バックアップを削除
async function deleteBackup(backupId) {
    if (!confirm('このバックアップを削除しますか?\nバックアップファイルも削除されます。')) {
        return;
    }

    try {
        await window.electronAPI.deleteBackup(backupId);
        alert('バックアップを削除しました');
        await loadBackupHistory();
        await loadStatistics();
    } catch (error) {
        console.error('Failed to delete backup:', error);
        alert('削除に失敗しました: ' + error.message);
    }
}

// 設定画面を開く
function openSettings() {
    alert('設定画面は未実装です');
}

// ユーティリティ関数
function formatDateTime(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleString('ja-JP');
}

function formatDate(date) {
    return date.toLocaleDateString('ja-JP');
}

function getBadgeType(backupType) {
    if (backupType === '全体') return 'success';
    if (backupType === '差分') return 'warning';
    if (backupType === '復元') return 'info';
    return 'secondary';
}

function getStatusBadge(status) {
    if (status === '成功') return 'success';
    if (status === '失敗') return 'error';
    return 'warning';
}
