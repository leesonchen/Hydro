import { load } from 'js-yaml';
import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import Schema from 'schemastery';
import type { Context } from '../context';
import {
    BadRequestError, CannotDeleteSystemDomainError, DomainJoinAlreadyMemberError, DomainJoinForbiddenError, ForbiddenError,
    InvalidJoinInvitationCodeError, InvalidTokenError, NotFoundError, OnlyOwnerCanDeleteDomainError, PermissionError,
    RoleAlreadyExistError, ValidationError,
} from '../error';
import type { DomainDoc, GDoc, TokenDoc } from '../interface';
import avatar from '../lib/avatar';
import { projectUserRating, projectUserRatings, publicRatingStore } from '../lib/rating-publication-read';
import { PERM, PERMS_BY_FAMILY, PRIV } from '../model/builtin';
import * as discussion from '../model/discussion';
import domain, { type PreassignedDomainUser } from '../model/domain';
import MessageModel from '../model/message';
import * as oplog from '../model/oplog';
import { DOMAIN_SETTINGS, DOMAIN_SETTINGS_BY_KEY } from '../model/setting';
import system from '../model/system';
import token from '../model/token';
import user, {
    canManageClass, deleteUserCache, type GroupMembershipMutation,
} from '../model/user';
import {
    Handler, Mutation, param, post, Query, query, requireSudo, Types,
} from '../service/server';
import { log2 } from '../utils';

const GROUP_INVITATION_EXPIRATIONS = Object.fromEntries(
    Object.entries(domain.JOIN_EXPIRATION_RANGE).filter(([hours]) => +hours > 0),
);
const INVITATION_CODE_RE = /^[a-z0-9]{1,64}$/i;

function normalizeInvitationCode(code: string) {
    return code.toLowerCase();
}

function isClassInvitationBlocked(group: GDoc) {
    return !!group.class && (group.name === 'teachers' || !!group.archive);
}

function getGroupInvitationMutationQuery(handler: Handler, domainId: string, group: GDoc) {
    if (!group.class) return { domainId, _id: group._id, class: { $ne: true } };
    const canManageAnyClass = handler.user.hasPerm(PERM.PERM_EDIT_DOMAIN, PERM.PERM_EDIT_HOMEWORK);
    return {
        domainId,
        _id: group._id,
        class: true,
        name: group.name,
        archive: { $ne: true },
        ...(canManageAnyClass ? {} : { teachers: handler.user._id }),
        $or: [
            { classEditLock: { $exists: false } },
            { 'classEditLock.expiresAt': { $lte: new Date() } },
        ],
    };
}

async function throwGroupInvitationMutationError(handler: Handler, domainId: string, id: ObjectId): Promise<never> {
    const current = await user.collGroup.findOne({ domainId, _id: id });
    if (!current || isClassInvitationBlocked(current)) throw new NotFoundError(domainId, id);
    const canManage = current.class
        ? canManageClass(handler.user, current)
        : handler.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
    if (!canManage) throw new PermissionError(PERM.PERM_EDIT_DOMAIN);
    throw new BadRequestError('Class is being edited. Please refresh and try again.');
}

class DomainRankHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        const publication = await publicRatingStore.ranking(domainId);
        const [dudocs, upcount, ucount] = await this.paginate<{ uid: number }>(
            publication.cursor,
            page,
            'ranking',
        );
        const udict = await user.getList(domainId, dudocs.map((dudoc) => dudoc.uid));
        const udocs = await projectUserRatings(domainId, dudocs.map((i) => udict[i.uid]), publication.active);
        this.user = await projectUserRating(domainId, this.user, publication.active);
        this.response.template = 'ranking.html';
        this.response.body = {
            udocs, upcount, ucount, page,
            ratingAlgorithm: publication.active?.algorithm || 'legacy',
            ratingUpdatedAt: publication.active?.updatedAt,
            ratingUpdatedAtText: publication.active ? moment(publication.active.updatedAt).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm:ss') : '',
            ratingProvisionalEvents: 5,
        };
    }
}

class ManageHandler extends Handler {
    async prepare({ domainId }) {
        this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        this.domain = await domain.get(domainId);
    }
}

class DomainEditHandler extends ManageHandler {
    async get() {
        this.response.template = 'domain_edit.html';
        this.response.body = { current: this.domain, settings: DOMAIN_SETTINGS };
    }

    async post(args) {
        if (args.operation) return;
        const $set = {};
        const booleanKeys = args.booleanKeys || {};
        delete args.booleanKeys;
        for (const key in booleanKeys) if (!args[key]) $set[key] = false;
        for (const key in args) {
            if (DOMAIN_SETTINGS_BY_KEY[key]) $set[key] = args[key];
        }
        await domain.edit(args.domainId, $set);
        this.response.redirect = this.url('domain_dashboard');
    }
}

