import fs from 'fs';
import path from 'path';
import { Context, Logger, Service } from 'hydrooj';

declare module 'cordis' {
    interface Context {
        translation: TranslationService;
    }
}

const logger = new Logger('ai-translation');

interface TranslationConfig {
    apiEndpoint: string;
    apiKey: string;
    model: string;
    maxTokens: number;
    temperature: number;
}

interface AdditionalFile {
    name: string;
    size?: number;
}

export class TranslationService extends Service {
    private config: TranslationConfig;

    constructor(ctx: Context, config: TranslationConfig) {
        super(ctx, 'translation');
        this.config = config;
    }

    /**
     * 翻译题目描述，支持图片OCR
     * @param content Markdown格式的题目描述
     * @param additionalFiles 附件文件列表（图片等）
     * @param domainId 域ID
     * @param docId 题目ID
     * @returns 翻译后的纯文本Markdown
     */
    async translate(
        content: string,
        additionalFiles: AdditionalFile[],
        domainId: string,
        docId: number
    ): Promise<string> {
        if (!this.config.apiKey) {
            throw new Error('API key not configured');
        }

        // 提取内容中的图片引用
        const imageRefs = this.extractImageReferences(content);
        
        // 构建消息
        const messages = await this.buildMessages(content, imageRefs, additionalFiles, domainId, docId);

        // 调用OpenAI兼容API
        const response = await this.callOpenAIAPI(messages);

        return response;
    }

    /**
     * 提取Markdown中的图片引用
     */
    private extractImageReferences(content: string): Array<{ alt: string; url: string }> {
        const regex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        const matches: Array<{ alt: string; url: string }> = [];
        let match;
        while ((match = regex.exec(content)) !== null) {
            matches.push({ alt: match[1], url: match[2] });
        }
        return matches;
    }

    /**
     * 构建OpenAI API消息
     */
    private async buildMessages(
        content: string,
        imageRefs: Array<{ alt: string; url: string }>,
        additionalFiles: AdditionalFile[],
        domainId: string,
        docId: number
    ): Promise<any[]> {
        const messages: any[] = [];

        // 系统提示词
        messages.push({
            role: 'system',
            content: `你是一个专业的OI/ACM题目描述翻译助手。你的任务是将题目描述翻译成清晰、准确的纯文本Markdown格式。

要求：
1. 保留所有数学公式（LaTeX格式）
2. 保留所有代码块的格式和内容
3. 对于图片：使用OCR识别内容并描述，保留图片引用
4. 输入输出格式要清晰标注
5. 样例输入输出要完整保留
6. 只返回翻译后的题目描述，不要其他解释`
        });

        // 处理内容中的图片
        let processedContent = content;
        const imageContents: any[] = [];

        for (const imgRef of imageRefs) {
            const fileName = imgRef.url.replace('file://', '').split('?')[0];
            const file = additionalFiles.find(f => f.name === fileName || f.name === decodeURIComponent(fileName));
            
            if (file && this.isImageFile(file.name)) {
                // 尝试读取图片文件
                try {
                    const imageData = await this.readImageFile(domainId, docId, file.name);
                    if (imageData) {
                        imageContents.push({
                            type: 'image_url',
                            image_url: {
                                url: `data:image/${this.getImageFormat(file.name)};base64,${imageData}`
                            }
                        });
                        // 在原内容位置添加标记
                        processedContent = processedContent.replace(
                            `![${imgRef.alt}](${imgRef.url})`,
                            `[图片: ${imgRef.alt || fileName}]`
                        );
                    }
                } catch (err) {
                    logger.warn(`Failed to read image ${fileName}:`, err);
                }
            }
        }

        // 构建用户消息
        const userContent: any[] = [
            { type: 'text', text: `请翻译以下题目描述为中文（如果原文是中文则优化格式）：\n\n${processedContent}` }
        ];

        // 添加图片（如果模型支持视觉）
        if (imageContents.length > 0 && this.supportsVision()) {
            userContent.push(...imageContents);
        }

        messages.push({
            role: 'user',
            content: userContent
        });

        return messages;
    }

    /**
     * 判断是否为图片文件
     */
    private isImageFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
    }

    /**
     * 获取图片格式
     */
    private getImageFormat(filename: string): string {
        const ext = path.extname(filename).toLowerCase();
        const formatMap: Record<string, string> = {
            '.png': 'png',
            '.jpg': 'jpeg',
            '.jpeg': 'jpeg',
            '.gif': 'gif',
            '.webp': 'webp',
            '.bmp': 'bmp'
        };
        return formatMap[ext] || 'png';
    }

    /**
     * 读取图片文件为base64
     */
    private async readImageFile(domainId: string, docId: number, fileName: string): Promise<string | null> {
        // 图片文件路径：/data/problem_additional_file/{domainId}/{docId}/{fileName}
        const filePath = path.join(process.cwd(), 'data', 'problem_additional_file', domainId, docId.toString(), fileName);
        
        try {
            if (!fs.existsSync(filePath)) {
                // 尝试其他路径格式
                const altPath = path.join(process.cwd(), 'data', 'problem_additional_file', domainId, fileName);
                if (fs.existsSync(altPath)) {
                    const buffer = fs.readFileSync(altPath);
                    return buffer.toString('base64');
                }
                return null;
            }
            const buffer = fs.readFileSync(filePath);
            return buffer.toString('base64');
        } catch (err) {
            logger.warn(`Failed to read image from ${filePath}:`, err);
            return null;
        }
    }

    /**
     * 判断是否支持视觉（多模态）
     */
    private supportsVision(): boolean {
        const visionModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-vision', 'claude-3', 'gemini'];
        return visionModels.some(m => this.config.model.toLowerCase().includes(m.toLowerCase()));
    }

    /**
     * 调用OpenAI兼容API
     */
    private async callOpenAIAPI(messages: any[]): Promise<string> {
        const url = `${this.config.apiEndpoint}/chat/completions`;
        
        const body = {
            model: this.config.model,
            messages,
            max_tokens: this.config.maxTokens,
            temperature: this.config.temperature,
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.apiKey}`,
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const error = await response.text();
                throw new Error(`API request failed: ${response.status} - ${error}`);
            }

            const data = await response.json();
            
            if (!data.choices || data.choices.length === 0) {
                throw new Error('No response from AI');
            }

            return data.choices[0].message.content || '';
        } catch (err: any) {
            logger.error('Translation API error:', err);
            throw new Error(`Translation failed: ${err.message}`);
        }
    }
}
