import { Filter, ObjectId } from 'mongodb';
import { Context } from '../context';
import { NotFoundError, PermissionError, PrivilegeError, ValidationError } from '../error';
import avatar from '../lib/avatar';
import { Logger } from '../logger';
import db from '../service/db';
import { PRIV } from './builtin';
import domain from './domain';
import message from './message';
import user from './user';

export type FeedbackSource = {
    type: 'problem';
    pid: number;
    tid?: ObjectId;
    title: string;
} | {
    type: 'lecture';
    tid: ObjectId;
    nodeId: number;
    title: string;
};

export interface FeedbackDoc {
    _id: ObjectId;
    domainId: string;
    reporter: number;
    source: FeedbackSource & { url: string };
    quote: string;
    createdAt: Date;
    updatedAt: Date;
}

const logger = new Logger('feedback');

class FeedbackModel {
    static coll = db.collection('feedback');
    static CONTENT_LIMIT = 2000;
    static QUOTE_LIMIT = 4000;

    static validateText(value: string, field = 'content', optional = false) {
        if (typeof value !== 'string') throw new ValidationError(field);
        const text = value.trim();
        const limit = field === 'quote' ? FeedbackModel.QUOTE_LIMIT : FeedbackModel.CONTENT_LIMIT;
        if (!text && !optional) throw new ValidationError(field);
        if (text.length > limit) throw new ValidationError(field, null, 'Feedback text is too long.');
        return text;
    }

    static sourceUrl(domainId: string, source: FeedbackSource) {
        const prefix = `/d/${encodeURIComponent(domainId)}`;
        if (source.type === 'lecture') return `${prefix}/course/${source.tid}/lecture/${source.nodeId}`;
        return `${prefix}/p/${source.pid}${source.tid ? `?tid=${source.tid}` : ''}`;
    }

    static async activeUser(uid: number) {
        // Read current privileges instead of retaining permissions from a cached user/session.
        const actor = await user.coll.findOne({ _id: uid }, { projection: { _id: 1, priv: 1 } });
        if (!actor || (actor.priv & PRIV.PRIV_USER_PROFILE) !== PRIV.PRIV_USER_PROFILE) {
            throw new PrivilegeError(PRIV.PRIV_USER_PROFILE);
        }
        return actor;
    }

    static async get(id: ObjectId) {
        const thread = await FeedbackModel.coll.findOne({ _id: id });
        if (!thread) throw new NotFoundError(id);
        return thread;
    }

    static async canAccess(thread: FeedbackDoc, uid: number) {
        const actor = await user.coll.findOne({ _id: uid }, { projection: { _id: 1, priv: 1 } });
        if (!actor || (actor.priv & PRIV.PRIV_USER_PROFILE) !== PRIV.PRIV_USER_PROFILE) return false;
        if (thread.reporter === uid || (actor.priv & PRIV.PRIV_EDIT_SYSTEM) === PRIV.PRIV_EDIT_SYSTEM) return true;
        return !!await domain.coll.findOne({ _id: thread.domainId, owner: uid }, { projection: { _id: 1 } });
    }

    static async recipients(thread: FeedbackDoc, from: number) {
        const ddoc = await domain.coll.findOne({ _id: thread.domainId }, { projection: { owner: 1 } });
        const participants = await user.coll.find({
            priv: { $bitsAllSet: PRIV.PRIV_USER_PROFILE },
            $or: [
                { _id: { $in: [thread.reporter, ddoc?.owner].filter((uid) => typeof uid === 'number') } },
                { priv: { $bitsAllSet: PRIV.PRIV_EDIT_SYSTEM } },
            ],
        }, { projection: { _id: 1 } }).toArray();
        return participants.map((actor) => actor._id).filter((uid) => uid !== from);
    }

