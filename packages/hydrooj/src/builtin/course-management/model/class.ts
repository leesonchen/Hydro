import {
    db, NotFoundError, ObjectId, ValidationError,
} from '../../../plugin-api';
import { deleteUserCache } from '../../../model/user';

const coll = db.collection('user.group');
const CLASS_EDIT_LOCK_TIMEOUT_MS = 30 * 60 * 1000;

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
    invitationTokenId?: string | null;
    classEditLock?: {
        token: string;
        expiresAt: Date;
    };
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

    async acquireEditLock(domainId: string, id: ObjectId, expectedName: string, token: string) {
        const now = new Date();
        return await coll.updateOne(
            {
                domainId,
                _id: id,
                class: true,
                name: expectedName,
                $or: [
                    { classEditLock: { $exists: false } },
                    { 'classEditLock.expiresAt': { $lte: now } },
                ],
            },
            {
                $set: {
                    classEditLock: {
                        token,
                        expiresAt: new Date(now.getTime() + CLASS_EDIT_LOCK_TIMEOUT_MS),
                    },
                },
            },
        );
    },

    async refreshEditLock(domainId: string, id: ObjectId, token: string) {
        return await coll.updateOne(
            { domainId, _id: id, class: true, 'classEditLock.token': token },
            { $set: { 'classEditLock.expiresAt': new Date(Date.now() + CLASS_EDIT_LOCK_TIMEOUT_MS) } },
        );
    },

    async releaseEditLock(domainId: string, id: ObjectId, token: string) {
        return await coll.updateOne(
            { domainId, _id: id, class: true, 'classEditLock.token': token },
            { $unset: { classEditLock: '' } },
        );
    },

    async delGroup(domainId: string, id: ObjectId) {
        const doc = await coll.findOne({ domainId, _id: id, class: true });
        if (!doc) throw new NotFoundError('Group not found');
        deleteUserCache(domainId);
        return coll.deleteOne({ domainId, _id: id });
    },

    async renameGroup(domainId: string, id: ObjectId, expectedName: string, name: string, editToken: string) {
        deleteUserCache(domainId);
        return coll.updateOne(
            {
                domainId,
                _id: id,
                class: true,
                name: expectedName,
                'classEditLock.token': editToken,
            },
            { $set: { name } },
        );
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
        id?: ObjectId,
        revokeInvitation = false,
        expectedName?: string,
        editToken?: string,
    ) {
        deleteUserCache(domainId);
        const $set: Partial<ClassGDoc> = {
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
        };
        if (revokeInvitation) $set.invitationTokenId = null;
        const updatingExisting = !!id && expectedName !== undefined;
        try {
            return await coll.updateOne(
                id
                    ? {
                        domainId,
                        _id: id,
                        class: true,
                        ...(updatingExisting ? {
                            name: expectedName,
                            ...(editToken
                                ? { 'classEditLock.token': editToken }
                                : { classEditLock: { $exists: false } }),
                        } : {}),
                    }
                    : { domainId, name, class: true },
                { $set },
                { upsert: !updatingExisting },
            );
        } catch (error) {
            if ((error as { code?: number }).code === 11000) throw new ValidationError('name');
            throw error;
        }
    },
};
