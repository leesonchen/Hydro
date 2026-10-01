import { Dictionary, escapeRegExp } from 'lodash';
import { LRUCache } from 'lru-cache';
import { Filter } from 'mongodb';
import { Context } from '../context';
import { NotFoundError, ValidationError } from '../error';
import { DomainDoc } from '../interface';
import bus from '../service/bus';
import db from '../service/db';
import { MaybeArray, NumberKeys } from '../typeutils';
import { ArgMethod } from '../utils';
import { BUILTIN_ROLES, PRIV } from './builtin';
import UserModel, { deleteUserCache } from './user';

const coll = db.collection('domain');
const collUser = db.collection('domain.user');
const cache = new LRUCache<string, DomainDoc>({ max: 1000, ttl: 300 * 1000 });
const cacheVersion = Symbol('domainCacheVersion');

function setCache(key: string, ddoc: DomainDoc | null) {
    if (ddoc) {
        Object.defineProperty(ddoc, cacheVersion, {
            value: Date.now(),
            enumerable: false,
            configurable: true,
        });
    }
    cache.set(key, ddoc);
}

interface DomainUserArg {
    _id: number;
    priv: number;
}

interface RoleDoc {
    _id: string;
    perm: bigint;
    default: boolean;
    priority: number;
    count?: number;
}

function getRoleMeta(roles: RoleDoc[]): NonNullable<DomainDoc['roleMeta']> {
    return Object.fromEntries(roles.map((role) => [role._id, {
        default: role.default,
        priority: role.priority,
    }]));
}

function getRoleSnapshotFilter(ddoc: DomainDoc): Filter<DomainDoc> {
    return {
        _id: ddoc._id,
        roles: ddoc.roles === undefined ? { $exists: false } : ddoc.roles,
        roleMeta: ddoc.roleMeta === undefined ? { $exists: false } : ddoc.roleMeta,
    };
}

class DomainModel {
    static coll = coll;
    static collUser = collUser;
    static getVersion = (ddoc) => ddoc ? ddoc[cacheVersion] : null;

    static JOIN_METHOD_NONE = 0;
    static JOIN_METHOD_ALL = 1;
    static JOIN_METHOD_CODE = 2;

    static JOIN_METHOD_RANGE = {
        [DomainModel.JOIN_METHOD_NONE]: 'No user is allowed to join this domain',
        [DomainModel.JOIN_METHOD_ALL]: 'Any user is allowed to join this domain',
        [DomainModel.JOIN_METHOD_CODE]: 'Any user is allowed to join this domain with an invitation code',
    };

    static JOIN_EXPIRATION_KEEP_CURRENT = 0;
    static JOIN_EXPIRATION_UNLIMITED = -1;

    static JOIN_EXPIRATION_RANGE = {
        [DomainModel.JOIN_EXPIRATION_KEEP_CURRENT]: 'Keep current expiration',
        3: 'In 3 hours',
        24: 'In 1 day',
        [24 * 3]: 'In 3 days',
        [24 * 7]: 'In 1 week',
        [24 * 30]: 'In 1 month',
        [DomainModel.JOIN_EXPIRATION_UNLIMITED]: 'Never expire',
    };

    @ArgMethod
    static async add(domainId: string, owner: number, name: string, bulletin: string) {
        const ddoc: DomainDoc = {
            _id: domainId,
            lower: domainId.toLowerCase(),
            owner,
            name,
            bulletin,
            roles: {},
            roleMeta: {
                guest: { default: false, priority: 0 },
                default: { default: true, priority: 1 },
                root: { default: false, priority: 2 },
            },
            avatar: '',
        };
        await bus.parallel('domain/create', ddoc);
        await coll.insertOne(ddoc);
        await DomainModel.setUserRole(domainId, owner, 'root', true);
        return domainId;
    }

    @ArgMethod
    static async get(domainId: string): Promise<DomainDoc | null> {
        domainId = domainId.toLowerCase();
        const key = `id::${domainId}`;
        if (cache.has(key)) return cache.get(key);
        const query: Filter<DomainDoc> = { lower: domainId };
        await bus.parallel('domain/before-get', query);
        const result = await coll.findOne(query);
        if (result) {
            await bus.parallel('domain/get', result);
            setCache(key, result);
        }
        return result;
    }