    static async create(domainId: string, reporter: number, source: FeedbackSource, content: string, quote = '') {
        await FeedbackModel.activeUser(reporter);
        content = FeedbackModel.validateText(content);
        quote = FeedbackModel.validateText(quote, 'quote', true);
        const now = new Date();
        const thread: FeedbackDoc = {
            _id: new ObjectId(), domainId, reporter,
            source: { ...source, url: FeedbackModel.sourceUrl(domainId, source) },
            quote, createdAt: now, updatedAt: now,
        };
        const recipients = await FeedbackModel.recipients(thread, reporter);
        await FeedbackModel.coll.insertOne(thread);
        let mdoc;
        try {
            mdoc = await message.sendFeedback(reporter, recipients, content, thread._id, domainId);
        } catch (error) {
            // Only remove an empty thread; a notification error must never lose saved content.
            if (!await message.coll.findOne({ feedbackId: thread._id })) await FeedbackModel.coll.deleteOne({ _id: thread._id });
            throw error;
        }
        return { feedbackId: thread._id, mdoc };
    }

    static async reply(id: ObjectId, uid: number, content: string) {
        const thread = await FeedbackModel.get(id);
        if (!await FeedbackModel.canAccess(thread, uid)) throw new PermissionError();
        content = FeedbackModel.validateText(content);
        const recipients = await FeedbackModel.recipients(thread, uid);
        const mdoc = await message.sendFeedback(uid, recipients, content, thread._id, thread.domainId);
        await FeedbackModel.coll.updateOne({ _id: id }, { $max: { updatedAt: new Date() } })
            .catch((error) => logger.error(error));
        return { mdoc };
    }

    static async dialogue(thread: FeedbackDoc, uid: number, historyLimit = 1000) {
        if (!await FeedbackModel.canAccess(thread, uid)) throw new PermissionError();
        const messages = (await message.coll.find({ feedbackId: thread._id, domainId: thread.domainId })
            .sort('_id', -1).limit(historyLimit).toArray()).reverse();
        const uids = Array.from(new Set([thread.reporter, ...messages.map((mdoc) => mdoc.from)]));
        const profiles = await user.coll.find({ _id: { $in: uids } }, { projection: { _id: 1, uname: 1, avatar: 1, mail: 1 } }).toArray();
        const authors = Object.fromEntries(profiles.map((profile) => [profile._id, {
            _id: profile._id, uname: profile.uname,
            avatarUrl: avatar(profile.avatar || `gravatar:${profile.mail}`, 128),
        }]));
        return {
            _id: `feedback:${thread._id}`, kind: 'feedback', feedbackId: thread._id,
            domainId: thread.domainId, reporter: thread.reporter,
            source: thread.source, quote: thread.quote, updatedAt: thread.updatedAt,
            udoc: authors[thread.reporter] || { _id: thread.reporter, uname: `UID ${thread.reporter}`, avatarUrl: avatar('') },
            authors, messages, canReply: true,
        };
    }

    static async list(uid: number, selected?: ObjectId) {
        const actor = await FeedbackModel.activeUser(uid);
        let filter: Filter<FeedbackDoc> = {};
        if ((actor.priv & PRIV.PRIV_EDIT_SYSTEM) !== PRIV.PRIV_EDIT_SYSTEM) {
            const ownedDomains = await domain.coll.find({ owner: uid }, { projection: { _id: 1 } }).toArray();
            filter = { $or: [{ reporter: uid }, { domainId: { $in: ownedDomains.map((ddoc) => ddoc._id) } }] };
        }
        const threads = await FeedbackModel.coll.find(filter).sort('updatedAt', -1).limit(100).toArray();
        if (selected && !threads.some((thread) => thread._id.equals(selected))) threads.unshift(await FeedbackModel.get(selected));
        return Promise.all(threads.map((thread) => FeedbackModel.dialogue(thread, uid, selected?.equals(thread._id) ? 1000 : 50)));
    }
}

export async function apply(ctx: Context) {
    // Domain IDs can be reused; their private conversations must be deleted with the domain.
    ctx.on('domain/delete', (domainId) => Promise.all([
        FeedbackModel.coll.deleteMany({ domainId }),
        message.coll.deleteMany({ domainId, feedbackId: { $exists: true } }),
    ]));
    return db.ensureIndexes(
        FeedbackModel.coll,
        { key: { reporter: 1, updatedAt: -1 }, name: 'reporter' },
        { key: { domainId: 1, updatedAt: -1 }, name: 'domain' },
        { key: { updatedAt: -1 }, name: 'updated' },
    );
}

export default FeedbackModel;
global.Hydro.model.feedback = FeedbackModel;
