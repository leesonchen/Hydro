import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { BadRequestError, ForbiddenError, NotFoundError } from '../error';
import {
    FeedbackConflictError, FeedbackValidationError,
} from '../lib/classroomFeedback';
import {
    authorizeFeedback, feedbackActivity, feedbackSubmission,
} from '../lib/classroomFeedbackAccess';
import { PERM } from '../model/builtin';
import { FeedbackQuery, feedbackRepository, FeedbackStateConflictError } from '../model/classroomFeedback';
import problem from '../model/problem';
import record from '../model/record';
import { Setting } from '../model/setting';
import user from '../model/user';
import { Handler } from '../service/server';

export class ClassroomFeedbackHandler extends Handler {
    activity: Awaited<ReturnType<typeof feedbackActivity>>;

    async prepare() {
        // Hydro's combined args allow body/query overrides. Identity and activity
        // are deliberately read from the resolved domain and matched route.
        const activityType = this.request.path.startsWith('/course/') ? 'course' : 'homework';
        this.activity = await feedbackActivity(this, activityType, this.request.params.tid);
        this.response.addHeader('Cache-Control', 'no-store');
        if (this.request.method === 'post') {
            const source = this.request.headers.origin || this.request.headers.referer;
            let sameOrigin = false;
            try {
                sameOrigin = new URL(source).origin === `${this.context.protocol}://${this.request.host}`;
            } catch { /* invalid or absent origin */ }
            if (!sameOrigin) throw new ForbiddenError('Same-origin feedback requests are required');
            if (this.request.headers['content-type']?.split(';')[0] !== 'application/json') throw new BadRequestError('JSON required');
            await this.limitRate('classroom_feedback', 60, 120, '{{user}}', true);
        }
    }