    @ArgMethod
    static async getByHost(host: string): Promise<DomainDoc | null> {
        const key = `host::${host}`;
        // Note: cache by host might not be updated immediately
        if (cache.has(key)) return cache.get(key);
        const query: Filter<DomainDoc> = { host };
        await bus.parallel('domain/before-get', query);
        const result = await coll.findOne(query);
        if (result) {
            await bus.parallel('domain/get', result);
            setCache(key, result);
        } else {
            cache.set(key, null);
        }
        return result;
    }

    static getMulti(query: Filter<DomainDoc> = {}) {
        return coll.find(query);
    }

    static async edit(domainId: string, $set: Partial<DomainDoc>) {
        domainId = domainId.toLowerCase();
        await bus.parallel('domain/before-update', domainId, $set);
        const result = await coll.findOneAndUpdate({ lower: domainId }, { $set }, { returnDocument: 'after' });
        if (result) {
            await bus.parallel('domain/update', domainId, $set, result);
            bus.broadcast('domain/delete-cache', domainId);
        }
        return result;
    }

    @ArgMethod
    static async inc(domainId: string, field: NumberKeys<DomainDoc>, n: number): Promise<number | null> {
        domainId = domainId.toLowerCase();
        const value = await coll.findOneAndUpdate(
            { _id: domainId },
            { $inc: { [field]: n } as any },
            { returnDocument: 'after' },
        );
        bus.broadcast('domain/delete-cache', domainId);
        return value?.[field];
    }

    @ArgMethod
    static async getList(domainIds: string[]) {
        const r: Record<string, DomainDoc | null> = {};
        await Promise.all(domainIds.map((domainId) => DomainModel.get(domainId).then((ddoc) => { r[domainId] = ddoc; })));
        return r;
    }

    static async countUser(domainId: string, role?: string) {
        if (role) return await collUser.countDocuments({ domainId, role, join: true });
        return await collUser.countDocuments({ domainId, join: true });
    }

    @ArgMethod
    static async setUserRole(domainId: string, uid: MaybeArray<number>, role: string, autojoin = false) {
        const update = { $set: { role, ...(autojoin ? { join: true } : {}) } };
        if (!(Array.isArray(uid))) {
            const res = await collUser.findOneAndUpdate(
                { domainId, uid },
                update,
                { upsert: true, returnDocument: 'after', includeResultMetadata: true },
            );
            const udoc = await UserModel.getById(domainId, uid);
            deleteUserCache(udoc);
            return res;
        }
        const affected = await UserModel.getMulti({ _id: { $in: uid } })
            .project<{ _id: number, mail: string, uname: string }>({ mail: 1, uname: 1 })
            .toArray();
        for (const udoc of affected) deleteUserCache(udoc);
        return await collUser.updateMany({ domainId, uid: { $in: uid } }, update, { upsert: true });
    }

    static async setJoin(domainId: string, uid: MaybeArray<number>, join: boolean) {
        if (!(Array.isArray(uid))) {
            await DomainModel.updateUserInDomain(domainId, uid, { $set: { join } });
            return;
        }
        await collUser.updateMany({ domainId, uid: { $in: uid } }, { $set: { join } });
        deleteUserCache(domainId);
    }

    static async leave(domainId: string, uid: number) {
        const udoc = await UserModel.getById(domainId, uid);
        deleteUserCache(udoc);
        return await collUser.updateOne(
            {
                domainId,
                uid,
                join: true,
                role: { $ne: 'guest' },
            },
            {
                $set: {
                    join: false,
                    requireInvitation: true,
                    role: 'default',
                },
            },
        );
    }

