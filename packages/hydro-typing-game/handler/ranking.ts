import { Handler, param, Types } from 'hydrooj';
import * as TypingModel from '../model/typing';
import UserModel from 'hydrooj/src/model/user';

export default class TypingRankingHandler extends Handler {
    @param('type', Types.String, true)
    async get(domainId: string, type: string = 'score') {
        if (!['score', 'wpm', 'accuracy'].includes(type)) {
            type = 'score';
        }
        
        const rankings = await TypingModel.getRankings(domainId, type as any, 100);
        
        // 获取用户信息
        const uids = rankings.map(r => r.uid);
        const users = await UserModel.getMulti(domainId, { _id: { $in: uids } }).toArray();
        const userMap = Object.fromEntries(users.map(u => [u._id, u]));
        
        // 添加用户信息到排名
        const rankingsWithUser = rankings.map((rank, index) => ({
            ...rank,
            rank: index + 1,
            user: userMap[rank.uid],
        }));
        
        // 获取当前用户的排名
        const userStats = await TypingModel.getUserStats(this.user._id, domainId);
        let userRank = null;
        if (userStats) {
            const allRankings = await TypingModel.getRankings(domainId, type as any, 1000);
            const userIndex = allRankings.findIndex(r => r.uid === this.user._id);
            if (userIndex !== -1) {
                userRank = {
                    ...userStats,
                    rank: userIndex + 1,
                    user: this.user,
                };
            }
        }
        
        this.response.template = 'typing_ranking.html';
        this.response.body = {
            rankings: rankingsWithUser,
            userRank,
            type,
            types: [
                { value: 'score', name: 'Total Score' },
                { value: 'wpm', name: 'Best WPM' },
                { value: 'accuracy', name: 'Average Accuracy' },
            ],
        };
    }
}