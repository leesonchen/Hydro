import { ValidationError } from '../error';
import { PRIV } from '../model/builtin';
import * as ratingPublication from '../model/rating-publication';
import * as oplog from '../model/oplog';
import { Context } from '../context';
import { Handler, requireSudo } from '../service/server';

class ManageRatingHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }

    @requireSudo
    async get() {
        this.response.body.dashboard = await ratingPublication.ratingDashboard();
        this.response.template = 'manage_rating.html';
    }

    @requireSudo
    async post() {
        try {
            const { op, algorithm, domains, domainId } = this.request.body || {};
            const actor = this.user._id;
            if (op === 'save') {
                if (typeof algorithm !== 'string' || typeof domains !== 'string') throw new ValidationError('rating');
                const parsedDomains = domains.split(/[\n,，]+/).map((s: string) => s.trim()).filter(Boolean);
                await ratingPublication.configureRating({ algorithm, domains: parsedDomains }, actor);
                await oplog.log(this, 'rating.configure', { desiredsettings: { algorithm, domains: parsedDomains }, op: 'save' });
            } else if (op === 'apply') {
                if (typeof domainId !== 'string' || !domainId.trim()) throw new ValidationError('domainId');
                await ratingPublication.queueRatingApply(domainId.trim(), actor);
                await oplog.log(this, 'rating.apply', { target: domainId.trim(), op: 'apply' });
            } else if (op === 'rollback') {
                if (typeof domainId !== 'string' || !domainId.trim()) throw new ValidationError('domainId');
                await ratingPublication.rollbackRating(domainId.trim(), actor);
                await oplog.log(this, 'rating.rollback', { target: domainId.trim(), op: 'rollback' });
            } else throw new ValidationError('op');
            this.response.redirect = this.url('manage_rating');
        } catch (error) {
            if (error instanceof ValidationError) throw error;
            throw new ValidationError('评分设置', undefined, error.message);
        }
    }
}

export function apply(ctx: Context) {
    ctx.Route('manage_rating', '/manage/rating', ManageRatingHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.injectUI('ControlPanel', 'manage_rating', {}, PRIV.PRIV_EDIT_SYSTEM);
}