    static async getRoles(domainId: string, count?: boolean): Promise<any[]>;
    static async getRoles(domain: DomainDoc, count?: boolean): Promise<any[]>;
    @ArgMethod
    static async getRoles(arg: string | DomainDoc, count: boolean = false): Promise<any[]> {
        let ddoc: DomainDoc;
        if (typeof arg === 'string') ddoc = await DomainModel.get(arg);
        else ddoc = arg;
        if (!ddoc) return [];

        const storedRoles = ddoc.roles || {};
        const roleNames = [
            'default',
            ...Object.keys(storedRoles).filter((role) => !Object.hasOwn(BUILTIN_ROLES, role)),
        ];
        const roleMeta = ddoc.roleMeta || {};
        // Unconfigured domains start with default below custom roles. Missing
        // metadata is appended without changing an existing configured order.
        const ordered = roleNames.map((name, index) => ({
            _id: name,
            index,
            sortPriority: Number.isSafeInteger(roleMeta[name]?.priority) && roleMeta[name].priority > 0
                ? roleMeta[name].priority : Infinity,
        })).sort((a, b) => (a.sortPriority - b.sortPriority) || (a.index - b.index));
        const defaultRole = ordered.find((role) => roleMeta[role._id]?.default === true)?._id || 'default';
        const roles: RoleDoc[] = [
            {
                _id: 'guest',
                perm: BigInt(storedRoles.guest ?? BUILTIN_ROLES.guest),
                default: false,
                priority: 0,
            },
            ...ordered.map((role, index) => ({
                _id: role._id,
                perm: BigInt(storedRoles[role._id] ?? BUILTIN_ROLES[role._id]),
                default: role._id === defaultRole,
                priority: index + 1,
            })),
            {
                _id: 'root',
                perm: BigInt(storedRoles.root ?? BUILTIN_ROLES.root),
                default: false,
                priority: ordered.length + 1,
            },
        ];
        if (count) {
            await Promise.all(roles.filter((i) => i._id !== 'guest').map(async (role) => {
                role.count = await DomainModel.countUser(ddoc._id, role._id);
            }));
        }
        return roles;
    }

    static getDefaultRole(roles: RoleDoc[]) {
        return roles.find((role) => role.default && !['guest', 'root'].includes(role._id))?._id
            || roles.find((role) => role._id === 'default')?._id
            || 'default';
    }

    static getRolePriority(roles: RoleDoc[], role: string | undefined) {
        if (!role) return -1;
        return roles.find((item) => item._id === role)?.priority ?? -1;
    }

    private static async updateRoles(domainId: string, update: (roles: Dictionary<string>) => void) {
        // Recompute the order from the latest document when another role write wins.
        while (true) {
            // eslint-disable-next-line no-await-in-loop
            const current = await coll.findOne({ _id: domainId });
            if (!current) throw new NotFoundError(domainId);
            const updatedRoles = { ...current.roles };
            update(updatedRoles);
            // eslint-disable-next-line no-await-in-loop
            const roles = await DomainModel.getRoles({ ...current, roles: updatedRoles });
            // eslint-disable-next-line no-await-in-loop
            const result = await coll.updateOne(
                getRoleSnapshotFilter(current),
                { $set: { roles: updatedRoles, roleMeta: getRoleMeta(roles) } },
            );
            if (!result.matchedCount) continue;
            deleteUserCache(domainId);
            bus.broadcast('domain/delete-cache', domainId.toLowerCase());
            return result;
        }
    }

    static async setRoles(domainId: string, roles: Dictionary<bigint | string>) {
        return await DomainModel.updateRoles(domainId, (updatedRoles) => {
            for (const role in roles) updatedRoles[role] = roles[role].toString();
        });
    }

    static async addRole(domainId: string, name: string, permission: bigint) {
        return await DomainModel.updateRoles(domainId, (updatedRoles) => {
            updatedRoles[name] = permission.toString();
        });
    }