class DomainDashboardHandler extends ManageHandler {
    async get() {
        const owner = await user.getById(this.domain._id, this.domain.owner);
        this.response.template = 'domain_dashboard.html';
        this.response.body = { domain: this.domain, owner };
    }

    async postInitDiscussionNode({ domainId }) {
        const nodes = load(system.get('discussion.nodes'));
        await discussion.flushNodes(domainId);
        for (const category of Object.keys(nodes)) {
            for (const item of nodes[category]) {
                // eslint-disable-next-line no-await-in-loop
                const curr = await discussion.getNode(domainId, item.name);
                // eslint-disable-next-line no-await-in-loop
                if (!curr) await discussion.addNode(domainId, item.name, category, item.pic ? { pic: item.pic } : undefined);
            }
        }
        this.back();
    }

    @requireSudo
    async postDelete({ domainId }) {
        if (domainId === 'system') throw new CannotDeleteSystemDomainError();
        if (this.domain.owner !== this.user._id) throw new OnlyOwnerCanDeleteDomainError();
        await Promise.all([
            domain.del(domainId),
            oplog.log(this, 'domain.delete', {}),
        ]);
        this.response.redirect = this.url('home_domain', { domainId: 'system' });
    }
}

class DomainUserHandler extends ManageHandler {
    @requireSudo
    @param('format', Types.Range(['default', 'raw']), true)
    async get({ domainId }, format = 'default') {
        const showDefault = system.get('server.showDefaultRole') || domainId !== 'system';
        const [dudocs, roles] = await Promise.all([
            domain.collUser.aggregate([
                {
                    $match: {
                        role: showDefault ? { $ne: 'guest' } : {
                            $nin: ['default', 'guest'],
                            $ne: null,
                        },
                        domainId,
                    },
                },
                {
                    $lookup: {
                        from: 'user',
                        let: { uid: '$uid' },
                        pipeline: [
                            {
                                $match: {
                                    $expr: { $eq: ['$_id', '$$uid'] },
                                    priv: { $bitsAllSet: PRIV.PRIV_USER_PROFILE },
                                },
                            },
                            {
                                $project: {
                                    _id: 1,
                                    uname: 1,
                                    avatar: 1,
                                },
                            },
                        ],
                        as: 'user',
                    },
                },
                { $unwind: '$user' },
                {
                    $project: {
                        user: 1,
                        role: 1,
                        join: 1,
                        ...(this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO) ? { displayName: 1 } : {}),
                    },
                },
            ]).toArray(),
            domain.getRoles(domainId),
        ]);
        const users = dudocs.map((dudoc) => {
            const u = {
                ...dudoc,
                ...dudoc.user,
            };
            delete u.user;
            return u;
        });
        const rudocs = Object.create(null);
        for (const role of roles) rudocs[role._id] = users.filter((udoc) => (udoc.role || 'default') === role._id);
        this.response.publicDictionaries = [rudocs];
        this.response.template = format === 'raw' ? 'domain_user_raw.html' : 'domain_user.html';
        this.response.body = {
            roles, rudocs, domain: this.domain,
        };
    }

    @param('uids', Types.NumericArray)
    async post({ }, uids: number[]) {
        if (uids.includes(this.domain.owner)) throw new ForbiddenError();
    }

    @requireSudo
    @param('uids', Types.NumericArray)
    @param('role', Types.Role)
    @param('join', Types.Boolean)
    async postSetUsers(domainId: string, uid: number[], role: string, join = false) {
        if (join && !system.get('server.allowInvite')) this.checkPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN);
        await Promise.all([
            domain.setUserRole(domainId, uid, role),
            oplog.log(this, 'domain.setRole', { uid, role, join }),
        ]);
        if (join) await domain.setJoin(domainId, uid, true);
        this.back();
    }

    @requireSudo
    @param('uids', Types.NumericArray)
    async postKick({ domainId }, uids: number[]) {
        const original = await domain.getMultiUserInDomain(domainId, { uid: { $in: uids } }).toArray();
        const needUpdate = uids.filter((uid) => original.find((i) => i.uid === uid)?.join);
        if (!needUpdate.length) return;
        const target = needUpdate.length > 1 ? needUpdate : needUpdate[0];
        await Promise.all([
            domain.setJoin(domainId, target, false),
            domain.setUserRole(domainId, target, 'guest'),
            oplog.log(this, 'domain.kick', { uids: needUpdate }),
        ]);
        const msg = JSON.stringify({
            message: 'You have been kicked from domain {0} by {1}.',
            params: [this.domain.name, this.user.uname],
        });
        await Promise.all(needUpdate.map((i) => MessageModel.send(1, i, msg, MessageModel.FLAG_RICHTEXT | MessageModel.FLAG_UNREAD)));
        this.back();
    }
}

