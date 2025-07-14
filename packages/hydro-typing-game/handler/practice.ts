import { Handler, param, Types } from 'hydrooj';
import { BadRequestError } from 'hydrooj/src/error';
import * as TypingModel from '../model/typing';

export default class TypingPracticeHandler extends Handler {
    @param('mode', Types.String)
    async get(domainId: string, mode: string) {
        const practiceContent = TypingModel.PRACTICE_CONTENT[mode];
        if (!practiceContent) {
            throw new BadRequestError('Invalid practice mode');
        }
        
        this.response.template = 'typing_practice.html';
        this.response.body = {
            mode,
            practiceContent,
            userStats: await TypingModel.getUserStats(this.user._id, domainId),
        };
    }
    
    @param('mode', Types.String)
    @param('level', Types.Int)
    @param('wpm', Types.Float)
    @param('accuracy', Types.Float)
    @param('duration', Types.Int)
    @param('charCount', Types.Int)
    @param('errorCount', Types.Int)
    async post(
        domainId: string,
        mode: string,
        level: number,
        wpm: number,
        accuracy: number,
        duration: number,
        charCount: number,
        errorCount: number,
    ) {
        // 计算得分
        const score = Math.floor(wpm * accuracy * 10);
        
        // 保存记录
        const recordId = await TypingModel.addRecord({
            uid: this.user._id,
            domainId,
            mode: 'practice',
            type: `${mode}-${level}`,
            wpm,
            accuracy,
            duration,
            charCount,
            errorCount,
            score,
            createdAt: new Date(),
        });
        
        // 返回结果
        this.response.body = {
            success: true,
            recordId: recordId.toString(),
            score,
            stats: await TypingModel.getUserStats(this.user._id, domainId),
        };
    }
}