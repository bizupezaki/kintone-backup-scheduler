const archiver = require('archiver');
const unzipper = require('unzipper');
const fs = require('fs-extra');
const path = require('path');
const { pipeline } = require('stream/promises');

const KintoneClient = require('./kintoneClient');
const LogService = require('../services/logService');

// kintone システムフィールド（復元時に除外）
const SYSTEM_FIELDS = [
    'RECORD_NUMBER', // レコード番号
    '__ID__', // レコードID
    '__REVISION__', // リビジョン
    'CREATOR', // 作成者
    'CREATED_TIME', // 作成日時
    'MODIFIER', // 更新者
    'UPDATED_TIME', // 更新日時
    'STATUS', // ステータス
    'STATUS_ASSIGNEE', // 作業者
    '$id', // レコードID（エイリアス）
    '$revision', // リビジョン（エイリアス）
];

// 読み取り専用フィールドタイプ（復元時に除外）
const READONLY_FIELD_TYPES = [
    'RECORD_NUMBER', // レコード番号
    'CREATOR', // 作成者
    'CREATED_TIME', // 作成日時
    'MODIFIER', // 更新者
    'UPDATED_TIME', // 更新日時
    'STATUS', // ステータス
    'STATUS_ASSIGNEE', // 作業者
    '__ID__', // レコードID
    '__REVISION__', // リビジョン
    'CALC', // 計算フィールド
    'CATEGORY', // カテゴリ
];

class BackupManager {
    constructor(config, database, archivesDir, attachmentsDir, logDir) {
        this.config = config;
        this.db = database;
        this.archivesDir = archivesDir;
        this.attachmentsDir = attachmentsDir;
        this.kintoneClient = new KintoneClient(config.kintone);
        this.logger = new LogService(logDir);
        this.currentBackupId = null;
    }

    /**
     * システムフィールドと読み取り専用フィールドを除外してレコードをクリーンアップ
     */
    cleanRecordForRestore(record) {
        const cleanRecord = {};

        // 全フィールドをループしてシステムフィールドを除外
        for (const [fieldCode, fieldValue] of Object.entries(record)) {
            // システムフィールドをスキップ
            if (SYSTEM_FIELDS.includes(fieldCode)) {
                continue;
            }

            // フィールドの type が読み取り専用の場合もスキップ
            if (fieldValue && typeof fieldValue === 'object' && fieldValue.type) {
                const fieldType = fieldValue.type;
                if (READONLY_FIELD_TYPES.includes(fieldType)) {
                    continue;
                }
            }

            cleanRecord[fieldCode] = fieldValue;
        }

        return cleanRecord;
    }

    /**
     * スケジュール実行時の自動バックアップ
     */
    async runScheduledBackup() {
        const results = [];
        const apps = this.db.getAllApps(true); // アクティブなアプリのみ取得

        this.logger.info(`Scheduled backup started for ${apps.length} apps`);

        for (const app of apps) {
            try {
                const result = await this.backupApp(app.app_id, {
                    backupType: 'differential',
                    triggerType: 'スケジュール',
                });
                results.push(result);
            } catch (error) {
                this.logger.logBackupFailure(app.app_id, app.app_name, error);
                results.push({
                    appId: app.app_id,
                    appName: app.app_name,
                    success: false,
                    error: error.message,
                });
            }
        }

        return results;
    }