class DomainPermissionHandler extends ManageHandler {
    @requireSudo
    async get({ domainId }) {
        const roles = await domain.getRoles(domainId);
        this.response.template = 'domain_permission.html';
        this.response.body = {
            roles, PERMS_BY_FAMILY, domain: this.domain, log2,
        };
    }

    @requireSudo
    async post({ domainId }) {
        if (this.request.body.operation) return;
        await this.savePermissions(domainId, Object.entries(this.request.body));
    }

    @requireSudo
    async postUpdate({ domainId }) {
        const input = this.request.body.permissions;
        if (!input || typeof input !== 'object') throw new ValidationError('permissions');
        // qs represents numbered form entries as an object once its array limit is exceeded.
        const entries: [string, any][] = Object.values(input).map((entry: any) => {
            if (!entry || typeof entry !== 'object' || typeof entry.role !== 'string' || !entry.role) {
                throw new ValidationError('role');
            }
            return [entry.role, entry.permissions];
        });
        if (new Set(entries.map(([role]) => role)).size !== entries.length) throw new ValidationError('role');
        await this.savePermissions(domainId, entries);
    }

    private async savePermissions(domainId: string, entries: [string, any][]) {
        const roles: Record<string, bigint> = Object.create(null);
        for (const [role, list] of entries) {
            if (role === 'root') continue; // root role is not editable
            const perms = Array.isArray(list) ? list
                : (typeof list === 'object' && list)
                    ? Object.values(list) : [list];
            roles[role] = 0n;
            for (const r of perms) {
                if (!Number.isSafeInteger(+r) || +r < 0) throw new ValidationError('permissions');
                if (+r === 1000) continue; // skip placeholder value
                roles[role] |= 1n << BigInt(+r);
            }
        }
        await Promise.all([
            domain.setRoles(domainId, roles),
            oplog.log(this, 'domain.setRoles', { roles }),
        ]);
        this.back();
    }
}

class DomainRoleHandler extends ManageHandler {
    @requireSudo
    async get({ domainId }) {
        const roles = await domain.getRoles(domainId, true);
        this.response.template = 'domain_role.html';
        this.response.body = { roles, domain: this.domain };
    }

    @param('role', Types.Role)
    async postAdd(domainId: string, role: string) {
        domain.validateNewRoleName(role);
        const roles = await domain.getRoles(this.domain);
        const rdict = Object.fromEntries(roles.map((r) => [r._id, r.perm]));
        if (Object.hasOwn(rdict, role)) throw new RoleAlreadyExistError(role);
        await Promise.all([
            domain.addRole(domainId, role, rdict.default),
            oplog.log(this, 'domain.addRole', { role }),
        ]);
        this.back();
    }

    @requireSudo
    @post('roles', Schema.array(Schema.object({
        role: Schema.string().required(),
        default: Schema.boolean().required(),
        priority: Schema.number().step(1).required(),
    })))
    async postUpdate(domainId: string, roles: { role: string, default: boolean, priority: number }[]) {
        if (new Set(roles.map((role) => role.role)).size !== roles.length) throw new ValidationError('roles');
        const settings = Object.fromEntries(roles.map((role) => [role.role, {
            default: role.default,
            priority: role.priority,
        }]));
        await domain.setRoleMeta(domainId, settings);
        await oplog.log(this, 'domain.updateRoleMeta', { settings });
        this.back();
    }

    @requireSudo
    @param('roles', Types.ArrayOf(Types.Role))
    async postDelete(domainId: string, roles: string[]) {
        if (new Set(roles).intersection(new Set(['root', 'default', 'guest'])).size > 0) {
            throw new ValidationError('role', null, 'You cannot delete root, default or guest roles');
        }
        await Promise.all([
            domain.deleteRoles(domainId, roles),
            oplog.log(this, 'domain.deleteRoles', { roles }),
        ]);
        this.back();
    }
}

class DomainJoinApplicationsHandler extends ManageHandler {
    async get() {
        const r = await domain.getRoles(this.domain);
        const roles = r.map((role) => role._id);
        const defaultRole = domain.getDefaultRole(r);
        this.response.body.rolesWithText = r
            .filter((role) => role._id !== 'guest')
            .map((role) => [role._id, role._id]);
        this.response.body.defaultRole = defaultRole;
        this.response.body.joinSettings = domain.getJoinSettings(this.domain, roles);
        this.response.body.expirations = { ...domain.JOIN_EXPIRATION_RANGE };
        if (!this.response.body.joinSettings) {
            delete this.response.body.expirations[domain.JOIN_EXPIRATION_KEEP_CURRENT];
        }
        this.response.body.url_prefix = (this.domain.host || [])[0] || system.get('server.url');
        if (!this.response.body.url_prefix.endsWith('/')) this.response.body.url_prefix += '/';
        this.response.template = 'domain_join_applications.html';
    }

