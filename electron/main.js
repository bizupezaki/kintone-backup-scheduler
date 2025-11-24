const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const os = require('os');
const fs = require('fs-extra');

// GPU アクセラレーションを無効化（GPU エラーログ抑止）
app.disableHardwareAcceleration();

let mainWindow;
const isDev = process.argv.includes('--dev');
const isScheduled = process.argv.includes('--scheduled');

// アプリケーションのデータディレクトリ
const APP_DATA_DIR = path.join(app.getPath('userData'), 'backup_data');
const METADATA_DB_PATH = path.join(APP_DATA_DIR, 'metadata.db');
const ARCHIVES_DIR = path.join(APP_DATA_DIR, 'archives');
const ATTACHMENTS_DIR = path.join(APP_DATA_DIR, 'attachments');

// ディレクトリの初期化
async function initializeDirectories() {
    await fs.ensureDir(APP_DATA_DIR);
    await fs.ensureDir(ARCHIVES_DIR);
    await fs.ensureDir(ATTACHMENTS_DIR);
}

// メインウィンドウの作成
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        icon: path.join(__dirname, '../assets/icon.png'),
    });

    // 設定の有無を確認して適切なページをロード
    const ConfigService = require('../src/services/configService');
    const config = ConfigService.getConfig();

    if (config && config.kintone && config.kintone.domain) {
        // 設定済み: メインダッシュボードを表示
        mainWindow.loadFile(path.join(__dirname, '../src/renderer/index.html'));
    } else {
        // 未設定: セットアップウィザードを表示
        mainWindow.loadFile(path.join(__dirname, '../src/renderer/setup.html'));
    }

    if (isDev) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// スケジュール実行モード（ヘッドレス）
async function runScheduledBackup() {
    try {
        console.log('Scheduled backup started at:', new Date().toISOString());

        // ディレクトリ初期化
        await initializeDirectories();

        // 設定とデータベースの読み込み
        const ConfigService = require('../src/services/configService');
        const Database = require('../src/core/database');
        const BackupManager = require('../src/core/backupManager');

        const config = ConfigService.getConfig();
        if (!config || !config.kintone || !config.apps) {
            console.error('Configuration not found. Please run setup first.');
            process.exit(1);
        }

        const db = new Database(METADATA_DB_PATH);
        const logDir = path.join(APP_DATA_DIR, 'logs');
        await fs.ensureDir(logDir);

        const backupManager = new BackupManager(config, db, ARCHIVES_DIR, ATTACHMENTS_DIR, logDir);

        // 差分バックアップ実行
        const results = await backupManager.runScheduledBackup();

        console.log('Scheduled backup completed:', results);
        process.exit(0);
    } catch (error) {
        console.error('Scheduled backup failed:', error);
        process.exit(1);
    }
}

// Windowsタスクスケジューラへの登録
ipcMain.handle('register-task-scheduler', async (event, scheduleConfig) => {
    try {
        const exePath = process.execPath;
        const taskName = 'KintoneBackupScheduler_Daily';

        // 既存タスクを削除（エラーは無視）
        await new Promise((resolve) => {
            exec(`schtasks /Delete /TN "${taskName}" /F`, () => resolve());
        });

        // 曜日の設定
        const daysMap = {
            sunday: 'SUN',
            monday: 'MON',
            tuesday: 'TUE',
            wednesday: 'WED',
            thursday: 'THU',
            friday: 'FRI',
            saturday: 'SAT',
        };

        const selectedDays = Object.keys(scheduleConfig.days)
            .filter((day) => scheduleConfig.days[day])
            .map((day) => daysMap[day])
            .join(',');

        if (!selectedDays) {
            throw new Error('少なくとも1つの曜日を選択してください');
        }

        // タスク作成コマンド
        const command = `schtasks /Create /TN "${taskName}" /TR "\\"${exePath}\\" --scheduled" /SC WEEKLY /D ${selectedDays} /ST ${scheduleConfig.time} /RL LIMITED /F`;

        return new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error('Task registration error:', stderr);
                    reject(new Error('タスクスケジューラへの登録に失敗しました: ' + stderr));
                } else {
                    console.log('Task registered:', stdout);
                    resolve({ success: true, message: 'スケジュールを登録しました' });
                }
            });
        });
    } catch (error) {
        console.error('Task registration failed:', error);
        throw error;
    }
});