    /**
     * アプリのバックアップ実行
     */
    async backupApp(appId, options = {}) {
        const {
            backupType = 'full', // 'full' or 'differential'
            triggerType = '手動',
            hostname = '',
            appVersion = '',
        } = options;

        const startTime = new Date().toISOString();
        const startTimestamp = Date.now();

        // バックアップ記録の初期化
        this.currentBackupId = this.db.insertBackup({
            app_id: appId,
            app_name: '',
            backup_type: backupType === 'full' ? '全体' : '差分',
            trigger_type: triggerType,
            start_time: startTime,
            status: '実行中',
            hostname,
            app_version: appVersion,
        });

        try {
            // アプリ情報の取得
            const appInfo = await this.kintoneClient.getApp(appId);
            const appName = appInfo.name;

            this.logger.logBackupStart(appId, appName, backupType, triggerType);

            // バックアップ名を更新
            this.db.updateBackup(this.currentBackupId, { app_name: appName });

            // レコードの取得
            let records;
            let diffBaseDatetime = null;

            if (backupType === 'differential') {
                const lastBackup = this.db.getLastBackupDatetime(appId);
                if (lastBackup && lastBackup.last_backup_datetime) {
                    diffBaseDatetime = lastBackup.last_backup_datetime;
                    records = await this.kintoneClient.getDifferentialRecords(appId, diffBaseDatetime);
                } else {
                    // 差分バックアップ指定でも初回は全体バックアップ
                    records = await this.kintoneClient.getAllRecords(appId);
                }
            } else {
                records = await this.kintoneClient.getAllRecords(appId);
            }

            if (records.length === 0) {
                // レコードがない場合
                const endTime = new Date().toISOString();
                const duration = (Date.now() - startTimestamp) / 1000;

                this.db.updateBackup(this.currentBackupId, {
                    end_time: endTime,
                    duration_seconds: duration,
                    record_count: 0,
                    status: '成功',
                    api_request_count: this.kintoneClient.getStats().apiRequestCount,
                    retry_count: this.kintoneClient.getStats().retryCount,
                    diff_base_datetime: diffBaseDatetime,
                });

                this.logger.info(`No records to backup for app ${appId}`);

                return {
                    appId,
                    appName,
                    success: true,
                    recordCount: 0,
                    message: 'バックアップするレコードがありません',
                };
            }

            // ZIPファイルの作成
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
            const zipFileName = `app_${appId}_${timestamp}_${backupType}.zip`;
            const zipFilePath = path.join(this.archivesDir, zipFileName);

            const originalSize = await this.createBackupZip(appId, records, zipFilePath);

            // 添付ファイルのダウンロード
            await this.downloadAttachments(appId, records, timestamp);

            // 圧縮率の計算
            const compressedSize = (await fs.stat(zipFilePath)).size;
            const compressionRatio = ((1 - compressedSize / originalSize) * 100).toFixed(2);

            // レコードインデックスの更新（差分バックアップ用）
            for (const record of records) {
                const updatedTime = record.$revision?.value || record.更新日時?.value || startTime;
                this.db.upsertRecordIndex(appId, record.$id.value, updatedTime, this.currentBackupId);
            }

            // バックアップ履歴の更新
            const endTime = new Date().toISOString();
            const duration = (Date.now() - startTimestamp) / 1000;

            this.db.updateBackup(this.currentBackupId, {
                end_time: endTime,
                duration_seconds: duration,
                record_count: records.length,
                file_path: zipFileName,
                data_size_mb: (compressedSize / (1024 * 1024)).toFixed(2),
                compression_ratio: parseFloat(compressionRatio),
                status: '成功',
                api_request_count: this.kintoneClient.getStats().apiRequestCount,
                retry_count: this.kintoneClient.getStats().retryCount,
                diff_base_datetime: diffBaseDatetime,
            });

            // アプリの最終バックアップ日時を更新
            this.db.updateAppLastBackup(appId, endTime, backupType === 'full');

            // kintoneバックアップ記録アプリにログ
            await this.logToKintoneBackupApp({
                backup_datetime: startTime,
                target_app_id: appId,
                target_app_name: appName,
                record_count: records.length,
                status: '成功',
                duration_seconds: duration,
                backup_type: backupType === 'full' ? '全体' : '差分',
                file_path: zipFileName,
                trigger_type: triggerType,
                diff_base_datetime: diffBaseDatetime || '',
                data_size_mb: parseFloat((compressedSize / (1024 * 1024)).toFixed(2)),
                compression_ratio: parseFloat(compressionRatio),
                api_request_count: this.kintoneClient.getStats().apiRequestCount,
                retry_count: this.kintoneClient.getStats().retryCount,
                hostname,
                app_version: appVersion,
            });

            this.logger.logBackupSuccess(appId, appName, records.length, duration);

            return {
                appId,
                appName,
                success: true,
                recordCount: records.length,
                filePath: zipFilePath,
                duration,
            };
        } catch (error) {
            // エラー時の処理
            const endTime = new Date().toISOString();
            const duration = (Date.now() - startTimestamp) / 1000;

            this.db.updateBackup(this.currentBackupId, {
                end_time: endTime,
                duration_seconds: duration,
                status: '失敗',
                error_details: error.stack || error.message,
                api_request_count: this.kintoneClient.getStats().apiRequestCount,
                retry_count: this.kintoneClient.getStats().retryCount,
            });

            this.logger.logBackupFailure(appId, '', error);

            throw error;
        } finally {
            // API呼び出し回数のリセット
            this.kintoneClient.resetCounters();
        }
    }