    @requireSudo
    @post('method', Types.Range([domain.JOIN_METHOD_NONE, domain.JOIN_METHOD_ALL, domain.JOIN_METHOD_CODE]))
    @post('role', Types.Role, true)
    @post('group', Types.Name, true)
    @post('expire', Types.Int, true)
    @post('invitationCode', Types.Content, true)
    async post(domainId: string, method: number, role: string, group = '', expire: number, invitationCode = '') {
        const r = await domain.getRoles(this.domain);
        const roles = r.map((rl) => rl._id);
        const current = domain.getJoinSettings(this.domain, roles);
        let joinSettings;
        if (method === domain.JOIN_METHOD_NONE) joinSettings = null;
        else {
            role ||= domain.getDefaultRole(r);
            if (!roles.includes(role) || role === 'guest') throw new ValidationError('role');
            if (!current && expire === domain.JOIN_EXPIRATION_KEEP_CURRENT) throw new ValidationError('expire');
            joinSettings = { method, role, group };
            if (expire === domain.JOIN_EXPIRATION_KEEP_CURRENT) joinSettings.expire = current.expire;
            else if (expire === domain.JOIN_EXPIRATION_UNLIMITED) joinSettings.expire = null;
            else if (!domain.JOIN_EXPIRATION_RANGE[expire]) throw new ValidationError('expire');
            else joinSettings.expire = moment().add(expire, 'hours').toDate();
            if (method === domain.JOIN_METHOD_CODE) joinSettings.code = invitationCode;
        }
        await domain.edit(domainId, { _join: joinSettings });
        this.back();
    }
}

class DomainUserGroupHandler extends ManageHandler {
    async get({ domainId }) {
        const groups = await user.listGroup(domainId);
        this.response.template = 'domain_group.html';
        this.response.body = {
            domain: this.domain,
            groups: groups.filter((group) => !group.class),
        };
    }

    @param('name', Types.Name)
    async postDel(domainId: string, name: string) {
        await user.delGroup(domainId, name);
        this.back();
    }

    @param('name', Types.Name)
    @param('uids', Types.NumericArray)
    async postUpdate(domainId: string, name: string, uids: number[]) {
        await user.updateGroup(domainId, name, uids);
        this.back();
    }
}

class DomainGroupInvitationHandler extends Handler {
    group!: GDoc;

    @param('id', Types.ObjectId)
    async prepare(domainId: string, id: ObjectId) {
        this.group = await user.collGroup.findOne({ domainId, _id: id });
        if (!this.group) throw new NotFoundError(domainId, id);
        if (isClassInvitationBlocked(this.group)) throw new NotFoundError(domainId, id);
        const canManage = this.group.class
            ? canManageClass(this.user, this.group)
            : this.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
        if (!canManage) throw new PermissionError(PERM.PERM_EDIT_DOMAIN);
        this.domain = await domain.get(domainId);
    }

    async get({ domainId }) {
        const invitationTokenId = this.group.invitationTokenId;
        let currentInvitation: TokenDoc | null = null;
        if (invitationTokenId) {
            currentInvitation = await token.getMulti(token.TYPE_GROUP_INVITATION, {
                domainId,
                groupId: this.group._id,
                expireAt: { $gt: new Date() },
                _id: invitationTokenId,
            }).limit(1).next();
        }
        const serverUrl = system.get('server.url');
        const protocol = /^https?:\/\//i.exec(serverUrl)?.[0] || `${this.context.protocol}://`;
        const prefix = (this.domain.host || [])[0]
            ? `${protocol}${this.domain.host[0]}`
            : serverUrl;
        const urlPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
        const roles = await domain.getRoles(domainId);
        this.response.body = {
            canInviteExternalDomainUser: this.user.hasPerm(PERM.PERM_EDIT_DOMAIN),
            currentInvitation,
            domain: this.domain,
            expirations: GROUP_INVITATION_EXPIRATIONS,
            group: this.group,
            invitationUrl: currentInvitation
                ? `${urlPrefix}d/${domainId}/domain/group/join?${this.group.class && this.group.invitationCode
                    ? `code=${encodeURIComponent(this.group.invitationCode)}`
                    : `token=${encodeURIComponent(currentInvitation._id)}`}`
                : '',
            defaultRole: domain.getDefaultRole(roles),
            rolesWithText: roles
                .map((role) => role._id)
                .filter((role) => !['guest', 'root'].includes(role))
                .map((role) => [role, role]),
        };
        this.response.template = 'domain_group_invitation.html';
    }

