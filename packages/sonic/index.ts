import {
    Ingest, PushOptions, QueryOptions,
    Search, SuggestOptions,
} from 'sonic-channel';
import * as nodejieba from 'nodejieba';
import {
    Context, iterateAllProblem, iterateAllProblemInDomain,
    Logger, ProblemModel, Schema, Service, SystemModel,
} from 'hydrooj';

// HydroOJ 的 Context 在运行时会被各个插件扩展；这里显式声明
// `ctx.sonic` 的存在，方便 TypeScript 在其他模块中引用该服务。
declare module 'hydrooj' {
    interface Context {
        sonic?: SonicService;
    }
}

const logger = new Logger('sonic');
const chineseCharRegex = /[\u4e00-\u9fff]/;

function segmentTokens(text: string) {
    if (!text || !chineseCharRegex.test(text)) return null;
    try {
        return nodejieba.cutForSearch(text);
    } catch (error) {
        logger.warn('Failed to segment Chinese text for Sonic, fallback to raw text.', error);
        return null;
    }
}

function segmentText(text: string) {
    const words = segmentTokens(text);
    return words?.length ? words.join(' ') : text;
}

function segmentQuery(text: string) {
    const words = segmentTokens(text);
    if (!words?.length) return text;
    const filtered = words.filter((word: string) => word.length > 1);
    return (filtered.length ? filtered : words).join(' ');
}

function buildTitleText(pid: string, title: string, tag?: string[]) {
    const raw = `${pid || ''} ${title} ${tag?.join(' ') ?? ''}`.trim();
    return segmentText(raw);
}

// Sonic Channel 客户端会在连接/断线等状态回调此 handler；
// 由于 Hydro addon 生命周期通常需要把状态写入日志，因此统一封装在一个函数里。
function getHandler(type: string, that: any) {
    return {
        connected() {
            logger.info(`Sonic Channel succeeded to connect to host (${type}).`);
        },
        disconnected() {
            logger.error(`Sonic Channel is now disconnected (${type}).`);
        },
        timeout() {
            logger.error(`Sonic Channel connection timed out (${type}).`);
        },
        retrying() {
            logger.error(`Trying to reconnect to Sonic Channel (${type})...`);
        },
        error(error) {
            that.error = error;
            logger.error(`Sonic Channel failed to connect to host (${type}).`, error);
        },
    };
}

// Hydro addon 的核心逻辑通常放在 Service 类里，
// 通过 ctx.plugin(SonicService) 注入后，Cordis 会管理其生命周期。
export class SonicService extends Service {
    public search: Search;
    public ingest: Ingest;
    public error = '';

    // Schema 用于自动生成系统设置和校验；
    // HydroOJ 会读取 `export const Config = SonicService.Config` 自动注册配置项。
    static Config = Schema.object({
        host: Schema.string().default('::1'),
        port: Schema.number().default(1491),
        auth: Schema.string().default(''),
        maxQueryLimit: Schema.number().default(100),
    });

    constructor(ctx: Context, private config: ReturnType<typeof SonicService.Config>) {
        // 第二个参数是 Service 名称，便于调试和热重载。
        super(ctx, 'sonic');
    }