    /**
     * バックアップZIPの作成（ストリーミング）
     */
    async createBackupZip(appId, records, zipFilePath) {
        return new Promise(async (resolve, reject) => {
            const output = fs.createWriteStream(zipFilePath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            let originalSize = 0;

            output.on('close', () => {
                resolve(originalSize);
            });

            archive.on('error', (err) => {
                reject(err);
            });

            archive.pipe(output);

            // レコードデータをJSONとして追加
            const recordsJson = JSON.stringify(records, null, 2);
            originalSize = Buffer.byteLength(recordsJson, 'utf8');
            archive.append(recordsJson, { name: 'records.json' });

            // フィールド情報の取得
            let fieldProperties = null;
            try {
                fieldProperties = await this.kintoneClient.getFormFields(appId);
            } catch (error) {
                this.logger.error(`Failed to get field properties for app ${appId}:`, error);
                // フィールド情報取得失敗時は null のまま継続
            }

            // メタデータの追加（フィールド情報を含める）
            const metadata = {
                schemaVersion: '1.0.0',
                appId,
                recordCount: records.length,
                backupDate: new Date().toISOString(),
                version: '1.0',
                fieldProperties: fieldProperties,
            };
            archive.append(JSON.stringify(metadata, null, 2), { name: 'backup_metadata.json' });

            archive.finalize();
        });
    }

    /**
     * 添付ファイルのダウンロード
     */
    async downloadAttachments(appId, records, timestamp) {
        const attachmentFields = this.findAttachmentFields(records);

        if (attachmentFields.length === 0) {
            return;
        }

        for (const record of records) {
            const recordId = record.$id.value;

            for (const fieldCode of attachmentFields) {
                const field = record[fieldCode];
                if (!field || !field.value || field.value.length === 0) {
                    continue;
                }

                for (const file of field.value) {
                    try {
                        const fileData = await this.kintoneClient.downloadFile(file.fileKey);
                        const fileName = file.name;
                        const filePath = path.join(this.attachmentsDir, appId, recordId, timestamp, fileName);

                        await fs.ensureDir(path.dirname(filePath));
                        await fs.writeFile(filePath, fileData);

                        this.logger.info(`Downloaded attachment: ${fileName} for record ${recordId}`);
                    } catch (error) {
                        this.logger.error(`Failed to download attachment for record ${recordId}:`, error);
                        // 添付ファイルのダウンロード失敗は処理を継続
                    }
                }
            }
        }
    }

    /**
     * レコードから添付ファイルフィールドを検出
     */
    findAttachmentFields(records) {
        if (records.length === 0) {
            return [];
        }

        const attachmentFields = [];
        const firstRecord = records[0];

        for (const [fieldCode, field] of Object.entries(firstRecord)) {
            if (field.type === 'FILE') {
                attachmentFields.push(fieldCode);
            }
        }

        return attachmentFields;
    }

    /**
     * バックアップの復元
     */
    async restoreBackup(backupId, options = {}) {
        const { selectedRecordIds = null, hostname = '', appVersion = '' } = options;

        const backup = this.db.getBackupById(backupId);
        if (!backup) {
            throw new Error('バックアップが見つかりません');
        }

        const startTime = new Date().toISOString();
        const startTimestamp = Date.now();

        this.logger.logRestoreStart(backup.app_id, backup.app_name, selectedRecordIds?.length || 0);

        try {
            // ZIPファイルの展開
            const zipFilePath = path.join(this.archivesDir, backup.file_path);
            const records = await this.extractBackupZip(zipFilePath);

            // 特定レコードのみ復元する場合
            let recordsToRestore = records;
            if (selectedRecordIds && selectedRecordIds.length > 0) {
                recordsToRestore = records.filter((record) => selectedRecordIds.includes(record.$id.value));
            }

            if (recordsToRestore.length === 0) {
                throw new Error('復元するレコードがありません');
            }

            // システムフィールドを除外してクリーンアップ
            const cleanedRecords = recordsToRestore.map((record) => this.cleanRecordForRestore(record));

            // 元レコードから「レコード番号的な値」を抽出
            const recordNumberList = recordsToRestore.map((record) => {
                if (record.$id && record.$id.value) return String(record.$id.value);
                if (record['レコード番号'] && record['レコード番号'].value) return String(record['レコード番号'].value);
                return null;
            });

            // 一意な検索キー（null を除去）
            const uniqueRecordNumbers = Array.from(new Set(recordNumberList.filter((v) => v !== null)));

            // レコード番号 -> kintone レコードID のマッピングを取得
            let mapping = {};
            if (uniqueRecordNumbers.length > 0) {
                try {
                    mapping = await this.kintoneClient.findRecordIdsByRecordNumbers(backup.app_id, uniqueRecordNumbers);
                    console.log('RecordNumber -> kintoneId mapping:', JSON.stringify(mapping, null, 2));
                    this.logger.info(`Found mapping keys: ${Object.keys(mapping).length}`);
                } catch (err) {
                    this.logger.error('findRecordIdsByRecordNumbers failed:', err);
                    console.error('Mapping error:', err);
                    mapping = {};
                }
            }

            // 更新対象と追加対象に振り分け
            const updates = [];
            const adds = [];

            for (let i = 0; i < cleanedRecords.length; i++) {
                const rec = cleanedRecords[i];
                const num = recordNumberList[i];
                const mappedId = num != null ? mapping[String(num)] : undefined;

                if (mappedId) {
                    updates.push({ id: String(mappedId), record: rec });
                } else {
                    adds.push(rec);
                }
            }

            console.log(`Prepared updates: ${updates.length}, adds: ${adds.length}`);
            this.logger.info(`Prepared updates: ${updates.length}, adds: ${adds.length}`);

            // 実際の API 呼び出し
            let updatedCount = 0;
            let addedCount = 0;
            let updateFailed = false;
            let addFailed = false;

            if (updates.length > 0) {
                try {
                    await this.kintoneClient.updateAllRecords(backup.app_id, updates);
                    updatedCount = updates.length;
                } catch (err) {
                    updateFailed = true;
                    this.logger.error('Failed to update records during restore:', err);
                    console.error('Update error:', err);
                }
            }

            if (adds.length > 0) {
                try {
                    const res = await this.kintoneClient.addAllRecords(backup.app_id, adds);
                    addedCount = Array.isArray(res) ? res.length : adds.length;
                } catch (err) {
                    addFailed = true;
                    this.logger.error('Failed to add records during restore:', err);
                    console.error('Add error:', err);
                }
            }

            // ステータス判定
            let status = '成功';
            if ((updateFailed || addFailed) && (addedCount > 0 || updatedCount > 0)) {
                status = '部分成功';
            } else if (updateFailed && addFailed) {
                status = '失敗';
            }

            const endTime = new Date().toISOString();
            const duration = (Date.now() - startTimestamp) / 1000;

            const remarks = `バックアップID: ${backupId}からの復元 (追加:${addedCount}, 更新:${updatedCount})`;

            // 復元ログをバックアップ記録アプリに保存
            await this.logToKintoneBackupApp({
                backup_datetime: startTime,
                target_app_id: backup.app_id,
                target_app_name: backup.app_name,
                record_count: recordsToRestore.length,
                status: status,
                duration_seconds: duration,
                backup_type: '復元',
                file_path: backup.file_path,
                trigger_type: '手動',
                api_request_count: this.kintoneClient.getStats().apiRequestCount,
                retry_count: this.kintoneClient.getStats().retryCount,
                hostname,
                app_version: appVersion,
                remarks,
            });

            this.logger.logRestoreSuccess(backup.app_id, backup.app_name, recordsToRestore.length, duration);

            return {
                success: status === '成功' || status === '部分成功',
                appId: backup.app_id,
                appName: backup.app_name,
                recordCount: recordsToRestore.length,
                duration,
                addedCount,
                updatedCount,
            };
        } catch (error) {
            this.logger.logRestoreFailure(backup.app_id, backup.app_name, error);
            throw error;
        } finally {
            this.kintoneClient.resetCounters();
        }
    }

    /**
     * ZIPファイルからレコードを展開
     */
    async extractBackupZip(zipFilePath) {
        return new Promise((resolve, reject) => {
            const records = [];
            let recordsJson = '';

            fs.createReadStream(zipFilePath)
                .pipe(unzipper.Parse())
                .on('entry', async (entry) => {
                    const fileName = entry.path;

                    if (fileName === 'records.json') {
                        entry.on('data', (chunk) => {
                            recordsJson += chunk.toString();
                        });
                        entry.on('end', () => {
                            try {
                                const parsed = JSON.parse(recordsJson);
                                records.push(...parsed);
                            } catch (error) {
                                reject(new Error('Failed to parse records.json: ' + error.message));
                            }
                        });
                    } else {
                        entry.autodrain();
                    }
                })
                .on('close', () => {
                    resolve(records);
                })
                .on('error', (error) => {
                    reject(error);
                });
        });
    }

    /**
     * kintoneバックアップ記録アプリへのログ記録
     */
    async logToKintoneBackupApp(logData) {
        try {
            const backupAppId = this.config.kintone.backupAppId;
            if (!backupAppId) {
                this.logger.warn('Backup app ID not configured. Skipping log to kintone.');
                return;
            }

            await this.kintoneClient.logToBackupApp(backupAppId, logData);
        } catch (error) {
            this.logger.error('Failed to log to backup app:', error);
            // ログ記録失敗は処理を継続
        }
    }

    /**
     * バックアップ履歴の取得
     */
    getBackupHistory(filters = {}) {
        return this.db.getBackupHistory(filters);
    }

    /**
     * 特定のバックアップ詳細の取得
     */
    getBackupDetails(backupId) {
        return this.db.getBackupById(backupId);
    }

    /**
     * バックアップファイルからレコード一覧を取得（プレビュー用）
     */
    async getRecordsFromBackup(backupId) {
        const backup = this.db.getBackupById(backupId);
        if (!backup) {
            throw new Error('バックアップが見つかりません');
        }

        const zipFilePath = path.join(this.archivesDir, backup.file_path);
        return await this.extractBackupZip(zipFilePath);
    }
}

module.exports = BackupManager;