    async get() {
        const { scope, tdoc, roster, manager } = this.activity;
        const query: FeedbackQuery = {
            ...this.request.query.studentUid ? { studentUid: Number(this.request.query.studentUid) } : {},
            ...this.request.query.pid ? { pid: Number(this.request.query.pid) } : {},
            ...(this.request.query.nodeId !== undefined ? { nodeId: Number(this.request.query.nodeId) } : {}),
            pending: this.request.query.pending === 'true' || this.request.query.view === 'pending',
            before: this.request.query.before as string,
        };
        const view = this.request.query.view || 'history';
        if (!['roster', 'history', 'pending'].includes(view as string)) throw new BadRequestError('Invalid feedback view');
        const eventId = this.request.params.eventId;
        const target = eventId ? await feedbackRepository.get(scope, eventId) : null;
        if (eventId && !target) throw new NotFoundError('Feedback not found');
        const [result, udict, pdict, totalPending, filteredTotal] = await Promise.all([
            target ? feedbackRepository.detail(target).then((item) => ({ items: [item], next: null }))
                : view === 'roster' ? feedbackRepository.summary(scope, query).then((items) => ({ items, next: null }))
                    : feedbackRepository.list(scope, query),
            user.getListForRender(scope.domainId, roster, ['displayName']),
            problem.getList(scope.domainId, tdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST),
            feedbackRepository.count(scope),
            query.pending ? feedbackRepository.count(scope, query) : Promise.resolve(null),
        ]);
        const eventUids = result.items.flatMap((e) => [e.studentUid, e.operatorUid, ...e.changes.map((c) => c.operatorUid)]);
        Object.assign(udict, await user.getListForRender(scope.domainId, eventUids, ['displayName']));
        const submissions = {};
        const latest = {};
        if (this.user.hasPerm(PERM.PERM_VIEW_RECORD)) {
            const ids = [...new Set(result.items.flatMap((e) => [e.rid, ...e.changes.map((c) => c.rid)]).filter(Boolean))];
            const projection = { _id: 1, uid: 1, pid: 1, status: 1, score: 1 };
            const rows = await record.coll.find({ domainId: scope.domainId, contest: new ObjectId(scope.activityId),
                _id: { $in: ids.map((id) => new ObjectId(id)) } }).project(projection).toArray();
            for (const row of rows) submissions[row._id.toString()] = { ...row, url: this.url('record_detail', { rid: row._id }) };
            const current = await record.coll.aggregate([
                { $match: { domainId: scope.domainId, contest: new ObjectId(scope.activityId),
                    uid: { $in: [...new Set([...roster, ...result.items.map((e) => e.studentUid)])] },
                    pid: { $in: [...new Set([...tdoc.pids, ...result.items.map((e) => e.pid)])] } } },
                { $sort: { _id: -1 } }, { $project: projection },
                { $group: { _id: { uid: '$uid', pid: '$pid' }, record: { $first: '$$ROOT' } } },
            ]).toArray();
            for (const row of current) {
                latest[`${row._id.uid}:${row._id.pid}`] = {
                    ...row.record, url: this.url('record_detail', { rid: row.record._id }),
                };
            }
        }
        this.response.body = {
            ...result, udict, pdict, roster, manager, operatorUid: this.user._id, totalPending, filteredTotal, submissions, latest,
            tdoc,
            feedbackUrl: this.url(`${scope.activityType}_feedback`, { tid: tdoc.docId }),
            canManageCourse: this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK)
                || (this.user.own(tdoc) && this.user.hasPerm(PERM.PERM_EDIT_HOMEWORK_SELF)),
            activity: { ...scope, title: tdoc.title, nodes: (tdoc as any).dag || [], pids: tdoc.pids },
        };
        this.response.template = 'classroom_feedback.html';
    }

    async post() {
        const { actor, scope, manager } = this.activity;
        const { eventId, action } = this.request.params;
        if (!eventId) {
            this.response.body = await feedbackRepository.record(actor, this.request.body, async (_, input) => {
                return await authorizeFeedback(this.activity, input);
            });
            return;
        }
        const target = await feedbackRepository.get(scope, eventId);
        if (!target) throw new NotFoundError('Feedback not found');
        if (!['retract', 'resolve', 'undo-resolve'].includes(action)) throw new BadRequestError('Invalid feedback action');
        this.response.body = await feedbackRepository.change(
            actor, target, action === 'retract' ? 'OBSERVATION_RETRACTED'
                : action === 'resolve' ? 'RETEST_RESOLVED' : 'RETEST_RESOLUTION_RETRACTED', this.request.body,
            async (_, observation, rid, resolution) => {
                if (action === 'retract' && !manager && observation.operatorUid !== actor.operatorUid) throw new ForbiddenError();
                if (action === 'undo-resolve' && !manager && resolution?.operatorUid !== actor.operatorUid) throw new ForbiddenError();
                // Historical observations remain manageable by current teachers
                // after roster/node edits; new observations always use the live roster.
                await feedbackSubmission(scope.domainId, { ...observation, rid });
            },
        );
    }

    async onerror(error) {
        if (error instanceof FeedbackValidationError || error instanceof FeedbackConflictError || error instanceof FeedbackStateConflictError) {
            this.response.status = error instanceof FeedbackValidationError ? 400 : 409;
            this.response.body = { error: { message: error.message },
                ...(error instanceof FeedbackStateConflictError ? { currentState: error.currentState } : {}) };
            return;
        }
        await super.onerror(error);
    }
}

export async function apply(ctx: Context) {
    ctx.inject(['setting'], (c) => {
        c.setting.DomainSetting(Setting('setting_course', 'classroomFeedback', false, 'boolean', '本地课堂反馈'));
    });
    for (const type of ['course', 'homework']) {
        ctx.Route(`${type}_feedback`, `/${type}/:tid/feedback`, ClassroomFeedbackHandler);
        ctx.Route(`${type}_feedback_detail`, `/${type}/:tid/feedback/:eventId`, ClassroomFeedbackHandler);
        ctx.Route(`${type}_feedback_action`, `/${type}/:tid/feedback/:eventId/:action`, ClassroomFeedbackHandler);
    }
}
