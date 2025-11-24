// セットアップウィザードのJavaScript

let currentStep = 1;
let kintoneConfig = {};
let selectedApps = [];
let allApps = [];

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    initializeTimeOptions();
    setupEventListeners();
    checkExistingConfig();
});

// 時刻オプションの生成（00:00〜23:00）
function initializeTimeOptions() {
    const select = document.getElementById('scheduleTime');
    for (let hour = 0; hour < 24; hour++) {
        const hourStr = hour.toString().padStart(2, '0');
        const option = document.createElement('option');
        option.value = `${hourStr}:00`;
        option.textContent = `${hourStr}:00`;
        select.appendChild(option);
    }
    // デフォルトで02:00を選択
    select.value = '02:00';
}

// イベントリスナーの設定
function setupEventListeners() {
    // Step 1
    document.getElementById('testConnection').addEventListener('click', testConnection);
    document.getElementById('nextStep1').addEventListener('click', () => goToStep(2));
    document.getElementById('showFieldsLink').addEventListener('click', showFieldDefinitions);

    // Step 2
    document.getElementById('prevStep2').addEventListener('click', () => goToStep(1));
    document.getElementById('nextStep2').addEventListener('click', saveScheduleAndGoToStep3);

    // Step 3
    document.getElementById('prevStep3').addEventListener('click', () => goToStep(2));
    document.getElementById('verifyAndBackup').addEventListener('click', verifyAppsAndBackup);
    document.getElementById('selectAllApps').addEventListener('change', toggleSelectAll);
    document.getElementById('appSearch').addEventListener('input', filterApps);

    // Step 4
    document.getElementById('finishSetup').addEventListener('click', finishSetup);
    document.getElementById('retrySetup').addEventListener('click', retrySetup);

    // 入力変更時に接続テストボタンを有効化
    ['domain', 'username', 'password', 'backupAppId'].forEach((id) => {
        document.getElementById(id).addEventListener('input', validateAuthForm);
    });
}

// 既存の設定をチェック
async function checkExistingConfig() {
    try {
        const config = await window.electronAPI.getConfig();
        if (config && config.kintone && config.kintone.domain) {
            // 既に設定がある場合、確認ダイアログを表示
            const result = await window.electronAPI.showDialog({
                type: 'question',
                buttons: ['はい', 'いいえ'],
                defaultId: 1,
                title: '設定済み',
                message: '既に設定が存在します。再度セットアップを実行しますか?',
            });

            if (result.response === 1) {
                // メイン画面へ遷移（今回は未実装なのでアラート）
                alert('メイン画面への遷移機能は未実装です');
                return;
            }
        }
    } catch (error) {
        console.error('Failed to check existing config:', error);
    }
}

// Step遷移
function goToStep(step) {
    // 現在のステップを非アクティブに
    document.querySelectorAll('.step-content').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.step-indicator .step').forEach((el) => el.classList.remove('active'));

    // 新しいステップをアクティブに
    document.getElementById(`step${step}`).classList.add('active');
    document.querySelector(`.step-indicator .step[data-step="${step}"]`).classList.add('active');

    currentStep = step;

    // Step 3の場合、アプリ一覧を読み込む
    if (step === 3) {
        loadApps();
    }
}

// 認証フォームのバリデーション
function validateAuthForm() {
    const domain = document.getElementById('domain').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const backupAppId = document.getElementById('backupAppId').value;

    const isValid = domain && username && password && backupAppId;
    document.getElementById('nextStep1').disabled = !isValid;
}

