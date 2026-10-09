import { Collection, Document, ObjectId } from 'mongodb';
import { ActivityMetadata, PracticeSubmission } from './episodes';

export interface RatingDatabase { collection<T extends Document = Document>(name: string): Collection<T> }
export const MAX_RECORDS = 200000;
export const RECORD_PROJECTION = Object.freeze({ _id: 1, domainId: 1, pid: 1, uid: 1, status: 1, judgeAt: 1, contest: 1, practiceContest: 1 });

export interface CapturedInput {
    scope: string;
    asOf: number;
    capturedAt: number;
    records: PracticeSubmission[];
    activities: ActivityMetadata[];
}

/** Reads individual records, never contest journals/status caches or source code. */
export async function capturePracticeInput(
    database: RatingDatabase, scope: string, excludedUids: readonly number[] = [], cutoff?: number,
): Promise<CapturedInput> {
    const capturedAt = Date.now();
    const asOf = cutoff ?? capturedAt;
    if (!scope || !Number.isSafeInteger(asOf) || asOf < 0 || asOf > capturedAt
        || excludedUids.some((uid) => !Number.isSafeInteger(uid) || uid <= 0)) throw new RangeError('Invalid scope, cutoff or excluded account');
    if (!await database.collection('domain').findOne({ _id: scope as any }, { projection: { _id: 1 } })) throw new Error('Unknown domain');
    // ObjectIds have second precision. Include that second, then let the extractor
    // apply the exact cutoff. Do not restrict the start date: it would reset t0.
    const until = ObjectId.createFromTime(Math.floor(asOf / 1000) + 1);
    const cursor = database.collection('record').find({ domainId: scope, _id: { $lt: until } }, { projection: RECORD_PROJECTION })
        .sort({ _id: 1 }).batchSize(1000).limit(MAX_RECORDS + 1).maxTimeMS(120000);
    const records: PracticeSubmission[] = [];
    try {
        for await (const doc of cursor) {
            if (records.length === MAX_RECORDS) throw new Error('Domain record limit exceeded; no truncated fit is allowed');
            records.push({
                id: doc._id.toHexString(), domainId: doc.domainId, pid: doc.pid, uid: doc.uid,
                submittedAt: doc._id.getTimestamp().getTime(), status: doc.status,
                judgeAt: doc.judgeAt instanceof Date ? doc.judgeAt.getTime() : doc.judgeAt == null ? null : NaN,
                contest: doc.contest?.toHexString() ?? null,
                practiceContest: doc.practiceContest?.toHexString() ?? null,
            });
        }
    } finally {
        await cursor.close();
    }
    const virtualAccounts = await database.collection('vuser').find(
        { _id: { $in: [...new Set(records.map((r) => r.uid))] } as any }, { projection: { _id: 1 } },
    ).toArray();
    const virtualUids = new Set(virtualAccounts.map((u) => u._id as unknown as number));
    const excluded = new Set(excludedUids);
    for (const record of records) {
        if (virtualUids.has(record.uid) || excluded.has(record.uid) || record.uid === 1) {
            record.metadata = {
                knownAt: capturedAt,
                exclusion: virtualUids.has(record.uid) ? 'team_aggregate' : record.uid === 1 ? 'service_account' : 'test_account',
            };
        }
    }
    const ids = [...new Set(records.flatMap((r) => [r.contest, r.practiceContest]).filter(Boolean))].map((id) => new ObjectId(id));
    // 30 is document.TYPE_CONTEST; importing the model here would initialize Hydro.
    const activities = (await database.collection('document').find(
        { domainId: scope, docType: 30, docId: { $in: ids } }, { projection: { docId: 1, rule: 1 } },
    ).toArray()).map((doc) => ({ domainId: scope, id: doc.docId.toHexString(), rule: doc.rule, knownAt: capturedAt }));
    return { scope, asOf, capturedAt, records, activities };
}