    /**
     * Store one default invitation role and a permutation of role positions.
     * Guest and root stay at the two fixed ends of that order.
     */
    static async setRoleMeta(domainId: string, settings: NonNullable<DomainDoc['roleMeta']>) {
        const current = await coll.findOne({ _id: domainId });
        if (!current) throw new NotFoundError(domainId);
        const roles = await DomainModel.getRoles(current);
        if (!settings || Object.keys(settings).length !== roles.length
            || roles.some((role) => !Object.hasOwn(settings, role._id))) {
            throw new ValidationError('roles', null, 'Roles have changed. Please refresh and try again.');
        }
        const updated = roles.map((role) => {
            const meta = settings[role._id];
            if (!meta || typeof meta.default !== 'boolean'
                || !Number.isSafeInteger(meta.priority) || meta.priority < 0 || meta.priority >= roles.length) {
                throw new ValidationError('priority', null, 'Role priorities must be unique positions in the role order.');
            }
            if (['guest', 'root'].includes(role._id) && (meta.priority !== role.priority || meta.default)) {
                throw new ValidationError('priority', null, 'Guest and root must stay at the ends of the role order.');
            }
            return { ...role, ...meta };
        });
        if (new Set(updated.map((role) => role.priority)).size !== roles.length) {
            throw new ValidationError('priority', null, 'Role priorities must be unique positions in the role order.');
        }
        if (updated.filter((role) => role.default).length !== 1) {
            throw new ValidationError('default', null, 'Select exactly one default invitation role.');
        }
        const roleMeta = getRoleMeta(updated);
        const result = await coll.updateOne(
            getRoleSnapshotFilter(current),
            { $set: { roleMeta } },
        );
        if (!result.matchedCount) throw new ValidationError('roles', null, 'Roles have changed. Please refresh and try again.');
        deleteUserCache(domainId);
        bus.broadcast('domain/delete-cache', domainId.toLowerCase());
        return result;
    }

    static async deleteRoles(domainId: string, roles: string[]) {
        await DomainModel.updateRoles(domainId, (updatedRoles) => {
            for (const role of roles) delete updatedRoles[role];
        });
        try {
            await collUser.updateMany({ domainId, role: { $in: roles } }, { $set: { role: 'default' } });
        } finally {
            deleteUserCache(domainId);
        }
    }

    static async getDomainUser(domainId: string, udoc: DomainUserArg) {
        let dudoc = await collUser.findOne({ domainId, uid: udoc._id });
        dudoc ||= { domainId, uid: udoc._id };
        if (!(udoc.priv & PRIV.PRIV_USER_PROFILE)) dudoc.role = 'guest';
        if (!dudoc.join && !(udoc.priv & PRIV.PRIV_VIEW_ALL_DOMAIN)) dudoc.role = 'guest';
        if (udoc.priv & PRIV.PRIV_MANAGE_ALL_DOMAIN) dudoc.role = 'root';
        dudoc.role ||= 'default';
        const ddoc = await DomainModel.get(domainId);
        dudoc.perm = ddoc?.roles[dudoc.role]
            ? BigInt(ddoc?.roles[dudoc.role])
            : BUILTIN_ROLES[dudoc.role];
        return dudoc;
    }

    static getDomainUserMulti(domainId: string, uids: number[]) {
        return collUser.find({ domainId, uid: { $in: uids } });
    }

    static setMultiUserInDomain(domainId: string, query: any, params: any) {
        deleteUserCache(domainId);
        return collUser.updateMany({ domainId, ...query }, { $set: params }, { upsert: true });
    }

    static getMultiUserInDomain(domainId: string, query: any = {}) {
        return collUser.find({ domainId, ...query });
    }

    static async setUserInDomain(domainId: string, uid: number, params: any) {
        const udoc = await UserModel.getById(domainId, uid);
        deleteUserCache(udoc);
        return await collUser.updateOne({ domainId, uid }, { $set: params }, { upsert: true });
    }

    static async updateUserInDomain(domainId: string, uid: number, update: any) {
        const udoc = await UserModel.getById(domainId, uid);
        deleteUserCache(udoc);
        return await collUser.updateOne({ domainId, uid }, update, { upsert: true });
    }

