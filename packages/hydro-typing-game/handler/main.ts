import { Handler } from 'hydrooj/src/handler';
import * as TypingModel from '../model/typing';

export default class TypingMainHandler extends Handler {
    async get() {
        const stats = await TypingModel.getUserStats(this.user._id, this.domain._id);
        const recentRecords = await TypingModel.getRecords(
            this.domain._id,
            this.user._id,
            undefined,
            10,
        );
        const topPlayers = await TypingModel.getRankings(this.domain._id, 'score', 10);
        
        this.response.template = 'typing_main.html';
        this.response.body = {
            stats,
            recentRecords,
            topPlayers,
            practiceTypes: Object.keys(TypingModel.PRACTICE_CONTENT),
        };
    }
}