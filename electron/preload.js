const { contextBridge, ipcRenderer } = require('electron');

// セキュアなAPIをレンダラープロセスに公開
contextBridge.exposeInMainWorld('electronAPI', {
    // アプリケーションパスの取得
    getAppPaths: () => ipcRenderer.invoke('get-app-paths'),

    // タスクスケジューラへの登録
    registerTaskScheduler: (scheduleConfig) => ipcRenderer.invoke('register-task-scheduler', scheduleConfig),

    // ダイアログ表示
    showDialog: (options) => ipcRenderer.invoke('show-dialog', options),

    // kintone関連のIPC
    testKintoneConnection: (config) => ipcRenderer.invoke('test-kintone-connection', config),

    getAllApps: () => ipcRenderer.invoke('get-all-apps'),

    getAppFields: (appId) => ipcRenderer.invoke('get-app-fields', appId),

    runBackup: (options) => ipcRenderer.invoke('run-backup', options),

    getBackupHistory: (filters) => ipcRenderer.invoke('get-backup-history', filters),

    getBackupDetails: (backupId) => ipcRenderer.invoke('get-backup-details', backupId),

    deleteBackup: (backupId) => ipcRenderer.invoke('delete-backup', backupId),

    restoreRecords: (options) => ipcRenderer.invoke('restore-records', options),

    // 設定の保存・読み込み
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),

    getConfig: () => ipcRenderer.invoke('get-config'),

    getBackupMetadata: (backupId) => ipcRenderer.invoke('get-backup-metadata', backupId),

    // 進捗状況のリスナー
    onBackupProgress: (callback) => {
        ipcRenderer.on('backup-progress', (event, progress) => callback(progress));
    },

    removeBackupProgressListener: () => {
        ipcRenderer.removeAllListeners('backup-progress');
    },
});