// アプリケーション起動時の処理
app.whenReady().then(async () => {
    await initializeDirectories();

    if (isScheduled) {
        // スケジュール実行モード
        await runScheduledBackup();
    } else {
        // 通常のGUIモード
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// パスの取得
ipcMain.handle('get-app-paths', () => {
    return {
        appDataDir: APP_DATA_DIR,
        metadataDb: METADATA_DB_PATH,
        archivesDir: ARCHIVES_DIR,
        attachmentsDir: ATTACHMENTS_DIR,
        hostname: os.hostname(),
        appVersion: app.getVersion(),
    };
});

// ダイアログ表示
ipcMain.handle('show-dialog', async (event, options) => {
    return await dialog.showMessageBox(mainWindow, options);
});

// kintone接続テスト
ipcMain.handle('test-kintone-connection', async (event, config) => {
    try {
        const KintoneClient = require('../src/core/kintoneClient');
        const client = new KintoneClient(config);
        return await client.testConnection();
    } catch (error) {
        return { success: false, message: error.message };
    }
});

// 全アプリ取得
ipcMain.handle('get-all-apps', async () => {
    try {
        const ConfigService = require('../src/services/configService');
        const config = ConfigService.getKintoneConfig();
        const KintoneClient = require('../src/core/kintoneClient');
        const client = new KintoneClient(config);
        return await client.getAllApps();
    } catch (error) {
        throw error;
    }
});

// アプリフィールド取得
ipcMain.handle('get-app-fields', async (event, appId) => {
    try {
        const ConfigService = require('../src/services/configService');
        const config = ConfigService.getKintoneConfig();
        const KintoneClient = require('../src/core/kintoneClient');
        const client = new KintoneClient(config);
        return await client.getFormFields(appId);
    } catch (error) {
        throw error;
    }
});

// バックアップ実行
ipcMain.handle('run-backup', async (event, options) => {
    try {
        const ConfigService = require('../src/services/configService');
        const Database = require('../src/core/database');
        const BackupManager = require('../src/core/backupManager');

        const config = ConfigService.getConfig();
        const db = new Database(METADATA_DB_PATH);
        const logDir = path.join(APP_DATA_DIR, 'logs');
        await fs.ensureDir(logDir);

        const backupManager = new BackupManager(config, db, ARCHIVES_DIR, ATTACHMENTS_DIR, logDir);

        const backupOptions = {
            ...options,
            hostname: os.hostname(),
            appVersion: app.getVersion(),
        };

        return await backupManager.backupApp(options.appId, backupOptions);
    } catch (error) {
        throw error;
    }
});

// バックアップ履歴取得
ipcMain.handle('get-backup-history', async (event, filters) => {
    try {
        const Database = require('../src/core/database');
        const db = new Database(METADATA_DB_PATH);
        return db.getBackupHistory(filters);
    } catch (error) {
        throw error;
    }
});

// バックアップ詳細取得
ipcMain.handle('get-backup-details', async (event, backupId) => {
    try {
        const ConfigService = require('../src/services/configService');
        const Database = require('../src/core/database');
        const BackupManager = require('../src/core/backupManager');

        const config = ConfigService.getConfig();
        const db = new Database(METADATA_DB_PATH);
        const logDir = path.join(APP_DATA_DIR, 'logs');

        const backupManager = new BackupManager(config, db, ARCHIVES_DIR, ATTACHMENTS_DIR, logDir);
        return await backupManager.getRecordsFromBackup(backupId);
    } catch (error) {
        throw error;
    }
});

// バックアップ削除
ipcMain.handle('delete-backup', async (event, backupId) => {
    try {
        const Database = require('../src/core/database');
        const db = new Database(METADATA_DB_PATH);

        const backup = db.getBackupById(backupId);
        if (!backup) {
            throw new Error('バックアップが見つかりません');
        }

        // ZIPファイルを削除
        const zipFilePath = path.join(ARCHIVES_DIR, backup.file_path);
        if (await fs.pathExists(zipFilePath)) {
            await fs.remove(zipFilePath);
        }

        // DBから削除
        db.deleteBackup(backupId);

        return { success: true };
    } catch (error) {
        throw error;
    }
});

// レコード復元
ipcMain.handle('restore-records', async (event, options) => {
    try {
        const ConfigService = require('../src/services/configService');
        const Database = require('../src/core/database');
        const BackupManager = require('../src/core/backupManager');

        const config = ConfigService.getConfig();
        const db = new Database(METADATA_DB_PATH);
        const logDir = path.join(APP_DATA_DIR, 'logs');
        await fs.ensureDir(logDir);

        const backupManager = new BackupManager(config, db, ARCHIVES_DIR, ATTACHMENTS_DIR, logDir);

        const restoreOptions = {
            ...options,
            hostname: os.hostname(),
            appVersion: app.getVersion(),
        };

        return await backupManager.restoreBackup(options.backupId, restoreOptions);
    } catch (error) {
        throw error;
    }
});

// 設定の保存
ipcMain.handle('save-config', async (event, config) => {
    try {
        const ConfigService = require('../src/services/configService');

        if (config.kintone) {
            ConfigService.saveKintoneConfig(config.kintone);
        }
        if (config.apps) {
            ConfigService.saveApps(config.apps);
        }
        if (config.schedule) {
            ConfigService.saveSchedule(config.schedule);
        }
        if (config.backup) {
            ConfigService.saveBackupConfig(config.backup);
        }

        return { success: true };
    } catch (error) {
        throw error;
    }
});

// 設定の取得
ipcMain.handle('get-config', async () => {
    try {
        const ConfigService = require('../src/services/configService');
        return ConfigService.getConfig();
    } catch (error) {
        throw error;
    }
});

// バックアップメタデータ取得
ipcMain.handle('get-backup-metadata', async (event, backupId) => {
    try {
        const Database = require('../src/core/database');
        const db = new Database(METADATA_DB_PATH);
        const backup = db.getBackupById(backupId);

        if (!backup) {
            throw new Error('バックアップが見つかりません');
        }

        const zipFilePath = path.join(ARCHIVES_DIR, backup.file_path);
        const unzipper = require('unzipper');

        return new Promise((resolve, reject) => {
            let metadataJson = '';

            fs.createReadStream(zipFilePath)
                .pipe(unzipper.Parse())
                .on('entry', (entry) => {
                    if (entry.path === 'backup_metadata.json') {
                        entry.on('data', (chunk) => {
                            metadataJson += chunk.toString();
                        });
                        entry.on('end', () => {
                            try {
                                const metadata = JSON.parse(metadataJson);
                                resolve(metadata);
                            } catch (error) {
                                reject(new Error('Failed to parse metadata: ' + error.message));
                            }
                        });
                    } else {
                        entry.autodrain();
                    }
                })
                .on('close', () => {
                    if (!metadataJson) {
                        resolve(null); // メタデータが存在しない古いバックアップ
                    }
                })
                .on('error', reject);
        });
    } catch (error) {
        throw error;
    }
});

// エラーハンドリング
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (!isScheduled && mainWindow) {
        dialog.showErrorBox('エラー', 'アプリケーションエラーが発生しました: ' + error.message);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
