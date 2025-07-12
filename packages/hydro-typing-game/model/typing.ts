import { ObjectId } from 'mongodb';
import { db } from 'hydrooj/src/service/db';

export interface TypingRecord {
    _id?: ObjectId;
    uid: number;
    domainId: string;
    mode: 'practice' | 'contest';
    type: string;
    contestId?: ObjectId;
    wpm: number;
    accuracy: number;
    duration: number;
    charCount: number;
    errorCount: number;
    score: number;
    text?: string;
    createdAt: Date;
}

export interface TypingContest {
    _id?: ObjectId;
    domainId: string;
    owner: number;
    title: string;
    content: string;
    type: 'time' | 'count';
    limit: number;
    startAt: Date;
    endAt: Date;
    participants: number[];
    status: 'pending' | 'running' | 'finished';
}

export interface TypingUserStats {
    _id: string; // uid@domainId
    uid: number;
    domainId: string;
    totalScore: number;
    bestWpm: number;
    avgWpm: number;
    avgAccuracy: number;
    practiceCount: number;
    contestCount: number;
    achievements: string[];
    lastActiveAt: Date;
}

const coll = {
    record: db.collection<TypingRecord>('typing.record'),
    contest: db.collection<TypingContest>('typing.contest'),
    stats: db.collection<TypingUserStats>('typing.stats'),
};

// 创建索引
async function ensureIndexes() {
    await coll.record.createIndex({ uid: 1, domainId: 1, createdAt: -1 });
    await coll.record.createIndex({ contestId: 1, score: -1 });
    await coll.contest.createIndex({ domainId: 1, status: 1, startAt: -1 });
    await coll.stats.createIndex({ domainId: 1, totalScore: -1 });
    await coll.stats.createIndex({ domainId: 1, bestWpm: -1 });
}

ensureIndexes().catch(() => { /* Ignore index creation errors */ });

export async function addRecord(record: TypingRecord): Promise<ObjectId> {
    const res = await coll.record.insertOne({
        ...record,
        createdAt: new Date(),
    });
    
    // 更新用户统计
    await updateUserStats(record.uid, record.domainId, record);
    
    return res.insertedId;
}

export async function getRecords(
    domainId: string,
    uid?: number,
    mode?: 'practice' | 'contest',
    limit = 50,
): Promise<TypingRecord[]> {
    const query: any = { domainId };
    if (uid !== undefined) query.uid = uid;
    if (mode) query.mode = mode;
    
    return await coll.record
        .find(query)
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
}

export async function createContest(contest: Omit<TypingContest, '_id'>): Promise<ObjectId> {
    const res = await coll.contest.insertOne({
        ...contest,
        participants: [],
        status: 'pending',
    });
    return res.insertedId;
}

export async function getContest(id: ObjectId): Promise<TypingContest | null> {
    return await coll.contest.findOne({ _id: id });
}

export async function getContests(
    domainId: string,
    status?: 'pending' | 'running' | 'finished',
): Promise<TypingContest[]> {
    const query: any = { domainId };
    if (status) query.status = status;
    
    return await coll.contest
        .find(query)
        .sort({ startAt: -1 })
        .toArray();
}

export async function joinContest(contestId: ObjectId, uid: number): Promise<void> {
    await coll.contest.updateOne(
        { _id: contestId },
        { $addToSet: { participants: uid } },
    );
}

export async function getUserStats(
    uid: number,
    domainId: string,
): Promise<TypingUserStats | null> {
    const _id = `${uid}@${domainId}`;
    return await coll.stats.findOne({ _id });
}

export async function updateUserStats(
    uid: number,
    domainId: string,
    record: TypingRecord,
): Promise<void> {
    const _id = `${uid}@${domainId}`;
    const stats = await getUserStats(uid, domainId);
    
    if (!stats) {
        // 创建新统计
        await coll.stats.insertOne({
            _id,
            uid,
            domainId,
            totalScore: record.score,
            bestWpm: record.wpm,
            avgWpm: record.wpm,
            avgAccuracy: record.accuracy,
            practiceCount: record.mode === 'practice' ? 1 : 0,
            contestCount: record.mode === 'contest' ? 1 : 0,
            achievements: [],
            lastActiveAt: new Date(),
        });
    } else {
        // 更新统计
        const totalCount = stats.practiceCount + stats.contestCount + 1;
        const newAvgWpm = (stats.avgWpm * (totalCount - 1) + record.wpm) / totalCount;
        const newAvgAccuracy = (stats.avgAccuracy * (totalCount - 1) + record.accuracy) / totalCount;
        
        const update: any = {
            $inc: {
                totalScore: record.score,
            },
            $set: {
                avgWpm: newAvgWpm,
                avgAccuracy: newAvgAccuracy,
                lastActiveAt: new Date(),
            },
        };
        
        if (record.wpm > stats.bestWpm) {
            update.$set.bestWpm = record.wpm;
        }
        
        if (record.mode === 'practice') {
            update.$inc.practiceCount = 1;
        } else {
            update.$inc.contestCount = 1;
        }
        
        await coll.stats.updateOne({ _id }, update);
    }
}

export async function getRankings(
    domainId: string,
    type: 'score' | 'wpm' | 'accuracy',
    limit = 50,
): Promise<TypingUserStats[]> {
    const sortField = type === 'score' ? 'totalScore' : type === 'wpm' ? 'bestWpm' : 'avgAccuracy';
    
    return await coll.stats
        .find({ domainId })
        .sort({ [sortField]: -1 })
        .limit(limit)
        .toArray();
}

// 练习内容模板
export const PRACTICE_CONTENT = {
    basic: {
        name: 'Basic Keys',
        levels: [
            'asdf jkl; asdf jkl; asdf jkl;',
            'asdfjkl; ;lkjfdsa asdfjkl;',
            'asdfg hjkl; asdfg hjkl;',
            'qwert yuiop qwert yuiop',
            'zxcvb nm,./ zxcvb nm,./',
        ],
    },
    letters: {
        name: 'Letters',
        levels: [
            'abcd efgh ijkl mnop qrst uvwx yz',
            'The quick brown fox jumps over the lazy dog',
            'Pack my box with five dozen liquor jugs',
            'How vexingly quick daft zebras jump',
            'The five boxing wizards jump quickly',
        ],
    },
    words: {
        name: 'Words',
        levels: [
            'function variable constant parameter return',
            'if else while for loop break continue',
            'class object method property interface',
            'array list map set queue stack tree',
            'async await promise callback closure',
        ],
    },
    code: {
        name: 'Code',
        levels: [
            'const sum = (a, b) => a + b;',
            'for (let i = 0; i < arr.length; i++) { }',
            'class Person { constructor(name) { this.name = name; } }',
            'async function fetchData() { return await api.get("/data"); }',
            'const result = items.filter(x => x > 0).map(x => x * 2);',
        ],
    },
};