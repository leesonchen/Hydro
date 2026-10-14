import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { BadRequestError } from '../error';
import db from '../service/db';

export type MonitorEventType = 'page_hidden' | 'page_visible' | 'window_blur' | 'window_focus'
    | 'fullscreen_exit' | 'fullscreen_enter' | 'paste_detected' | 'clipboard_blocked' | 'drop_blocked' | 'page_leave' | 'heartbeat';

export const monitorEventTypes: MonitorEventType[] = [
    'page_hidden', 'page_visible', 'window_blur', 'window_focus',
    'fullscreen_exit', 'fullscreen_enter', 'paste_detected', 'clipboard_blocked', 'drop_blocked', 'page_leave', 'heartbeat',
];
export const retentionMs = 90 * 24 * 60 * 60 * 1000;
// A short upload-only grace period; it never extends the allowed answer window.
export const monitorUploadGraceMs = 30 * 60 * 1000;

interface MonitorKey {
    domainId: string;
    contestTid: ObjectId;
    uid: number;
    sessionId: string;
}

export interface MonitorEvent extends MonitorKey {
    _id: ObjectId;
    pageInstanceId: string;
    sequence: number;
    eventType: MonitorEventType;
    serverAt: Date;
    clientAt?: Date;
    expiresAt: Date;
    processedAt?: Date;
    receivedAfterEnd?: boolean;
}

interface PendingTransition {
    eventId: ObjectId;
}

export interface MonitorSession extends MonitorKey {
    _id: ObjectId;
    revision: number;
    lastSeenAt: Date;
    expiresAt: Date;
    lastEventType?: MonitorEventType;
    pendingEvent?: PendingTransition;
}

declare module '../service/db' {
    interface Collections {
        'contest.monitor': MonitorEvent;
        'contest.monitor.sessions': MonitorSession;
    }
}

export const events = db.collection('contest.monitor');
export const sessions = db.collection('contest.monitor.sessions');

/** Commit the durable session journal before acknowledging its corresponding event. */
async function finishTransition(session: MonitorSession) {
    const pending = session.pendingEvent;
    if (!pending) return;
    await events.updateOne({ _id: pending.eventId }, { $set: { processedAt: new Date() } });
    await sessions.updateOne({ _id: session._id, 'pendingEvent.eventId': pending.eventId }, {
        $unset: { pendingEvent: '' }, $inc: { revision: 1 },
    });
}

/** A one-entry journal and revision CAS make retries recoverable on standalone MongoDB. */
export async function recordEvent(input: Omit<MonitorEvent, '_id' | 'serverAt' | 'expiresAt' | 'processedAt'>) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + retentionMs);
    const key: MonitorKey = {
        domainId: input.domainId, contestTid: input.contestTid, uid: input.uid, sessionId: input.sessionId,
    };
    try {
        await sessions.updateOne(key, {
            $setOnInsert: { revision: 0 }, $max: { lastSeenAt: now, expiresAt },
        }, { upsert: true });
    } catch (error) {
        if (error.code !== 11000) throw error;
        await sessions.updateOne(key, { $max: { lastSeenAt: now, expiresAt } });
    }
    // Heartbeats have bounded storage and never replace a pending state transition.
    if (input.eventType === 'heartbeat') return;

    const eventKey = { ...key, pageInstanceId: input.pageInstanceId, sequence: input.sequence };
    let event: MonitorEvent;
    try {
        event = await events.findOneAndUpdate(eventKey, {
            $setOnInsert: { ...input, serverAt: now, expiresAt },
        }, { upsert: true, returnDocument: 'after' });
    } catch (error) {
        if (error.code !== 11000) throw error;
        event = await events.findOne(eventKey);
    }
    if (!event || event.eventType !== input.eventType) throw new BadRequestError('Conflicting monitoring event');

    for (let attempt = 0; attempt < 32; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        const session = await sessions.findOne(key);
        if (session.pendingEvent) {
            // Any worker can recover an interrupted transition before applying the next one.
            // eslint-disable-next-line no-await-in-loop
            await finishTransition(session);
            continue;
        }
        // Re-read after the session snapshot: another worker may have committed this event.
        // eslint-disable-next-line no-await-in-loop
        const current = await events.findOne({ _id: event._id });
        if (current.processedAt) return;
        // Keep reliable event transitions, not untrustworthy wall-clock durations.
        const fields: Partial<MonitorSession> = { lastEventType: event.eventType, pendingEvent: { eventId: event._id } };
        // eslint-disable-next-line no-await-in-loop
        await sessions.updateOne({ _id: session._id, revision: session.revision, pendingEvent: { $exists: false } }, {
            $set: fields, $inc: { revision: 1 }, $unset: { hiddenSince: '', blurSince: '' },
        });
    }
    throw new BadRequestError('Monitoring session is busy; retry the event');
}

export async function initializeMonitor(ctx: Context) {
    ctx.on('domain/delete', (domainId) => Promise.all([
        events.deleteMany({ domainId }), sessions.deleteMany({ domainId }),
    ]));
    ctx.on('contest/del', (domainId, tid) => Promise.all([
        events.deleteMany({ domainId, contestTid: tid }), sessions.deleteMany({ domainId, contestTid: tid }),
    ]));
    await ctx.db.ensureIndexes(events,
        { key: { domainId: 1, contestTid: 1, uid: 1, sessionId: 1, pageInstanceId: 1, sequence: 1 }, name: 'monitorDedupe', unique: true },
        { key: { domainId: 1, contestTid: 1, serverAt: -1 }, name: 'monitorListing' },
        { key: { expiresAt: 1 }, name: 'monitorEventsExpire', expireAfterSeconds: 0 },
    );
    await ctx.db.ensureIndexes(sessions,
        { key: { domainId: 1, contestTid: 1, uid: 1, sessionId: 1 }, name: 'monitorSession', unique: true },
        { key: { domainId: 1, contestTid: 1, lastSeenAt: -1 }, name: 'monitorLiveSessions' },
        { key: { expiresAt: 1 }, name: 'monitorSessionsExpire', expireAfterSeconds: 0 },
    );
}