    *[Context.init]() {
        // Hydro addon 在 ctx.plugin 时会执行 Context.init 生成器：
        // 1) 在 generator 启动阶段做资源初始化；
        // 2) yield 出的函数会在插件卸载/重启时依次调用，实现清理逻辑。
        this.search = new Search(this.config);
        this.ingest = new Ingest(this.config);
        this.search.connect(getHandler('search', this));
        yield () => this.search.close();
        this.ingest.connect(getHandler('ingest', this));
        yield () => this.ingest.close();
        // 监听题目增删改事件，同步数据到 Sonic。
        yield this.ctx.on('problem/add', async (doc, docId) => {
            const titleText = buildTitleText(doc.pid || '', doc.title, doc.tag);
            const contentText = segmentText(doc.content.toString());
            Promise.all([
                this.push('problem', `${doc.domainId}@title`, `${doc.domainId}/${docId}`, titleText),
                this.push('problem', `${doc.domainId}@content`, `${doc.domainId}/${docId}`, contentText),
                this.push('problem', 'global@title', `${doc.domainId}/${docId}`, titleText),
                this.push('problem', 'global@content', `${doc.domainId}/${docId}`, contentText),
            ]).catch((e) => logger.error(e));
        });
        yield this.ctx.on('problem/edit', async (pdoc) => {
            const id = `${pdoc.domainId}/${pdoc.docId}`;
            const titleText = buildTitleText(pdoc.pid || '', pdoc.title, pdoc.tag);
            const contentText = segmentText(pdoc.content.toString());
            Promise.all([
                this.flusho('problem', `${pdoc.domainId}@title`, id)
                    .then(() => this.push('problem', `${pdoc.domainId}@title`, id, titleText)),
                this.flusho('problem', `${pdoc.domainId}@content`, id)
                    .then(() => this.push('problem', `${pdoc.domainId}@content`, id, contentText)),
                this.flusho('problem', 'global@title', id)
                    .then(() => this.push('problem', 'global@title', id, titleText)),
                this.flusho('problem', 'global@content', id)
                    .then(() => this.push('problem', 'global@content', id, contentText)),
            ]).catch((e) => logger.error(e));
        });
        yield this.ctx.on('problem/delete', async (domainId, docId) => {
            const id = `${domainId}/${docId}`;
            await Promise.all([
                this.flusho('problem', `${domainId}@title`, id),
                this.flusho('problem', `${domainId}@content`, id),
                this.flusho('problem', 'global@title', id),
                this.flusho('problem', 'global@content', id),
            ]);
        });
        // 向 HydroOJ 注册 problemSearch 模块；
        // 其他核心模块调用 `global.Hydro.module.problemSearch` 时会落到这里。
        yield this.ctx.provideModule('problemSearch', 'sonic', async (domainId, query, opts) => {
            const maxQueryLimit = this.config.maxQueryLimit;
            const limit = Math.min(opts?.limit || SystemModel.get('pagination.problem'), maxQueryLimit);
            const scope = opts?.scope ?? 'all';
            const bucketPrefix = domainId === '*' ? 'global' : domainId;
            const terms = segmentQuery(query);
            logger.debug('problemSearch: domain=%s bucket=%s scope=%s limit=%d skip=%d query=%s terms=%s',
                domainId,
                bucketPrefix,
                scope,
                limit,
                opts?.skip || 0,
                query,
                terms,
            );
            let hits = await this.query('problem', `${bucketPrefix}@title`, terms, { limit });
            if (!opts.skip) {
                if (domainId !== '*') {
                    let pdoc = await ProblemModel.get(domainId, +query || query, ProblemModel.PROJECTION_LIST);
                    if (pdoc) {
                        hits = hits.filter((i) => i !== `${pdoc.domainId}/${pdoc.docId}`);
                        hits.unshift(`${pdoc.domainId}/${pdoc.docId}`);
                    } else if (/^P\d+$/.test(query)) {
                        pdoc = await ProblemModel.get(domainId, +query.substring(1), ProblemModel.PROJECTION_LIST);
                        if (pdoc) hits.unshift(`${pdoc.domainId}/${pdoc.docId}`);
                    }
                }
            }
            if (scope === 'all' && limit - hits.length > 0) {
                hits.push(...await this.query('problem', `${bucketPrefix}@content`, terms, { limit: limit - hits.length }));
            }
            return {
                countRelation: hits.length >= limit ? 'gte' : 'eq',
                total: hits.length,
                hits,
            };
        });
        yield this.ctx.addScript(
            'ensureSonicSearch', 'Sonic problem search re-index',
            Schema.object({
                domainId: Schema.string(),
            }),
            async ({ domainId }, report) => {
                if (domainId) await this.flushb('problem', domainId);
                else await this.flushc('problem');
                let i = 0;
                const cb = async (pdoc) => {
                    i++;
                    if (!(i % 1000)) report({ message: `${i} problems indexed` });
                    const titleText = buildTitleText(pdoc.pid || '', pdoc.title, pdoc.tag);
                    const contentText = segmentText(pdoc.content.toString());
                    await Promise.all([
                        pdoc.title && this.push(
                            'problem', `${pdoc.domainId}@title`, `${pdoc.domainId}/${pdoc.docId}`,
                            titleText,
                        ),
                        pdoc.content.toString()
                        && this.push('problem', `${pdoc.domainId}@content`, `${pdoc.domainId}/${pdoc.docId}`, contentText),
                        pdoc.title && this.push(
                            'problem', 'global@title', `${pdoc.domainId}/${pdoc.docId}`,
                            titleText,
                        ),
                        pdoc.content.toString()
                        && this.push('problem', 'global@content', `${pdoc.domainId}/${pdoc.docId}`, contentText),
                    ]).catch((e) => console.log(`${pdoc.domainId}/${pdoc.docId}`, e));
                };
                if (domainId) await iterateAllProblemInDomain(domainId, ['title', 'content'], cb);
                else await iterateAllProblem(['title', 'content', 'tag'], cb);
                return true;
            },
        );

        this.ctx.i18n.load('zh', {
            'Sonic problem search re-index': '重建题目搜索索引。',
        });
    }

    // 以下封装了 sonic-channel 的常用指令，方便在其他 Hydro 模块中复用。
    async query(collection: string, bucket: string, terms: string, options?: QueryOptions) {
        return await this.search.query(collection, bucket, terms, options);
    }

    async suggest(collection: string, bucket: string, word: string, options?: SuggestOptions) {
        return await this.search.suggest(collection, bucket, word, options);
    }

    async push(collection: string, bucket: string, object: string, text: string, options?: PushOptions) {
        return await this.ingest.push(collection, bucket, object, text, options);
    }

    async pop(collection: string, bucket: string, object: string, text: string) {
        return await this.ingest.pop(collection, bucket, object, text);
    }

    async count(collection: string, bucket?: string, object?: string) {
        return await this.ingest.count(collection, bucket, object);
    }

    async flusho(collection: string, bucket: string, object: string) {
        return await this.ingest.flusho(collection, bucket, object);
    }

    async flushb(collection: string, bucket: string) {
        return await this.ingest.flushb(collection, bucket);
    }

    async flushc(collection: string) {
        return await this.ingest.flushc(collection);
    }
}

export const Config = SonicService.Config;

// 每个 Hydro addon 必须导出 apply(ctx, config) 供 loader 调用；
// ctx.plugin 会实例化 Service 并自动注入配置。
export function apply(ctx: Context, config: ReturnType<typeof SonicService.Config>) {
    ctx.plugin(SonicService, config);
}
