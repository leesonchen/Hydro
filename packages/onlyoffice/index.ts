import { sign } from 'jsonwebtoken';
import { } from '@hydrooj/ui-default/backendlib/markdown-it-media';
import {
    Context, Handler, PRIV, Schema, superagent, SystemModel, UiContextBase, ValidationError,
} from 'hydrooj';

declare module 'hydrooj' {
    interface UiContextBase {
        onlyofficeApi?: string;
    }
}

class OnlyofficeJWTHandler extends Handler {
    notUsage = true;

    async get({ url }) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const secret = SystemModel.get('onlyoffice.jwtsecret');
        if (!secret || secret === 'secret') throw new ValidationError('onlyoffice.jwtsecret');
        let documentUrl: URL;
        if (SystemModel.get('onlyoffice.externalSign')) {
            documentUrl = this.validateDocumentUrl(url);
            const res = await superagent.get(SystemModel.get('onlyoffice.externalSign')).query({ url: documentUrl.toString() });
            this.response.body = res.body;
            return;
        }
        try {
            documentUrl = this.validateDocumentUrl(url);
        } catch (e) {
            if (e instanceof ValidationError) throw e;
            throw new ValidationError('url');
        }
        const path = documentUrl.pathname;
        const allowDownload = !!SystemModel.get('onlyoffice.allowDownload');
        const payload = {
            document: {
                fileType: path.split('.').pop(),
                key: Math.random().toString(36).substring(2),
                title: decodeURIComponent(path.split('/').pop()),
                url: documentUrl.toString(),
                permissions: {
                    comment: false,
                    copy: allowDownload,
                    download: allowDownload,
                    edit: false,
                    fillForms: false,
                    modifyContentControl: false,
                    modifyFilter: false,
                    print: allowDownload,
                    protect: false,
                    review: false,
                },
            },
            editorConfig: {
                lang: this.user.viewLang?.includes('_') ? this.user.viewLang.split('_')[0] : this.user.viewLang || 'zh',
                mode: 'view',
                user: {
                    group: 'Hydro',
                    id: this.user._id.toString(),
                    name: this.user.uname,
                },
                customization: {
                    chat: false,
                    comments: false,
                    help: false,
                    hideRulers: true,
                    plugins: false,
                },
            },
        };
        const token = sign(payload, secret);
        this.response.body = {
            ...payload,
            token,
        };
    }

    private validateDocumentUrl(input: string) {
        const serverUrl = SystemModel.get('server.url');
        let server: URL;
        let documentUrl: URL;
        try {
            server = new URL(serverUrl);
            documentUrl = new URL(input);
        } catch {
            throw new ValidationError('url');
        }
        if (!['http:', 'https:'].includes(documentUrl.protocol)) throw new ValidationError('url');
        const origins = new Set([server.origin]);
        for (const host of this.domain.host || []) {
            try {
                origins.add(new URL(/^https?:\/\//i.test(host) ? host : `${server.protocol}//${host}`).origin);
            } catch {
                // Ignore malformed administrator-configured host aliases.
            }
        }
        if (!origins.has(documentUrl.origin)) throw new ValidationError('url');
        return documentUrl;
    }
}

export function apply(ctx: Context) {
    ctx.inject(['i18n'], (c) => {
        c.i18n.load('en', {
            'onlyoffice.not_configured': 'Onlyoffice API not configured.',
            'onlyoffice.initialize_fail': 'Failed to initialize onlyoffice: {0}',
        });
        c.i18n.load('zh', {
            'onlyoffice.not_configured': 'Onlyoffice 未配置。自行安装 onlyoffice 软件或是使用外部提供的 API。',
            'onlyoffice.initialize_fail': '初始化 onlyoffice 失败: {0}',
        });
    });

    ctx.Route('onlyoffice-jwt', '/onlyoffice-jwt', OnlyofficeJWTHandler);
    if (SystemModel.get('onlyoffice.pdf')) {
        ctx.provideModule('richmedia', 'pdf', {
            get(service, src, md) {
                return `<div data-${service}>${md.utils.escapeHtml(src)}</div>`;
            },
        });
    }
    ctx.setting.SystemSetting(Schema.object({
        onlyoffice: Schema.object({
            api: Schema.string().description('OnlyOffice API URL').role('url').default('https://documentserver/web-apps/apps/api/documents/api.js'),
            jwtsecret: Schema.string().role('secret').description('JWT Secret').default(''),
            pdf: Schema.boolean().description('Handle pdf documents').default(false),
            externalSign: Schema.string().description('External Sign URL').default(''),
        }),
    }));
    Object.defineProperty(UiContextBase, 'onlyofficeApi', {
        configurable: true,
        enumerable: true,
        get() {
            return SystemModel.get('onlyoffice.api');
        },
    });
    return () => {
        Object.defineProperty(UiContextBase, 'onlyofficeApi', {
            enumerable: false,
        });
    };
}
