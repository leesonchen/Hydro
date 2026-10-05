import { Context } from '../context';
import { BadRequestError, ForbiddenError, NotFoundError } from '../error';
import {
    FeedbackConflictError, FeedbackValidationError,
} from '../lib/classroomFeedback';
import {
    authorizeFeedback, feedbackActivity, feedbackSubmission,
} from '../lib/classroomFeedbackAccess';
import { FeedbackQuery, feedbackRepository } from '../model/classroomFeedback';
import problem from '../model/problem';
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
            pending: this.request.query.pending === 'true',
            before: this.request.query.before as string,
        };
        const [result, udict, pdict] = await Promise.all([
            feedbackRepository.list(scope, query),
            user.getListForRender(scope.domainId, roster, ['displayName']),
            problem.getList(scope.domainId, tdoc.pids, true, false, problem.PROJECTION_CONTEST_LIST),
        ]);
        const eventUids = result.items.flatMap((e) => [e.studentUid, e.operatorUid, ...e.changes.map((c) => c.operatorUid)]);
        Object.assign(udict, await user.getListForRender(scope.domainId, eventUids, ['displayName']));
        this.response.body = {
            ...result, udict, pdict, roster, manager, operatorUid: this.user._id,
            activity: { ...scope, title: tdoc.title, nodes: (tdoc as any).dag || [], pids: tdoc.pids },
        };
        this.response.template = 'classroom_feedback.html';
    }

    async post() {
        const { actor, scope, manager } = this.activity;
        const { eventId, action } = this.request.params;
        if (!eventId) {
            this.response.body = await feedbackRepository.record(actor, this.request.body, async (_, input) => {
                await authorizeFeedback(this.activity, input);
            });
            return;
        }
        const target = await feedbackRepository.get(scope, eventId);
        if (!target) throw new NotFoundError('Feedback not found');
        if (action !== 'retract' && action !== 'resolve') throw new BadRequestError('Invalid feedback action');
        this.response.body = await feedbackRepository.change(
            actor, target, action === 'retract' ? 'OBSERVATION_RETRACTED' : 'RETEST_RESOLVED', this.request.body,
            async (_, observation, rid) => {
                if (action === 'retract' && !manager && observation.operatorUid !== actor.operatorUid) throw new ForbiddenError();
                // Historical observations remain manageable by current teachers
                // after roster/node edits; new observations always use the live roster.
                await feedbackSubmission(scope.domainId, { ...observation, rid });
            },
        );
    }

    async onerror(error) {
        if (error instanceof FeedbackValidationError || error instanceof FeedbackConflictError) {
            this.response.status = error instanceof FeedbackConflictError ? 409 : 400;
            this.response.body = { error: { message: error.message } };
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
        ctx.Route(`${type}_feedback_action`, `/${type}/:tid/feedback/:eventId/:action`, ClassroomFeedbackHandler);
    }
}