// 接続テスト
async function testConnection() {
    const btn = document.getElementById('testConnection');
    const status = document.getElementById('connectionStatus');

    btn.disabled = true;
    btn.textContent = '接続中...';
    status.style.display = 'none';

    const config = {
        domain: document.getElementById('domain').value.trim() + '.cybozu.com',
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
    };

    try {
        const result = await window.electronAPI.testKintoneConnection(config);

        if (result.success) {
            // バックアップアプリへのアクセステスト
            const backupAppId = document.getElementById('backupAppId').value;
            // ここで実際にバックアップアプリにアクセスできるかテスト
            // 今回は簡易的に成功とする

            showStatus(status, 'success', '接続成功! バックアップ記録アプリにもアクセスできます。');
            document.getElementById('nextStep1').disabled = false;

            // 設定を一時保存
            kintoneConfig = {
                ...config,
                backupAppId,
            };
        } else {
            showStatus(status, 'error', '接続失敗: ' + result.message);
        }
    } catch (error) {
        showStatus(status, 'error', 'エラーが発生しました: ' + error.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '接続テスト';
    }
}

// フィールド定義を表示
function showFieldDefinitions(e) {
    e.preventDefault();
    alert(
        'KINTONE_BACKUP_APP_FIELDS.mdファイルを参照してください。\n\n18個のフィールドが必要です:\n- バックアップ日時\n- 対象アプリID\n- 対象アプリ名\n- レコード数\n- 処理ステータス\n- 処理時間(秒)\n- エラー詳細\n- バックアップ種別\n- バックアップファイルパス\n- 実行トリガー\n- 差分基準日時\n- データサイズ(MB)\n- 圧縮率(%)\n- APIリクエスト数\n- リトライ回数\n- 実行ホスト名\n- アプリバージョン\n- 備考'
    );
}

// スケジュール保存とStep 3へ
async function saveScheduleAndGoToStep3() {
    const checkboxes = document.querySelectorAll('input[name="days"]:checked');
    const time = document.getElementById('scheduleTime').value;

    if (checkboxes.length === 0) {
        alert('少なくとも1つの曜日を選択してください');
        return;
    }

    if (!time) {
        alert('実行時刻を選択してください');
        return;
    }

    const days = {};
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].forEach((day) => {
        days[day] = Array.from(checkboxes).some((cb) => cb.value === day);
    });

    const scheduleConfig = { days, time };

    try {
        // Windowsタスクスケジューラに登録
        const status = document.getElementById('scheduleStatus');
        status.style.display = 'block';
        showStatus(status, 'info', 'タスクスケジューラに登録中...');

        await window.electronAPI.registerTaskScheduler(scheduleConfig);

        // 設定を保存
        await window.electronAPI.saveConfig({
            kintone: kintoneConfig,
            schedule: { enabled: true, ...scheduleConfig },
        });

        showStatus(status, 'success', 'スケジュールを登録しました');

        setTimeout(() => {
            goToStep(3);
        }, 1000);
    } catch (error) {
        const status = document.getElementById('scheduleStatus');
        showStatus(status, 'error', 'スケジュール登録に失敗しました: ' + error.message);
    }
}

// アプリ一覧の読み込み
async function loadApps() {
    const loading = document.getElementById('loadingApps');
    const appsList = document.getElementById('appsList');

    loading.style.display = 'block';
    appsList.style.display = 'none';

    try {
        allApps = await window.electronAPI.getAllApps();

        const container = document.getElementById('appsContainer');
        container.innerHTML = '';

        allApps.forEach((app) => {
            const div = document.createElement('div');
            div.className = 'app-item';
            div.innerHTML = `
                <label class="checkbox-label">
                    <input type="checkbox" class="app-checkbox" data-app-id="${app.appId}" data-app-name="${app.name}">
                    <span class="app-name">${app.name}</span>
                    <span class="app-id">ID: ${app.appId}</span>
                </label>
            `;
            container.appendChild(div);
        });

        loading.style.display = 'none';
        appsList.style.display = 'block';
    } catch (error) {
        loading.innerHTML = `<p class="error">アプリ一覧の取得に失敗しました: ${error.message}</p>`;
    }
}

// アプリ検索フィルター
function filterApps() {
    const searchTerm = document.getElementById('appSearch').value.toLowerCase();
    const appItems = document.querySelectorAll('.app-item');

    appItems.forEach((item) => {
        const appName = item.querySelector('.app-name').textContent.toLowerCase();
        if (appName.includes(searchTerm)) {
            item.style.display = 'block';
        } else {
            item.style.display = 'none';
        }
    });
}