    async postRevoke({ domainId }) {
        const result = await user.collGroup.updateOne(
            getGroupInvitationMutationQuery(this, domainId, this.group),
            {
                $set: { invitationTokenId: null, invitationCode: null },
                ...(this.group.class ? { $unset: { classEditLock: '' } } : {}),
            },
        );
        if (!result.matchedCount) await throwGroupInvitationMutationError(this, domainId, this.group._id);
        await oplog.log(this, 'domain.group.invitation.revoke', {
            groupId: this.group._id,
            groupName: this.group.name,
            groupType: this.group.class ? 'class' : 'group',
        });
        this.back();
    }

    @param('expire', Types.Int)
    @param('invitationCode', Types.Content, true)
    @param('externalJoinRole', Types.Role, true)
    async postCreate({ domainId }, expire: number, invitationCode = '', externalJoinRole = '') {
        if (!GROUP_INVITATION_EXPIRATIONS[expire]) throw new ValidationError('expire');
        const canInviteExternalDomainUser = this.user.hasPerm(PERM.PERM_EDIT_DOMAIN);
        const allowExternalDomainJoin = !this.group.class || canInviteExternalDomainUser;
        if (!canInviteExternalDomainUser && externalJoinRole) throw new PermissionError(PERM.PERM_EDIT_DOMAIN);
        const roles = await domain.getRoles(domainId);
        const assignedRole = externalJoinRole || domain.getDefaultRole(roles);
        if (allowExternalDomainJoin) {
            if (!roles.some((role) => role._id === assignedRole) || ['guest', 'root'].includes(assignedRole)) {
                throw new ValidationError('externalJoinRole');
            }
        }
        if (!this.group.class && invitationCode) throw new ValidationError('invitationCode');
        if (invitationCode && !INVITATION_CODE_RE.test(invitationCode)) throw new ValidationError('invitationCode');
        const normalizedInvitationCode = invitationCode ? normalizeInvitationCode(invitationCode) : null;
        if (normalizedInvitationCode) {
            const conflictingGroup = await user.collGroup.findOne({
                domainId,
                _id: { $ne: this.group._id },
                invitationCode: normalizedInvitationCode,
            });
            if (conflictingGroup) {
                const conflictingInvitation = conflictingGroup.invitationTokenId
                    ? await token.get(conflictingGroup.invitationTokenId, token.TYPE_GROUP_INVITATION)
                    : null;
                if (conflictingInvitation && conflictingInvitation.expireAt > new Date()
                    && conflictingInvitation.groupId?.equals(conflictingGroup._id)) {
                    throw new ValidationError('invitationCode');
                }
                await user.collGroup.updateOne(
                    {
                        _id: conflictingGroup._id,
                        domainId,
                        invitationCode: normalizedInvitationCode,
                        invitationTokenId: conflictingGroup.invitationTokenId,
                    },
                    { $set: { invitationCode: null } },
                );
            }
        }
        const [invitationTokenId] = await token.add(token.TYPE_GROUP_INVITATION, expire * 60 * 60, {
            domainId,
            groupId: this.group._id,
            allowExternalDomainJoin,
            ...(allowExternalDomainJoin ? { externalJoinRole: assignedRole } : {}),
        });
        let result;
        try {
            result = await user.collGroup.updateOne(
                getGroupInvitationMutationQuery(this, domainId, this.group),
                {
                    $set: { invitationTokenId, invitationCode: normalizedInvitationCode },
                    ...(this.group.class ? { $unset: { classEditLock: '' } } : {}),
                },
            );
        } catch (error: any) {
            await token.del(invitationTokenId, token.TYPE_GROUP_INVITATION);
            if (error?.code === 11000) throw new ValidationError('invitationCode');
            throw error;
        }
        if (!result.matchedCount) {
            await token.del(invitationTokenId, token.TYPE_GROUP_INVITATION);
            await throwGroupInvitationMutationError(this, domainId, this.group._id);
        }
        await oplog.log(this, 'domain.group.invitation.create', {
            allowExternalDomainJoin,
            ...(allowExternalDomainJoin ? { externalJoinRole: assignedRole } : {}),
            expireHours: expire,
            groupId: this.group._id,
            groupName: this.group.name,
            groupType: this.group.class ? 'class' : 'group',
        });
        this.back();
    }
}

class DomainGroupJoinHandler extends Handler {
    group!: GDoc;
    invitation!: TokenDoc;
    targetDomain!: DomainDoc;
    noCheckPermView = true;

