import { db, NotFoundError, ObjectId } from '../../../plugin-api';
import { deleteUserCache } from '../../../model/user';

const coll = db.collection('user.group');

export interface ClassGDoc {
    _id: ObjectId;
    domainId: string;
    name: string;
    teachers: number[];
    students: number[];
    uids: number[];
    beginAt: Date;
    endAt: Date;
    intervalDays?: number;
    archive: boolean;
    class: true;
}

export const ClassModel = {
    async listGroup(domainId: string, uid?: number): Promise<ClassGDoc[]> {
        const query = typeof uid === 'number'
            ? { domainId, uids: uid, class: true }
            : { domainId, class: true };
        const docs = await coll.find(query).toArray() as ClassGDoc[];
        if (uid) {
            docs.push({
                _id: new ObjectId(),
                domainId,
                uids: [uid],
                name: uid.toString(),
                teachers: [],
                students: [uid],
                beginAt: new Date(),
                endAt: new Date(),
                archive: false,
                class: true,
            });
        }
        return docs;
    },

    async getGroupById(domainId: string, id: ObjectId): Promise<ClassGDoc | null> {
        return await coll.findOne({ domainId, _id: id, class: true }) as ClassGDoc | null;
    },

    async getGroupByName(domainId: string, name: string): Promise<ClassGDoc | null> {
        return await coll.findOne({ domainId, name, class: true }) as ClassGDoc | null;
    },

    async delGroup(domainId: string, id: ObjectId) {
        const doc = await coll.findOne({ domainId, _id: id, class: true });
        if (!doc) throw new NotFoundError('Group not found');
        deleteUserCache(domainId);
        return coll.deleteOne({ domainId, _id: id });
    },

    async updateGroup(
        domainId: string,
        name: string,
        teachers: number[],
        students: number[],
        beginAt: Date,
        endAt: Date,
        archive = false,
        intervalDays = 1,
    ) {
        deleteUserCache(domainId);
        return coll.updateOne(
            { domainId, name },
            {
                $set: {
                    domainId,
                    name,
                    uids: [...teachers, ...students],
                    students,
                    teachers,
                    class: true as const,
                    beginAt,
                    endAt,
                    intervalDays,
                    archive,
                },
            },
            { upsert: true },
        );
    },
};