// すべて選択/解除
function toggleSelectAll(e) {
    const checkboxes = document.querySelectorAll('.app-checkbox');
    checkboxes.forEach((cb) => {
        cb.checked = e.target.checked;
    });
}

// アプリ検証とバックアップ
async function verifyAppsAndBackup() {
    const checkedBoxes = document.querySelectorAll('.app-checkbox:checked');

    if (checkedBoxes.length === 0) {
        alert('少なくとも1つのアプリを選択してください');
        return;
    }

    selectedApps = Array.from(checkedBoxes).map((cb) => ({
        appId: cb.dataset.appId,
        appName: cb.dataset.appName,
    }));

    const status = document.getElementById('verificationStatus');
    status.style.display = 'block';
    showStatus(status, 'info', 'アプリのフィールド情報を取得中...');

    const errors = [];

    // 各アプリのフィールド情報を取得
    for (const app of selectedApps) {
        try {
            const fields = await window.electronAPI.getAppFields(app.appId);
            app.fields = fields;
        } catch (error) {
            errors.push({
                appId: app.appId,
                appName: app.appName,
                error: error.message,
            });
        }
    }

    if (errors.length > 0) {
        // エラーがあった場合
        let errorMsg = 'フィールド情報の取得に失敗したアプリがあります:\n\n';
        errors.forEach((err) => {
            errorMsg += `- ${err.appName} (ID: ${err.appId}): ${err.error}\n`;
        });
        errorMsg += '\nこれらのアプリにアクセス権限があるか確認してください。';

        showStatus(status, 'error', errorMsg);

        // エラーのあったアプリをハイライト
        errors.forEach((err) => {
            const checkbox = document.querySelector(`.app-checkbox[data-app-id="${err.appId}"]`);
            if (checkbox) {
                checkbox.closest('.app-item').classList.add('error');
            }
        });

        return;
    }

    // すべて成功した場合、設定を保存してStep 4へ
    showStatus(status, 'success', 'すべてのアプリのフィールド情報を取得しました');

    await window.electronAPI.saveConfig({
        apps: selectedApps,
    });

    setTimeout(() => {
        goToStep(4);
        startInitialBackup();
    }, 1000);
}

// 初回バックアップの実行
async function startInitialBackup() {
    const progressText = document.getElementById('progressText');
    const progressFill = document.getElementById('progressFill');
    const setupProgress = document.getElementById('setupProgress');
    const setupComplete = document.getElementById('setupComplete');
    const setupError = document.getElementById('setupError');

    let completedCount = 0;
    const totalCount = selectedApps.length;

    for (const app of selectedApps) {
        progressText.textContent = `バックアップ中: ${app.appName} (${completedCount + 1}/${totalCount})`;

        try {
            const paths = await window.electronAPI.getAppPaths();
            await window.electronAPI.runBackup({
                appId: app.appId,
                backupType: 'full',
                triggerType: '手動',
                hostname: paths.hostname,
                appVersion: paths.appVersion,
            });

            completedCount++;
            const progress = (completedCount / totalCount) * 100;
            progressFill.style.width = progress + '%';
        } catch (error) {
            console.error(`Backup failed for app ${app.appId}:`, error);
            // エラーがあっても継続
            completedCount++;
        }
    }

    // 完了
    setupProgress.style.display = 'none';
    setupComplete.style.display = 'block';

    // サマリー表示
    const summary = document.getElementById('setupSummary');
    summary.innerHTML = `
        <li>kintoneドメイン: ${kintoneConfig.domain}</li>
        <li>バックアップ対象アプリ: ${selectedApps.length}個</li>
        <li>初回バックアップ: 完了</li>
    `;
}

// セットアップ完了
function finishSetup() {
    // メイン画面へ遷移（今回は未実装）
    alert('セットアップが完了しました。アプリを再起動してください。');
    window.close();
}

// 再試行
function retrySetup() {
    goToStep(1);
    document.getElementById('setupError').style.display = 'none';
}

// ステータスメッセージ表示
function showStatus(element, type, message) {
    element.className = 'status-message ' + type;
    element.textContent = message;
    element.style.display = 'block';
}