    @param('token', Types.Content, true)
    @param('code', Types.Content, true)
    async prepare({ domainId }, tokenId = '', invitationCode = '') {
        if (invitationCode) {
            const group = await user.collGroup.findOne({
                domainId,
                class: true,
                invitationCode: normalizeInvitationCode(invitationCode),
            });
            if (tokenId && group?.invitationTokenId !== tokenId) {
                throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_GROUP_INVITATION]);
            }
            tokenId = group?.invitationTokenId || '';
        }
        this.invitation = await token.get(tokenId, token.TYPE_GROUP_INVITATION);
        if (!this.invitation || this.invitation.expireAt <= new Date()
            || this.invitation.domainId !== domainId) {
            throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_GROUP_INVITATION]);
        }
        const [group, targetDomain, domainUser] = await Promise.all([
            user.collGroup.findOne({
                _id: this.invitation.groupId,
                domainId: this.invitation.domainId,
            }),
            domain.get(this.invitation.domainId),
            domain.collUser.findOne({
                domainId: this.invitation.domainId,
                uid: this.user._id,
            }),
        ]);
        if (!targetDomain || !group || isClassInvitationBlocked(group)
            || group.invitationTokenId !== this.invitation._id) {
            throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_GROUP_INVITATION]);
        }
        if (domainUser?.role === 'guest') {
            throw new DomainJoinForbiddenError(
                this.invitation.domainId,
                'You are banned by the domain moderator.',
            );
        }
        if (!domainUser?.join && group.class && this.invitation.allowExternalDomainJoin !== true) {
            throw new DomainJoinForbiddenError(
                this.invitation.domainId,
                'This class invitation is only available to existing domain members.',
            );
        }
        this.group = group;
        this.targetDomain = targetDomain;
    }

    async get() {
        this.response.body = {
            alreadyMember: this.group.uids.includes(this.user._id),
            domainInfo: {
                name: this.targetDomain.name,
            },
            externalJoinRole: this.invitation.externalJoinRole || 'default',
            canAssignRole: !this.group.class || this.invitation.allowExternalDomainJoin === true,
            group: this.group,
            token: this.invitation._id,
        };
        this.response.template = 'domain_group_join.html';
    }

    private async releaseGroupMembershipLock(classEditLockToken?: string) {
        if (!classEditLockToken) return;
        await user.collGroup.updateOne(
            {
                domainId: this.invitation.domainId,
                _id: this.group._id,
                class: true,
                'classEditLock.token': classEditLockToken,
            },
            { $unset: { classEditLock: '' } },
        );
    }

    private async rollbackNewGroupMembership(membership: GroupMembershipMutation) {
        const uid = this.user._id;
        const { added, classEditLockToken } = membership;
        if (!added.uids && !added.students) {
            await this.releaseGroupMembershipLock(classEditLockToken);
            return;
        }
        const groupQuery = {
            domainId: this.invitation.domainId,
            _id: this.group._id,
            ...(this.group.class ? {
                class: true,
                'classEditLock.token': classEditLockToken,
            } : {}),
        };
        const releaseLock = classEditLockToken ? { $unset: { classEditLock: '' as const } } : {};
        let result;
        if (added.uids && added.students) {
            result = await user.collGroup.updateOne(
                { ...groupQuery, teachers: { $ne: uid } },
                { $pull: { uids: uid, students: uid }, ...releaseLock },
            );
        } else if (added.uids) {
            result = await user.collGroup.updateOne(
                { ...groupQuery, teachers: { $ne: uid }, students: { $ne: uid } },
                { $pull: { uids: uid }, ...releaseLock },
            );
        } else {
            result = await user.collGroup.updateOne(
                groupQuery,
                { $pull: { students: uid }, ...releaseLock },
            );
        }
        if (!result.matchedCount) {
            await this.releaseGroupMembershipLock(classEditLockToken);
        }
        deleteUserCache(this.invitation.domainId);
    }

    async post() {
        const target = this.invitation.domainId;
        const canJoinDomain = !this.group.class || this.invitation.allowExternalDomainJoin === true;
        const externalJoinRole = this.invitation.externalJoinRole || 'default';
        const currentDomainUser = canJoinDomain
            ? await domain.collUser.findOne({ domainId: target, uid: this.user._id }, { projection: { join: 1 } })
            : null;
        if (canJoinDomain && ['guest', 'root'].includes(externalJoinRole)) {
            throw new ValidationError('externalJoinRole');
        }
        if (canJoinDomain && !currentDomainUser?.join) {
            const roles = await domain.getRoles(target);
            if (!roles.some((role) => role._id === externalJoinRole)) {
                throw new ValidationError('externalJoinRole');
            }
        }
        const membership = await user.addUserToGroupWithChanges(
            target, this.group._id, this.user._id, this.invitation._id,
        );
        if (!membership) throw new InvalidTokenError(token.TYPE_TEXTS[token.TYPE_GROUP_INVITATION]);
        let joinedDomainUser;
        try {
            joinedDomainUser = canJoinDomain
                ? await domain.joinUserInDomain(target, this.user._id, externalJoinRole)
                : await domain.collUser.findOne({ domainId: target, uid: this.user._id });
        } catch (error) {
            await this.rollbackNewGroupMembership(membership);
            throw error;
        }
        if (joinedDomainUser?.role === 'guest') {
            await this.rollbackNewGroupMembership(membership);
            throw new DomainJoinForbiddenError(target, 'You are banned by the domain moderator.');
        }
        if (!canJoinDomain && !joinedDomainUser?.join) {
            await this.rollbackNewGroupMembership(membership);
            throw new DomainJoinForbiddenError(
                target,
                'This class invitation is only available to existing domain members.',
            );
        }
        await this.releaseGroupMembershipLock(membership.classEditLockToken);
        await oplog.log(this, 'domain.group.join', {
            domainId: target,
            groupId: this.group._id,
            groupName: this.group.name,
        });
        this.response.redirect = this.url('homepage', {
            domainId: target,
            query: { notification: this.group.class ? 'Successfully joined class.' : 'Successfully joined group.' },
        });
    }
}

