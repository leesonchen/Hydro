import {
    Context, Filter, Handler, Logger, ObjectId, PRIV, Schema,
} from 'hydrooj';

export const name = 'url-audit';

const logger = new Logger('url-audit');
const DEFAULT_COLLECTION = 'url.audit';
const MASKED = '[masked]';
const PAGE_SIZE = 50;

interface UrlAuditDoc {
    _id?: ObjectId;
    time: Date;
    expireAt: Date;
    uid: number;
    uname: string;
    domainId: string;
    method: string;
    path: string;
    querystring: string;
    url: string;
    status: number;
    ms: number;
    ip: string;
    ua: string;
    referer: string;
    route: string;
    json: boolean;
}

let coll: any;

function parseList(value: string) {
    return `${value || ''}`
        .split(/[,\n]/)
        .map((i) => i.trim())
        .filter(Boolean);
}

function parseMethodSet(value: string) {
    return new Set(parseList(value).map((i) => i.toUpperCase()));
}

function parseLowerSet(value: string) {
    return new Set(parseList(value).map((i) => i.toLowerCase()));
}

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePathForFilter(path: string) {
    return path.replace(/^\/d\/[^/]+(?=\/)/, '');
}

function shouldIgnorePath(path: string, prefixes: string[], extensions: Set<string>) {
    const normalized = normalizePathForFilter(path);
    if (prefixes.some((prefix) => normalized.startsWith(prefix))) return true;
    const lower = normalized.toLowerCase();
    return [...extensions].some((ext) => lower.endsWith(ext));
}

function maskQueryString(querystring: string, maskKeys: Set<string>) {
    if (!querystring) return '';
    const params = new URLSearchParams(querystring);
    const masked = new URLSearchParams();
    for (const [key, value] of params) {
        masked.append(key, maskKeys.has(key.toLowerCase()) ? MASKED : value);
    }
    return masked.toString();
}

function getPath(c: any) {
    const request = c.HydroContext?.request;
    return c.originalPath || request?.originalPath || request?.path || c.request?.path || c.path || '';
}

function getQueryString(c: any) {
    return c.HydroContext?.request?.querystring || c.request?.querystring || c.querystring || '';
}

function getUser(c: any) {
    return c.HydroContext?.user || c.handler?.user;
}

function getStatus(c: any) {
    const request = c.HydroContext?.request;
    const response = c.HydroContext?.response || c.handler?.response;
    if (response?.status) return response.status;
    if (response?.redirect && !request?.json) return 302;
    if (c.status && c.status !== 404) return c.status;
    if (response?.body || response?.template || response?.redirect) return 200;
    return c.status || 200;
}

function getRoute(c: any) {
    const name = c.handler?.constructor?.name || '';
    return name.replace(/Handler$/, '');
}

function parsePage(value: any) {
    const page = Math.floor(+value || 1);
    return page > 0 ? page : 1;
}

