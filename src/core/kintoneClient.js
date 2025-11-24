const { KintoneRestAPIClient } = require('@kintone/rest-api-client');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;

// リトライ設定
const RETRY_CONFIG = {
    maxRetries: 5,
    initialDelay: 1000,
    maxDelay: 32000,
    backoffMultiplier: 2,
    retryableStatusCodes: [429, 500, 502, 503, 504],
};

class KintoneClient {
    constructor(config) {
        this.config = config;
        this.client = null;
        this.apiRequestCount = 0;
        this.retryCount = 0;
        this.recordNumberFieldCache = {}; // ←この行を追加
        this.initializeClient();
    }

    initializeClient() {
        const { domain, username, password, apiToken } = this.config;

        const auth = apiToken ? { apiToken } : { username, password };

        this.client = new KintoneRestAPIClient({
            baseUrl: `https://${domain}`,
            auth,
        });

        // axios用のリトライ設定
        this.setupAxiosRetry();
    }

    setupAxiosRetry() {
        // kintone REST API Clientの内部axiosインスタンスにリトライを設定
        axiosRetry(axios, {
            retries: RETRY_CONFIG.maxRetries,
            retryDelay: (retryCount) => {
                const delay = Math.min(RETRY_CONFIG.initialDelay * Math.pow(RETRY_CONFIG.backoffMultiplier, retryCount - 1), RETRY_CONFIG.maxDelay);

                // Jitter追加（±20%のランダム揺らぎ）
                const jitter = delay * 0.2 * (Math.random() * 2 - 1);
                return delay + jitter;
            },
            retryCondition: (error) => {
                this.retryCount++;

                // 429 Rate Limitの場合、Retry-Afterヘッダーを優先
                if (error.response && error.response.status === 429) {
                    const retryAfter = error.response.headers['retry-after'];
                    if (retryAfter) {
                        const waitTime = parseInt(retryAfter) * 1000;
                        console.log(`Rate limit hit. Waiting ${retryAfter} seconds...`);
                        return true;
                    }
                }

                // リトライ可能なエラー判定
                return axiosRetry.isNetworkOrIdempotentRequestError(error) || (error.response && RETRY_CONFIG.retryableStatusCodes.includes(error.response.status));
            },
        });
    }

    // 接続テスト
    async testConnection() {
        try {
            this.apiRequestCount++;
            const apps = await this.client.app.getApps({ limit: 1 });
            return { success: true, message: '接続成功' };
        } catch (error) {
            return {
                success: false,
                message: '接続失敗: ' + (error.message || 'Unknown error'),
                error,
            };
        }
    }

    // 全アプリの取得（100件制限を超えて取得）
    async getAllApps() {
        try {
            const allApps = [];
            let offset = 0;
            const limit = 100;
            let hasMore = true;

            while (hasMore) {
                this.apiRequestCount++;
                const response = await this.client.app.getApps({ limit, offset });

                allApps.push(...response.apps);

                if (response.apps.length < limit) {
                    hasMore = false;
                } else {
                    offset += limit;
                }
            }

            return allApps;
        } catch (error) {
            console.error('Failed to get all apps:', error);
            throw error;
        }
    }

    // アプリ情報の取得
    async getApp(appId) {
        try {
            this.apiRequestCount++;
            return await this.client.app.getApp({ id: appId });
        } catch (error) {
            console.error(`Failed to get app ${appId}:`, error);
            throw error;
        }
    }

    // フィールド情報の取得
    async getFormFields(appId) {
        try {
            this.apiRequestCount++;
            const response = await this.client.app.getFormFields({ app: appId });
            return response.properties;
        } catch (error) {
            console.error(`Failed to get fields for app ${appId}:`, error);
            throw error;
        }
    }

    // 全レコードの取得（getAllRecords使用）
    async getAllRecords(appId, options = {}) {
        try {
            const { fields, condition } = options;

            const params = {
                app: appId,
            };

            if (fields && fields.length > 0) {
                params.fields = fields;
            }

            if (condition) {
                params.condition = condition;
            }

            // getAllRecordsは内部でページネーションを処理
            this.apiRequestCount++;
            const records = await this.client.record.getAllRecords(params);

            // 実際のAPI呼び出し回数を概算（500レコード/回）
            const estimatedRequests = Math.ceil(records.length / 500);
            this.apiRequestCount += estimatedRequests - 1;

            return records;
        } catch (error) {
            console.error(`Failed to get records for app ${appId}:`, error);
            throw error;
        }
    }

    // 差分レコードの取得（更新日時でフィルタ）
    async getDifferentialRecords(appId, sinceDateTime, fields = null) {
        try {
            // ISO 8601形式に変換
            const condition = `更新日時 > "${sinceDateTime}"`;

            return await this.getAllRecords(appId, { fields, condition });
        } catch (error) {
            console.error(`Failed to get differential records for app ${appId}:`, error);
            throw error;
        }
    }

    // 添付ファイルのダウンロード
    async downloadFile(fileKey) {
        try {
            this.apiRequestCount++;
            const { domain, username, password, apiToken } = this.config;

            const auth = apiToken ? { headers: { 'X-Cybozu-API-Token': apiToken } } : { auth: { username, password } };

            const url = `https://${domain}/k/v1/file.json?fileKey=${fileKey}`;

            const response = await axios.get(url, {
                ...auth,
                responseType: 'arraybuffer',
            });

            return response.data;
        } catch (error) {
            console.error(`Failed to download file ${fileKey}:`, error);
            throw error;
        }
    }