    static async joinUserInDomain(domainId: string, uid: number, role = 'default') {
        const [udoc, roles] = await Promise.all([
            UserModel.getById(domainId, uid),
            DomainModel.getRoles(domainId),
        ]);
        const requestedPriority = DomainModel.getRolePriority(roles, role);
        const requestedRole = requestedPriority < 0 ? 'default' : role;
        const roleBranches = roles.map((item) => ({
            case: { $eq: [{ $ifNull: ['$role', 'default'] }, item._id] },
            then: item.priority,
        }));
        const currentPriority = { $switch: { branches: roleBranches, default: -1 } };
        const shouldAssignRole = {
            $or: [
                { $ne: ['$join', true] },
                // Missing invitation roles only repair invalid memberships; they cannot upgrade valid members.
                { $lt: [currentPriority, Math.max(requestedPriority, 0)] },
            ],
        };
        let result = await collUser.findOneAndUpdate(
            { domainId, uid },
            [{
                $set: {
                    join: { $cond: [{ $eq: ['$role', 'guest'] }, '$join', true] },
                    role: {
                        $cond: [
                            { $eq: ['$role', 'guest'] },
                            '$role',
                            { $cond: [shouldAssignRole, requestedRole, { $ifNull: ['$role', 'default'] }] },
                        ],
                    },
                    requireInvitation: {
                        $cond: [{ $eq: ['$role', 'guest'] }, '$requireInvitation', '$$REMOVE'],
                    },
                },
            }],
            { upsert: true, returnDocument: 'after' },
        );
        if (result?.role === requestedRole && !Object.hasOwn(BUILTIN_ROLES, requestedRole)) {
            let roleExists = false;
            try {
                const current = await coll.findOne({ _id: domainId }, { projection: { roles: 1 } });
                roleExists = Object.hasOwn(current?.roles || {}, requestedRole);
            } catch { /* Treat an unverifiable custom role as invalid. */ }
            if (!roleExists) {
                try {
                    result = await collUser.findOneAndUpdate(
                        { domainId, uid, join: true, role: requestedRole },
                        { $set: { role: 'default' } },
                        { returnDocument: 'after' },
                    ) || result;
                } catch { /* The join is already durable and cannot be safely rolled back here. */ }
            }
        }
        deleteUserCache(udoc);
        return result;
    }

    @ArgMethod
    static async incUserInDomain(domainId: string, uid: number, field: string, n: number = 1) {
        // @ts-ignore
        const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid });
        dudoc[field] = dudoc[field] + n || n;
        await DomainModel.setUserInDomain(domainId, uid, { [field]: dudoc[field] });
        return dudoc;
    }

    @ArgMethod
    static async getDictUserByDomainId(uid: number) {
        const dudocs = await collUser.find({ uid, join: true }).toArray();
        const dudict: Record<string, any> = {};
        for (const dudoc of dudocs) dudict[dudoc.domainId] = dudoc;
        return dudict;
    }

    static getJoinSettings(ddoc: DomainDoc, roles: string[]) {
        if (!ddoc._join) return null;
        const joinSettings = ddoc._join;
        if (![DomainModel.JOIN_METHOD_ALL, DomainModel.JOIN_METHOD_CODE].includes(joinSettings.method)) return null;
        if (!roles.includes(joinSettings.role) || joinSettings.role === 'guest') return null;
        if (joinSettings.expire && joinSettings.expire < new Date()) return null;
        return joinSettings;
    }

    @ArgMethod
    static async getPrefixSearch(prefix: string, limit: number = 50) {
        const $regex = new RegExp(escapeRegExp(prefix), 'im');
        const ddocs = await coll.find({
            $or: [{ _id: { $regex } }, { name: { $regex } }],
        }).limit(limit).toArray();
        return ddocs;
    }

    @ArgMethod
    static async del(domainId: string) {
        await coll.deleteOne({ _id: domainId });
        await collUser.deleteMany({ domainId });
        await bus.parallel('domain/delete', domainId);
        bus.broadcast('domain/delete-cache', domainId.toLowerCase());
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete-cache', async (domainId: string) => {
        const ddoc = await DomainModel.get(domainId);
        if (!ddoc) return;
        for (const host of ddoc.host || []) {
            cache.delete(`host::${host}`);
        }
        cache.delete(`id::${ddoc.lower}`);
    });
    await Promise.all([
        db.ensureIndexes(
            coll,
            { key: { lower: 1 }, name: 'lower', unique: true },
            { key: { host: 1 }, name: 'host', sparse: true },
        ),
        db.ensureIndexes(
            collUser,
            { key: { domainId: 1, uid: 1 }, name: 'uid', unique: true },
            { key: { domainId: 1, rp: -1, uid: 1 }, name: 'rp', sparse: true },
        ),
    ]);
}
export default DomainModel;
global.Hydro.model.domain = DomainModel;