function parseDateInput(value: any) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function toDateInputValue(date: Date | null) {
    if (!date) return '';
    const pad = (value: number) => value.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildFilter(args: Record<string, any>) {
    const filter: Filter<UrlAuditDoc> = {};
    const user = `${args.user || ''}`.trim();
    const url = `${args.url || ''}`.trim();
    const startAt = parseDateInput(args.startAt);
    const endAt = parseDateInput(args.endAt);

    if (user) {
        if (/^\d+$/.test(user)) filter.uid = +user;
        else filter.uname = { $regex: escapeRegExp(user), $options: 'i' } as any;
    }
    if (url) filter.url = { $regex: escapeRegExp(url), $options: 'i' } as any;
    if (startAt || endAt) {
        filter.time = {} as any;
        if (startAt) (filter.time as any).$gte = startAt;
        if (endAt) (filter.time as any).$lte = endAt;
    }
    return {
        filter,
        filters: {
            user,
            url,
            startAt: toDateInputValue(startAt),
            endAt: toDateInputValue(endAt),
        },
    };
}

function buildPageQuery(args: Record<string, any>, page: number) {
    const query = new URLSearchParams();
    for (const key of ['user', 'url', 'startAt', 'endAt']) {
        const value = `${args[key] || ''}`.trim();
        if (value) query.set(key, value);
    }
    query.set('page', page.toString());
    return `?${query.toString()}`;
}

class UrlAuditManageHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    async get(args: Record<string, any>) {
        const page = parsePage(args.page);
        const { filter, filters } = buildFilter(args);
        const [total, docs] = await Promise.all([
            coll.countDocuments(filter),
            coll.find(filter).sort({ time: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).toArray(),
        ]);
        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        this.response.template = 'manage_url_audit.html';
        this.response.body = {
            docs,
            filters,
            page,
            pageSize: PAGE_SIZE,
            total,
            totalPages,
            prevQuery: page > 1 ? buildPageQuery(args, page - 1) : '',
            nextQuery: page < totalPages ? buildPageQuery(args, page + 1) : '',
        };
    }
}

export const Config = Schema.object({
    enabled: Schema.boolean().default(true).description('Enable HTTP URL audit logging'),
    collection: Schema.string().default(DEFAULT_COLLECTION).description('MongoDB collection name'),
    retentionDays: Schema.number().default(30).min(1).description('Days to keep audit records'),
    includeAnonymous: Schema.boolean().default(false).description('Also record guest user requests'),
    methods: Schema.string().default('GET,POST,PUT,PATCH,DELETE').description('HTTP methods to record, comma-separated'),
    ignorePrefixes: Schema.string().role('textarea')
        .default('/fs/,/public/,/components/,/favicon.ico')
        .description('Path prefixes to ignore, comma- or newline-separated'),
    ignoreExtensions: Schema.string().role('textarea')
        .default('.js,.css,.map,.png,.jpg,.jpeg,.gif,.svg,.ico,.webp,.woff,.woff2')
        .description('Path suffixes to ignore, comma- or newline-separated'),
    maskQueryKeys: Schema.string().role('textarea')
        .default('sid,token,code,password,verifyPassword,authnChallenge,tfa,secret,apiKey,key')
        .description('Query keys to mask before saving, comma- or newline-separated'),
}).description('URL audit logging');

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
    if (process.env.HYDRO_CLI) return;
    ctx.i18n.load('zh', {
        manage_url_audit: 'URL 审计',
        'URL Audit': 'URL 审计',
        'Query URL Audit': '查询 URL 审计',
        'UID or Username': 'UID 或用户名',
        'URL contains': 'URL 包含',
        'Start Time': '开始时间',
        'End Time': '结束时间',
        Columns: '列显示',
        Route: '路由',
        'Response Time': '响应时间',
        'No audit records found.': '没有找到审计记录。',
    });
    await ctx.inject(['server', 'db'], async ({ server, db }) => {
        const collectionName = config.collection || DEFAULT_COLLECTION;
        coll = db.db.collection<UrlAuditDoc>(collectionName);
        await db.ensureIndexes(
            coll,
            { name: 'uid_time', key: { uid: 1, time: -1 } },
            { name: 'domain_time', key: { domainId: 1, time: -1 } },
            { name: 'expire', key: { expireAt: 1 }, expireAfterSeconds: 0 },
        );

        const methods = parseMethodSet(config.methods);
        const ignorePrefixes = parseList(config.ignorePrefixes);
        const ignoreExtensions = parseLowerSet(config.ignoreExtensions);
        const maskQueryKeys = parseLowerSet(config.maskQueryKeys);

        server.addHandlerLayer('url-audit', async (c, next) => {
            const start = Date.now();
            try {
                await next();
            } finally {
                try {
                    if (!config.enabled || c.nolog || c.response?.headers?.nolog) return;

                    const request = c.HydroContext?.request;
                    if (request?.websocket) return;

                    const method = (c.request?.method || request?.method || '').toUpperCase();
                    if (!methods.has(method)) return;

                    const path = getPath(c);
                    if (shouldIgnorePath(path, ignorePrefixes, ignoreExtensions)) return;

                    const user = getUser(c);
                    const uid = Number(user?._id || 0);
                    if (!config.includeAnonymous && !uid) return;

                    const querystring = maskQueryString(getQueryString(c), maskQueryKeys);
                    const now = new Date();
                    await coll.insertOne({
                        time: now,
                        expireAt: new Date(now.getTime() + config.retentionDays * 24 * 60 * 60 * 1000),
                        uid,
                        uname: (user?.uname || 'Guest').toString(),
                        domainId: c.HydroContext?.domain?._id || c.HydroContext?.args?.domainId || 'system',
                        method,
                        path,
                        querystring,
                        url: `${path}${querystring ? `?${querystring}` : ''}`,
                        status: getStatus(c),
                        ms: Date.now() - start,
                        ip: request?.ip || c.request?.ip || '',
                        ua: (request?.headers?.['user-agent'] || c.request?.headers?.['user-agent'] || '').toString(),
                        referer: (request?.referer || c.request?.headers?.referer || '').toString(),
                        route: getRoute(c),
                        json: !!request?.json,
                    });
                } catch (error) {
                    logger.warn('Failed to write URL audit log: %s', error?.message || error);
                }
            }
        });
        ctx.Route('manage_url_audit', '/manage/url-audit', UrlAuditManageHandler, PRIV.PRIV_EDIT_SYSTEM);
        ctx.injectUI('ControlPanel', 'manage_url_audit', { icon: 'search' }, PRIV.PRIV_EDIT_SYSTEM);
    });
}
