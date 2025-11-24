const Store = require('electron-store');

// 暗号化されたストアの設定
const store = new Store({
    name: 'kintone-backup-config',
    encryptionKey: 'kintone-backup-scheduler-secret-key-2024',
    defaults: {
        kintone: {
            domain: '',
            username: '',
            password: '',
            apiToken: '',
            backupAppId: '',
        },
        apps: [],
        schedule: {
            enabled: false,
            days: {
                sunday: false,
                monday: false,
                tuesday: false,
                wednesday: false,
                thursday: false,
                friday: false,
                saturday: false,
            },
            time: '02:00',
        },
        backup: {
            outputDirectory: '',
            defaultType: 'differential',
        },
    },
});

class ConfigService {
    // 設定全体の取得
    static getConfig() {
        return store.store;
    }

    // kintone設定の保存
    static saveKintoneConfig(kintoneConfig) {
        store.set('kintone', kintoneConfig);
    }

    // kintone設定の取得
    static getKintoneConfig() {
        return store.get('kintone');
    }

    // アプリ一覧の保存
    static saveApps(apps) {
        store.set('apps', apps);
    }

    // アプリ一覧の取得
    static getApps() {
        return store.get('apps', []);
    }

    // スケジュール設定の保存
    static saveSchedule(scheduleConfig) {
        store.set('schedule', scheduleConfig);
    }

    // スケジュール設定の取得
    static getSchedule() {
        return store.get('schedule');
    }

    // バックアップ設定の保存
    static saveBackupConfig(backupConfig) {
        store.set('backup', backupConfig);
    }

    // バックアップ設定の取得
    static getBackupConfig() {
        return store.get('backup');
    }

    // 個別の設定値を取得
    static get(key, defaultValue = null) {
        return store.get(key, defaultValue);
    }

    // 個別の設定値を保存
    static set(key, value) {
        store.set(key, value);
    }

    // 設定のリセット
    static reset() {
        store.clear();
    }

    // セットアップ完了フラグ
    static isSetupCompleted() {
        const kintone = this.getKintoneConfig();
        const apps = this.getApps();

        return kintone && kintone.domain && (kintone.apiToken || (kintone.username && kintone.password)) && kintone.backupAppId && apps && apps.length > 0;
    }

    // 設定の検証
    static validateKintoneConfig(config) {
        const errors = [];

        if (!config.domain) {
            errors.push('サブドメインを入力してください');
        }

        if (!config.apiToken && (!config.username || !config.password)) {
            errors.push('APIトークンまたはユーザー名・パスワードを入力してください');
        }

        if (!config.backupAppId) {
            errors.push('バックアップ記録アプリIDを入力してください');
        }

        return {
            isValid: errors.length === 0,
            errors,
        };
    }

    // ストアファイルのパスを取得
    static getStorePath() {
        return store.path;
    }
}

module.exports = ConfigService;