class DomainJoinHandler extends Handler {
    joinSettings: any;
    roleToAssign = 'default';
    preassignedUser?: PreassignedDomainUser;
    noCheckPermView = true;

    @param('target', Types.DomainId, true)
    async prepare({ domainId }, target: string = domainId) {
        const [ddoc, dudoc] = await Promise.all([
            domain.get(target),
            domain.collUser.findOne({ domainId: target, uid: this.user._id }),
        ]);
        if (!ddoc) throw new NotFoundError(target);
        const roleDocs = await domain.getRoles(ddoc);
        const roles = roleDocs.map((role) => role._id);
        const assignedRole = this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN) ? 'root' : dudoc?.role || 'default';
        if (assignedRole === 'guest') throw new DomainJoinForbiddenError(target, 'You are banned by the domain moderator.');
        // Direct invitations apply the moderator's preassigned role independently of public invitations.
        const hasPreassignedRole = !dudoc?.join && assignedRole !== 'default' && roles.includes(assignedRole);
        this.preassignedUser = hasPreassignedRole && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)
            ? { role: dudoc.role, join: dudoc.join, requireInvitation: dudoc.requireInvitation }
            : undefined;
        this.joinSettings = hasPreassignedRole ? null : domain.getJoinSettings(ddoc, roles);
        if (!this.joinSettings) {
            if (dudoc?.join) throw new DomainJoinAlreadyMemberError(target, this.user._id);
            if (assignedRole === 'default' || !roles.includes(assignedRole)) {
                throw new DomainJoinForbiddenError(target, 'The link is either invalid or expired.');
            }
        }
        this.roleToAssign = this.joinSettings?.role || assignedRole;
        if (dudoc?.requireInvitation && this.joinSettings?.method !== domain.JOIN_METHOD_CODE) {
            throw new DomainJoinForbiddenError(target, 'An invitation is required to rejoin this domain.');
        }
    }

    @param('code', Types.Content, true)
    @param('target', Types.DomainId, true)
    @param('redirect', Types.Content, true)
    async get({ domainId }, code: string, target: string = domainId, redirect: string = '') {
        this.response.template = 'domain_join.html';
        const ddoc = await domain.get(target);
        const domainInfo = {
            name: ddoc.name,
            owner: await user.getById(target, ddoc.owner),
            avatar: ddoc.avatar,
            bulletin: ddoc.showBulletin ? ddoc.bulletin : '',
        };
        this.response.body = {
            joinSettings: this.joinSettings,
            code,
            redirect,
            target,
            domainInfo,
        };
    }

    @param('code', Types.Content, true)
    @param('target', Types.DomainId, true)
    @param('redirect', Types.Content, true)
    async post({ domainId }, code: string, target: string = domainId, redirect: string = '') {
        if (this.joinSettings?.method === domain.JOIN_METHOD_CODE) {
            if (this.joinSettings.code !== code) {
                throw new InvalidJoinInvitationCodeError(target);
            }
        }
        if (this.joinSettings?.group) {
            const groups = await user.listGroup(target);
            const entry = groups.find((i) => i.name === this.joinSettings.group);
            if (!entry) throw new ValidationError('group');
            if (isClassInvitationBlocked(entry)) throw new ValidationError('group');
            const added = await user.addUserToGroup(target, entry._id, this.user._id);
            if (!added) throw new ValidationError('group');
        }
        const joinedDomainUser = this.preassignedUser
            ? await domain.joinUserWithPreassignedRole(target, this.user._id, this.preassignedUser)
            : await domain.joinUserInDomain(target, this.user._id, this.roleToAssign);
        if (joinedDomainUser?.role === 'guest') {
            throw new DomainJoinForbiddenError(target, 'You are banned by the domain moderator.');
        }
        await oplog.log(this, 'domain.join', {});
        this.response.redirect = redirect || this.url('homepage', { domainId: target, query: { notification: 'Successfully joined domain.' } });
    }
}

