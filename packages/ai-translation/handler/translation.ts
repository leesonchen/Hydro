import { Handler, ProblemModel as problem, ProblemNotFoundError, param, route, Types } from 'hydrooj';
import { TranslationService } from '../service/translation';

export class ProblemTranslationHandler extends Handler {
    translationService: TranslationService;

    async prepare() {
        this.translationService = this.ctx.get('translation');
    }

    @route('pid', Types.ProblemId)
    async get(domainId: string, pid: string | number) {
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, pid);
        
        // 解析现有内容
        let content: Record<string, string> = {};
        try {
            content = JSON.parse(pdoc.content);
        } catch {
            content = { zh: pdoc.content };
        }

        this.response.template = 'translation_panel.html';
        this.response.body = {
            pdoc,
            hasAiTranslation: !!content.ai,
            aiContent: content.ai || '',
            sourceContent: content.zh || content.en || pdoc.content,
        };
    }

    @param('pid', Types.ProblemId)
    @param('force', Types.Boolean, true)
    async postTranslate(domainId: string, pid: string | number, force = false) {
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, pid);

        // 检查缓存
        if (!force) {
            let content: Record<string, string> = {};
            try {
                content = JSON.parse(pdoc.content);
            } catch {
                content = { zh: pdoc.content };
            }
            if (content.ai) {
                return this.response.body = { 
                    status: 'completed', 
                    content: content.ai,
                    cached: true 
                };
            }
        }

        try {
            // 准备内容（包含图片OCR）
            const sourceContent = this.extractSourceContent(pdoc);
            const additionalFiles = pdoc.additional_file || [];
            
            // 调用翻译服务
            const translatedContent = await this.translationService.translate(
                sourceContent,
                additionalFiles,
                domainId,
                pdoc.docId
            );

            // 保存翻译结果
            await this.saveTranslation(domainId, pdoc.docId, translatedContent, this.user._id);

            this.response.body = {
                status: 'completed',
                content: translatedContent,
                cached: false,
            };
        } catch (err: any) {
            this.response.body = {
                status: 'failed',
                error: err.message,
            };
        }
    }

    @param('pid', Types.ProblemId)
    async getStatus(domainId: string, pid: string | number) {
        const pdoc = await problem.get(domainId, pid);
        if (!pdoc) throw new ProblemNotFoundError(domainId, pid);

        let content: Record<string, string> = {};
        try {
            content = JSON.parse(pdoc.content);
        } catch {
            content = { zh: pdoc.content };
        }

        this.response.body = {
            hasTranslation: !!content.ai,
            content: content.ai || null,
        };
    }

    private extractSourceContent(pdoc: any): string {
        let content: Record<string, string> = {};
        try {
            content = JSON.parse(pdoc.content);
        } catch {
            content = { zh: pdoc.content };
        }
        // 优先使用中文，其次是英文，最后是原始内容
        return content.zh || content.en || pdoc.content || '';
    }

    private async saveTranslation(domainId: string, docId: number, aiContent: string, editor: number): Promise<void> {
        const pdoc = await problem.get(domainId, docId);
        if (!pdoc) throw new ProblemNotFoundError(domainId, docId);

        let content: Record<string, string> = {};
        try {
            content = JSON.parse(pdoc.content);
        } catch {
            content = { zh: pdoc.content };
        }

        content.ai = aiContent;
        await problem.edit(domainId, docId, {
            content: JSON.stringify(content),
            editor,
            updateAt: new Date(),
        });
    }
}
