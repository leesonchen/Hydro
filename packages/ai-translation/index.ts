import Schema from 'schemastery';
import {
    Context, Handler, PERM, param, post, route, Types,
} from 'hydrooj';
import { ProblemTranslationHandler } from './handler/translation';
import { TranslationService } from './service/translation';

export const name = 'ai-translation';

export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    apiEndpoint: Schema.string().default('https://api.openai.com/v1'),
    apiKey: Schema.string().default(''),
    model: Schema.string().default('gpt-4o-mini'),
    maxTokens: Schema.number().default(4000),
    temperature: Schema.number().default(0.3),
    cacheHours: Schema.number().default(24),
});

export async function apply(ctx: Context, config: any) {
    if (!config.enabled) return;

    // 注册翻译服务
    ctx.plugin(TranslationService, config);

    // i18n 翻译
    ctx.i18n.load('zh', {
        ai_translate: 'AI翻译',
        ai_translation: 'AI题目翻译',
        translate_problem: '翻译题目',
        translation_status: '翻译状态',
        translate_with_ai: '使用AI翻译',
        ai_translated: 'AI已翻译',
        regenerate_translation: '重新生成',
        translation_in_progress: '翻译中...',
        translation_failed: '翻译失败',
        translation_completed: '翻译完成',
        no_api_key_configured: '未配置API密钥',
        translation_error: '翻译出错：{0}',
    });

    ctx.i18n.load('en', {
        ai_translate: 'AI Translate',
        ai_translation: 'AI Problem Translation',
        translate_problem: 'Translate Problem',
        translation_status: 'Translation Status',
        translate_with_ai: 'Translate with AI',
        ai_translated: 'AI Translated',
        regenerate_translation: 'Regenerate',
        translation_in_progress: 'Translating...',
        translation_failed: 'Translation Failed',
        no_api_key_configured: 'API key not configured',
        translation_error: 'Translation error: {0}',
    });

    // 注册权限
    ctx.addPermission(
        PERM.PERM_VIEW_PROBLEM,
        PERM.PERM_EDIT_PROBLEM,
    );

    // 注册路由
    ctx.Route('problem_translate', '/p/:pid/translate', ProblemTranslationHandler);
    ctx.Route('api_translation_status', '/api/translation/status', ProblemTranslationHandler);
    ctx.Route('api_translation_translate', '/api/translation/translate', ProblemTranslationHandler);

    // 注入题目详情页翻译面板
    ctx.on('handler/after/ProblemDetailHandler', async (h) => {
        h.response.body.aiTranslationPanel = await h.renderHTML('translation_panel.html', {
            pdoc: h.response.body.pdoc,
        });
    });
}