    // レコードの追加/更新（復元用）
    async addRecords(appId, records) {
        try {
            this.apiRequestCount++;

            // 100件ずつバッチ処理
            const batchSize = 100;
            const results = [];

            for (let i = 0; i < records.length; i += batchSize) {
                const batch = records.slice(i, i + batchSize);
                const response = await this.client.record.addRecords({
                    app: appId,
                    records: batch,
                });
                results.push(...response.ids);

                if (i + batchSize < records.length) {
                    this.apiRequestCount++;
                }
            }

            return results;
        } catch (error) {
            console.error(`Failed to add records to app ${appId}:`, error);
            if (error.errors) {
                console.error('Detailed errors:', JSON.stringify(error.errors, null, 2));
            }
            throw error;
        }
    }

    async updateRecords(appId, records) {
        try {
            this.apiRequestCount++;

            // 100件ずつバッチ処理
            const batchSize = 100;

            for (let i = 0; i < records.length; i += batchSize) {
                const batch = records.slice(i, i + batchSize);
                await this.client.record.updateRecords({
                    app: appId,
                    records: batch,
                });

                if (i + batchSize < records.length) {
                    this.apiRequestCount++;
                }
            }

            return true;
        } catch (error) {
            console.error(`Failed to update records in app ${appId}:`, error);
            throw error;
        }
    }

    // バックアップ記録アプリへのログ記録
    async logToBackupApp(backupAppId, logData) {
        try {
            this.apiRequestCount++;

            const record = {
                backup_datetime: { value: logData.backup_datetime },
                target_app_id: { value: logData.target_app_id },
                target_app_name: { value: logData.target_app_name },
                record_count: { value: logData.record_count },
                status: { value: logData.status },
                duration_seconds: { value: logData.duration_seconds },
                error_details: { value: logData.error_details || '' },
                backup_type: { value: logData.backup_type },
                file_path: { value: logData.file_path || '' },
                trigger_type: { value: logData.trigger_type },
                diff_base_datetime: { value: logData.diff_base_datetime || '' },
                data_size_mb: { value: logData.data_size_mb },
                compression_ratio: { value: logData.compression_ratio },
                api_request_count: { value: logData.api_request_count },
                retry_count: { value: logData.retry_count },
                hostname: { value: logData.hostname },
                app_version: { value: logData.app_version },
                remarks: { value: logData.remarks || '' },
            };

            const response = await this.client.record.addRecord({
                app: backupAppId,
                record,
            });

            return response.id;
        } catch (error) {
            console.error('Failed to log to backup app:', error);
            // ログ記録失敗はエラーとして扱わない（処理は継続）
            return null;
        }
    }

    // API呼び出し回数のリセット
    resetCounters() {
        this.apiRequestCount = 0;
        this.retryCount = 0;
    }

    // 統計情報の取得
    getStats() {
        return {
            apiRequestCount: this.apiRequestCount,
            retryCount: this.retryCount,
        };
    }
    // レコード番号フィールドのフィールドコードをキャッシュ付きで取得
    async getRecordNumberFieldCode(appId) {
        try {
            if (this.recordNumberFieldCache[appId]) {
                return this.recordNumberFieldCache[appId];
            }

            const properties = await this.getFormFields(appId);
            for (const [fieldCode, prop] of Object.entries(properties)) {
                if (prop && prop.type && prop.type.toUpperCase() === 'RECORD_NUMBER') {
                    this.recordNumberFieldCache[appId] = fieldCode;
                    return fieldCode;
                }
            }

            this.recordNumberFieldCache[appId] = null;
            return null;
        } catch (error) {
            console.error(`Failed to determine record number field for app ${appId}:`, error);
            return null;
        }
    }

    async findRecordIdsByRecordNumbers(appId, recordNumbers) {
        const resultMap = {};
        for (const rn of recordNumbers) {
            resultMap[String(rn)] = null;
        }

        if (!recordNumbers || recordNumbers.length === 0) {
            return resultMap;
        }

        const fieldCode = await this.getRecordNumberFieldCode(appId);
        if (!fieldCode) {
            return resultMap;
        }

        const batchSize = 50;
        for (let i = 0; i < recordNumbers.length; i += batchSize) {
            const chunk = recordNumbers.slice(i, i + batchSize);
            const formattedValues = chunk.map((v) => {
                const s = String(v);
                return /^-?\d+(\.\d+)?$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
            });

            const query = `${fieldCode} in (${formattedValues.join(',')}) limit 500`;

            try {
                this.apiRequestCount++;
                const response = await this.client.record.getRecords({
                    app: appId,
                    query,
                    fields: [fieldCode, '$id'],
                });

                const records = response?.records || response;
                if (Array.isArray(records)) {
                    for (const rec of records) {
                        const rnValue = rec?.[fieldCode]?.value;
                        if (!rnValue) continue;

                        const idVal = rec?.['$id']?.value || rec?.['__ID__']?.value || rec?.id;
                        if (idVal) {
                            resultMap[String(rnValue)] = String(idVal);
                        }
                    }
                }
            } catch (innerErr) {
                console.error(`Failed to query record ids (batch ${i}):`, innerErr);
            }
        }

        return resultMap;
    }

    async addAllRecords(appId, records) {
        const ids = await this.addRecords(appId, records);
        return Array.isArray(ids) ? ids.map((id) => String(id)) : ids;
    }

    async updateAllRecords(appId, records) {
        return await this.updateRecords(appId, records);
    }
}

module.exports = KintoneClient;
