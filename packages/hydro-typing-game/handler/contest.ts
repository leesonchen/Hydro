import { ObjectId } from 'mongodb';
import { Handler, param, Types } from 'hydrooj/src/handler';
import { NotFoundError, PermissionError } from 'hydrooj/src/error';
import * as TypingModel from '../model/typing';

export default class TypingContestHandler extends Handler {
    async get() {
        const runningContests = await TypingModel.getContests(this.domain._id, 'running');
        const upcomingContests = await TypingModel.getContests(this.domain._id, 'pending');
        const finishedContests = await TypingModel.getContests(this.domain._id, 'finished');
        
        this.response.template = 'typing_contest.html';
        this.response.body = {
            runningContests,
            upcomingContests,
            finishedContests,
        };
    }
}

export class ContestCreateHandler extends Handler {
    async get() {
        this.response.template = 'typing_contest_create.html';
    }
    
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('type', Types.String)
    @param('limit', Types.Int)
    @param('startAt', Types.Date)
    @param('endAt', Types.Date)
    async post(
        domainId: string,
        title: string,
        content: string,
        type: 'time' | 'count',
        limit: number,
        startAt: Date,
        endAt: Date,
    ) {
        if (type !== 'time' && type !== 'count') {
            throw new BadRequestError('Invalid contest type');
        }
        
        const contestId = await TypingModel.createContest({
            domainId,
            owner: this.user._id,
            title,
            content,
            type,
            limit,
            startAt,
            endAt,
        });
        
        this.response.redirect = this.url('typing_contest_detail', { cid: contestId });
    }
}

export class ContestDetailHandler extends Handler {
    @param('cid', Types.ObjectId)
    async get(domainId: string, cid: ObjectId) {
        const contest = await TypingModel.getContest(cid);
        if (!contest || contest.domainId !== domainId) {
            throw new NotFoundError('Contest not found');
        }
        
        // 获取比赛记录和排名
        const records = await TypingModel.getRecords(domainId, undefined, 'contest', 100);
        const contestRecords = records.filter(r => r.contestId?.equals(cid));
        
        // 按分数排序
        contestRecords.sort((a, b) => b.score - a.score);
        
        // 检查用户是否已参加
        const userRecord = contestRecords.find(r => r.uid === this.user._id);
        const hasJoined = contest.participants.includes(this.user._id);
        
        this.response.template = 'typing_contest_detail.html';
        this.response.body = {
            contest,
            records: contestRecords,
            userRecord,
            hasJoined,
            canJoin: contest.status === 'running' && !hasJoined,
        };
    }
    
    @param('cid', Types.ObjectId)
    async postJoin(domainId: string, cid: ObjectId) {
        const contest = await TypingModel.getContest(cid);
        if (!contest || contest.domainId !== domainId) {
            throw new NotFoundError('Contest not found');
        }
        
        if (contest.status !== 'running') {
            throw new PermissionError('Contest is not running');
        }
        
        await TypingModel.joinContest(cid, this.user._id);
        this.response.redirect = this.url('typing_contest_detail', { cid });
    }
    
    @param('cid', Types.ObjectId)
    @param('wpm', Types.Float)
    @param('accuracy', Types.Float)
    @param('duration', Types.Int)
    @param('charCount', Types.Int)
    @param('errorCount', Types.Int)
    async postSubmit(
        domainId: string,
        cid: ObjectId,
        wpm: number,
        accuracy: number,
        duration: number,
        charCount: number,
        errorCount: number,
    ) {
        const contest = await TypingModel.getContest(cid);
        if (!contest || contest.domainId !== domainId) {
            throw new NotFoundError('Contest not found');
        }
        
        if (contest.status !== 'running') {
            throw new PermissionError('Contest is not running');
        }
        
        if (!contest.participants.includes(this.user._id)) {
            throw new PermissionError('You have not joined this contest');
        }
        
        // 计算得分
        const score = Math.floor(wpm * accuracy * 10);
        
        // 保存记录
        const recordId = await TypingModel.addRecord({
            uid: this.user._id,
            domainId,
            mode: 'contest',
            type: contest.type,
            contestId: cid,
            wpm,
            accuracy,
            duration,
            charCount,
            errorCount,
            score,
            text: contest.content,
            createdAt: new Date(),
        });
        
        this.response.body = {
            success: true,
            recordId: recordId.toString(),
            score,
        };
    }
}