class DomainSearchHandler extends Handler {
    @param('q', Types.Content, true)
    async get(domainId: string, q: string = '') {
        let ddocs: DomainDoc[] = [];
        if (!q) {
            const dudict = await domain.getDictUserByDomainId(this.user._id);
            const dids = Object.keys(dudict);
            ddocs = await domain.getMulti({ _id: { $in: dids } }).toArray();
        } else ddocs = await domain.getPrefixSearch(q, 20);
        for (let i = 0; i < ddocs.length; i++) {
            ddocs[i].avatarUrl = ddocs[i].avatar ? avatar(ddocs[i].avatar, 64) : '/img/team_avatar.png';
        }
        this.response.body = ddocs;
    }
}

export const DomainApi = {
    domain: Query(
        Schema.object({
            id: Schema.string(),
        }),
        async (ctx, args) => {
            const ddoc = args.id ? await domain.get(args.id) : ctx.domain;
            if (!ddoc) return null;
            const udoc = await user.getById(ddoc._id, ctx.user._id);
            if (!udoc.hasPerm(PERM.PERM_VIEW) && !udoc.hasPriv(PRIV.PRIV_VIEW_ALL_DOMAIN)) return null;
            return ddoc;
        },
    ),
    'domain.current': Query(
        Schema.object({}),
        async (handler) => ({ domain: handler.domain as DomainDoc }),
    ),
    groups: Query(
        Schema.object({
            domainId: Schema.string().required(),
            uid: Schema.number().step(1),
            names: Schema.array(Schema.string()),
            search: Schema.string(),
            limit: Schema.number().step(1).max(100),
        }),
        async (ctx, args) => {
            const udoc = await user.getById(args.domainId, ctx.user._id);
            if (!udoc.hasPerm(PERM.PERM_VIEW) && !udoc.hasPriv(PRIV.PRIV_VIEW_ALL_DOMAIN)) throw new PermissionError(PERM.PERM_VIEW);
            return user.listGroup(args.domainId, args.uid, args.names, args.search, args.limit || (args.search ? 20 : undefined));
        },
    ),
    'domain.group': Mutation(
        Schema.object({
            name: Schema.string().required(),
            uids: Schema.array(Schema.number()),
        }),
        async (ctx, args) => {
            if (!ctx.user.hasPerm(PERM.PERM_EDIT_DOMAIN)) throw new PermissionError(PERM.PERM_EDIT_DOMAIN);
            if (args.uids?.length) {
                const res = await user.updateGroup(ctx.domain._id, args.name, args.uids);
                return res.upsertedCount > 0;
            }
            const res = await user.delGroup(ctx.domain._id, args.name);
            return res.deletedCount > 0;
        },
    ),
} as const;

declare module '@hydrooj/framework' {
    interface Apis {
        domain: typeof DomainApi;
    }
}

export async function apply(ctx: Context) {
    ctx.Route('ranking', '/ranking', DomainRankHandler, PERM.PERM_VIEW_RANKING);
    ctx.Route('domain_dashboard', '/domain/dashboard', DomainDashboardHandler);
    ctx.Route('domain_edit', '/domain/edit', DomainEditHandler);
    ctx.Route('domain_user', '/domain/user', DomainUserHandler);
    ctx.Route('domain_permission', '/domain/permission', DomainPermissionHandler);
    ctx.Route('domain_role', '/domain/role', DomainRoleHandler);
    ctx.Route('domain_group', '/domain/group', DomainUserGroupHandler);
    ctx.Route('domain_group_invitation', '/domain/group/:id/invitation', DomainGroupInvitationHandler);
    ctx.Route('domain_group_join', '/domain/group/join', DomainGroupJoinHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('domain_join_applications', '/domain/join_applications', DomainJoinApplicationsHandler);
    ctx.Route('domain_join', '/domain/join', DomainJoinHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('domain_search', '/domain/search', DomainSearchHandler, PRIV.PRIV_USER_PROFILE);
    await ctx.inject(['api'], ({ api }) => {
        api.provide(DomainApi);
    });
}
