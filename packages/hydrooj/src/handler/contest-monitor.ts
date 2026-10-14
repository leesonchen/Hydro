import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { ContestNotAttendedError, ContestNotFoundError, ForbiddenError, ValidationError } from '../error';
import { assertCourseAssessmentAccess } from '../lib/course-assessment-access';
import { PERM } from '../model/builtin';
import * as contest from '../model/contest';
import {
    events, initializeMonitor, monitorUploadGraceMs, MonitorEventType, monitorEventTypes, recordEvent, retentionMs, sessions,
} from '../model/contestMonitor';
import { Handler, param, Types } from '../service/server';

export class ContestMonitorHandler extends Handler {
    @param('tid', Types.ObjectId)
    async get(domainId: string, tid: ObjectId) {
        const tdoc = await contest.get(domainId, tid);
        if (tdoc.monitorMode !== 'browser') throw new ContestNotFoundError(domainId, tid);
        if (!this.user.own(tdoc) && !this.user.hasPerm(PERM.PERM_EDIT_CONTEST)) throw new ForbiddenError();
        const [eventDocs, sessionDocs] = await Promise.all([
            events.find({ domainId, contestTid: tid, eventType: { $ne: 'heartbeat' } }).sort({ serverAt: -1 }).limit(500).toArray(),
            sessions.find({ domainId, contestTid: tid, lastSeenAt: { $gte: new Date(Date.now() - 60000) } })
                .sort({ lastSeenAt: -1 }).limit(500).toArray(),
        ]);
        this.response.body = { tdoc, events: eventDocs, sessions: sessionDocs, page_name: 'contest_monitor' };
        this.response.template = 'contest_monitor.html';
    }

    @param('tid', Types.ObjectId)
    @param('eventType', Types.String)
    @param('sessionId', Types.String)
    @param('pageInstanceId', Types.String)
    @param('sequence', Types.Int)
    @param('clientAt', Types.Float, true)
    async post(domainId: string, tid: ObjectId, eventType: string, sessionId: string, pageInstanceId: string, sequence: number, clientAt?: number) {
        const tdoc = await contest.get(domainId, tid);
        if (tdoc.monitorMode !== 'browser') throw new ContestNotFoundError(domainId, tid);
        await assertCourseAssessmentAccess(this.user, tdoc);
        if (!contest.canAccessAssignedContest(this.user, tdoc)) throw new ForbiddenError();
        if (!monitorEventTypes.includes(eventType as MonitorEventType)) throw new ValidationError('eventType');
        if (!/^[a-zA-Z0-9-]{10,100}$/.test(sessionId)
            || !/^[a-zA-Z0-9-]{10,100}$/.test(pageInstanceId)
            || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 10000000) {
            throw new ValidationError('sessionId');
        }
        const team = tdoc.allowTeam ? await contest.getTeamVid(domainId, tid, this.user._id) : undefined;
        const status = await contest.getStatus(domainId, tid, team ?? this.user._id);
        if (!status?.attend) throw new ContestNotAttendedError(domainId, tid);
        const now = Date.now();
        const personalEnd = tdoc.duration && status.startAt instanceof Date
            ? status.startAt.getTime() + tdoc.duration * 3600000 : Infinity;
        const eventEnd = Math.min(tdoc.endAt.getTime(), status.endAt instanceof Date ? status.endAt.getTime() : Infinity, personalEnd);
        const eventStart = Math.max(tdoc.beginAt.getTime(), status.startAt instanceof Date ? status.startAt.getTime() : -Infinity);
        const receivedAfterEnd = !contest.isOngoing(tdoc, status);
        // Uploading existing monitor events must never reopen the answer window.
        if (receivedAfterEnd && (now < eventEnd || now > eventEnd + monitorUploadGraceMs)) {
            throw new ForbiddenError('Exam is not active');
        }
        await this.limitRate('contest_monitor', 60, 150);
        // Client clocks are advisory only. Late evidence is marked and never trusted as proof.
        const validClientAt = Number.isFinite(clientAt) && clientAt <= now + 60000 && clientAt >= now - retentionMs;
        if (receivedAfterEnd && (eventType === 'heartbeat' || !validClientAt
            || clientAt < eventStart || clientAt >= eventEnd)) {
            this.response.body = { ok: true, accepted: false };
            return;
        }
        await recordEvent({
            domainId, contestTid: tid, uid: this.user._id, sessionId, pageInstanceId, sequence,
            eventType: eventType as MonitorEventType,
            ...(validClientAt ? { clientAt: new Date(clientAt) } : {}),
            ...(receivedAfterEnd ? { receivedAfterEnd: true } : {}),
        });
        this.response.body = { ok: true, accepted: true };
    }
}

export async function apply(ctx: Context) {
    await initializeMonitor(ctx);
}
