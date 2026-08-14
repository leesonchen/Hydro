import {
    _, BadRequestError, DomainModel, ForbiddenError, Handler, PERM, PRIV,
    PrivilegeError, param, requireSudo, SettingModel, SystemModel,
    TokenModel, Types, UserModel, UserNotFoundError, ValidationError, RecordModel,
} from '../../../plugin-api';

let hasStore = false;
let hasYsr = false;
let banMode: 'allPrivilege' | 'noLogin' = 'allPrivilege';

function hasUserListAdmin(uid: number) {
    return `,${SystemModel.get('user-list.admin') || ''},`.includes(`,${uid},`);
}

export function setHasStore(v: boolean) { hasStore = v; }
export function setHasYsr(v: boolean) { hasYsr = v; }
export function setBanMode(v: 'allPrivilege' | 'noLogin') { banMode = v; }

function parseSetting(setting: any, key: string, value: any) {
    if (setting) {
        if (setting.flag & SettingModel.FLAG_DISABLED || (setting.flag & SettingModel.FLAG_SECRET && !value)) return;
        if (setting.type === 'boolean') return value === 'on';
        if (setting.type === 'number') {
            if (!Number.isSafeInteger(+value)) throw new ValidationError(key);
            return +value;
        }
        return value;
    }
}

// 基类：检查权限
export class UserBaseHandler extends Handler {
    async __prepare(args: { domainId: string }) {
        this.checkUserListPerm(args.domainId);
    }

    checkUserListPerm(domainId: string) {
        if (hasYsr) {
            this.checkPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD);
        } else if (domainId === 'system') {
            this.checkSystemWidePerm();
        } else {
            this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        }
    }

    hasSystemPriv() {
        if (this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) return true;
        return `,${SystemModel.get('user-list.admin') || ''},`.includes(`,${this.user._id},`);
    }

    checkSystemWidePerm() {
        if (hasYsr) {
            this.checkPerm(PERM.PERM_VIEW_HOMEWORK_HIDDEN_SCOREBOARD);
        } else {
            if (this.hasSystemPriv()) return;
            throw new PrivilegeError(PRIV.PRIV_EDIT_SYSTEM);
        }
    }
}

// 用户列表
export class UserListHandler extends UserBaseHandler {
    @requireSudo
    @param('uidOrName', Types.String, true)
    @param('school', Types.String, true)
    @param('studentId', Types.String, true)
    @param('phone', Types.String, true)
    @param('loginAt', Types.Range(['1d', '1w', '1m', '6m', '-1d', '-1w', '-1m', '-6m']), true)
    @param('banStatus', Types.Range(['banned', 'active']), true)
    @param('group', Types.String, true)
    @param('page', Types.PositiveInt, true)
    @param('sortBy', Types.String, true)
    @param('sortOrder', Types.String, true)
    async get(
        domainId: string,
        uidOrName?: string,
        school?: string,
        studentId?: string,
        phone?: string,
        loginAt?: string,
        banStatus?: string,
        group = '',
        page = 1,
        sortBy = '_id',
        sortOrder = 'asc',
    ) {
        const originalPath = ((this.context as any).originalPath || (this.request as any).originalPath) as string | undefined;
        if (originalPath && /^\/d\/[^/]+\/manage\/users(?:\/|$)/.test(originalPath)) {
            this.response.redirect = `/manage/users${this.context.search || ''}`;
            return;
        }

        const groups = await UserModel.listGroup(domainId);
        const filter: any = { _id: { $gt: 1 } };

        // 域过滤
        if (domainId !== 'system') {
            if (hasYsr && !hasStore) {
                filter._id = { $in: (await DomainModel.getMultiUserInDomain(domainId, {}).toArray()).map((d: any) => d.uid) };
            } else {
                filter.parentDomain = { $in: [domainId, this.user._id] };
            }
        }

        // 搜索过滤
        if (uidOrName) {
            filter.$or = [
                { unameLower: new RegExp(_.escapeRegExp(uidOrName.toLowerCase())) },
                { mailLower: new RegExp(_.escapeRegExp(uidOrName.toLowerCase())) },
                { _id: +uidOrName },
            ];
        }
        if (school) filter.school = new RegExp(_.escapeRegExp(school));
        if (studentId) filter.studentId = new RegExp(`^${_.escapeRegExp(studentId)}`);
        if (phone) filter.phone = new RegExp(_.escapeRegExp(phone));
        if (loginAt) {
            const unit = loginAt[loginAt.length - 1] === 'd' ? 86400000
                : loginAt[loginAt.length - 1] === 'w' ? 604800000
                    : 86400000 * 30;
            if (loginAt[0] === '-') {
                filter.loginat = { $lte: new Date(Date.now() - +loginAt[1] * unit) };
            } else {
                filter.loginat = { $gte: new Date(Date.now() - +loginAt[0] * unit) };
            }
        }
        if (group) {
            filter.$and = [{ _id: { $in: groups.find((g: any) => g.name === group)?.uids || [] } }];
        }

        this.response.template = 'userlist/users.html';

        const extraKeys = ['endAt'];
        const settings = SettingModel.ACCOUNT_SETTINGS
            .filter((s: any) => extraKeys.includes(s.key) || (s.family === 'setting_info' && !['bio', 'gender', 'avatar'].includes(s.key)))
            .concat([
                SettingModel.Setting('setting_info', 'loginat', '', 'text', 'Last Login Time', null),
                SettingModel.Setting('setting_info', 'loginip', '', 'text', 'Last Login IP', null),
                SettingModel.Setting('setting_info', 'domains', '', 'text', 'Domains', null),
            ]);

        this.response.body = {
            hasSystemWidePerm: this.hasSystemPriv(),
            routerName: this.context.routerName,
            settings,
            defaultFields: this.ctx.setting?.get?.('user-list.defaultFields'),
            page_name: domainId === 'system' ? 'manage_users_list' : 'domain_users_list',
            groups,
        };

        // 封禁状态筛选
        if (banStatus === 'banned') {
            filter.priv = { $bitsAllClear: [2] };
        } else if (banStatus === 'active') {
            filter.priv = { $bitsAnySet: [2] };
        }

        const pageSize = 100;
        const allowedSortFields: Record<string, string> = {
            _id: '_id',
            unameLower: 'unameLower',
            mailLower: 'mailLower',
            school: 'school',
            studentId: 'studentId',
            phone: 'phone',
            loginat: 'loginat',
            priv: 'priv',
            lastSubmitAt: 'lastSubmitAt',
        };
        const normalizedSortOrder = sortOrder === 'desc' ? 'desc' : 'asc';
        const normalizedSortBy = allowedSortFields[sortBy] ? sortBy : '_id';

        const total = await UserModel.coll.countDocuments(filter);
        let uids: number[] = [];

        if (normalizedSortBy !== 'lastSubmitAt') {
            uids = (await UserModel.getMulti(filter)
                .sort({ [allowedSortFields[normalizedSortBy]]: normalizedSortOrder === 'desc' ? -1 : 1 })
                .limit(pageSize)
                .skip((page - 1) * pageSize)
                .project({ _id: 1 })
                .toArray()).map((u: any) => u._id);
        } else {
            // Performance: derive uid constraint from user filter if possible, then sort by record time.
            const recordMatch: any = {};
            const uidFilter = filter._id;
            if (uidFilter && typeof uidFilter === 'object') {
                if (uidFilter.$in) recordMatch.uid = { $in: uidFilter.$in };
                else if (uidFilter.$gt) recordMatch.uid = { $gt: uidFilter.$gt };
                else if (uidFilter.$gte) recordMatch.uid = { $gte: uidFilter.$gte };
            } else if (typeof uidFilter === 'number') {
                recordMatch.uid = uidFilter;
            }

            const userFilterForLookup = { ...filter };
            // _id is matched via uid; move other constraints into lookup filter.
            delete userFilterForLookup._id;

            const isSimpleUserFilter = Object.keys(userFilterForLookup).length === 0;
            const basePipeline: any[] = [];
            if (Object.keys(recordMatch).length) basePipeline.push({ $match: recordMatch });

            // Fast path: when there is no extra user filter, stream records by _id order.
            if (isSimpleUserFilter) {
                basePipeline.push(
                    { $sort: { _id: normalizedSortOrder === 'desc' ? -1 : 1 } },
                    { $group: { _id: '$uid', lastSubmitAt: { $first: '$_id' } } },
                    // Ensure stable ordering
                    { $sort: { lastSubmitAt: normalizedSortOrder === 'desc' ? -1 : 1, _id: 1 } },
                    { $skip: (page - 1) * pageSize },
                    { $limit: pageSize },
                    { $project: { _id: 1 } },
                );
            } else {
                // Correct path: keep only users matched by user filter, but still compute lastSubmitAt from record.
                basePipeline.push(
                    { $group: { _id: '$uid', lastSubmitAt: { $max: '$_id' } } },
                    { $sort: { lastSubmitAt: normalizedSortOrder === 'desc' ? -1 : 1, _id: 1 } },
                    {
                        $lookup: {
                            from: 'user',
                            let: { uid: '$_id' },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: { $eq: ['$_id', '$$uid'] },
                                        ...userFilterForLookup,
                                    },
                                },
                                { $project: { _id: 1 } },
                            ],
                            as: '_udoc',
                        },
                    },
                    { $match: { _udoc: { $ne: [] } } },
                    { $skip: (page - 1) * pageSize },
                    { $limit: pageSize },
                    { $project: { _id: 1 } },
                );
            }

            const rows = await RecordModel.coll.aggregate(basePipeline, { allowDiskUse: true } as any).toArray();
            uids = rows.map((r: any) => r._id);
        }

        const [udict, domainUsers, lastSubmitRows] = await Promise.all([
            UserModel.getList(domainId, uids),
            DomainModel.collUser.find({
                uid: { $in: uids },
                join: true,
                domainId: { $ne: 'system' },
            }).project({ uid: 1, domainId: 1 }).toArray(),
            RecordModel.coll.aggregate([
                { $match: { uid: { $in: uids } } },
                { $group: { _id: '$uid', lastSubmitAt: { $max: '$_id' } } },
            ]).toArray(),
        ]);

        const lastSubmitAtDict: Record<number, any> = {};
        for (const row of lastSubmitRows as any[]) {
            lastSubmitAtDict[row._id] = row.lastSubmitAt;
        }

        // 登录 IP 和 GeoIP
        const loginipDict: Record<number, any> = {};
        const userDomainMap: Record<number, string[]> = {};
        const locale = this.translate('geoip_locale') || 'en';
        const geoip = this.ctx.get('geoip') as any;

        for (const uid of uids) {
            const udoc = udict[uid];
            if (udoc?._loginip) {
                loginipDict[uid] = {
                    ip: udoc._loginip,
                    geoip: geoip?.lookup?.(udoc._loginip, locale) || '',
                };
            }
        }

        for (const du of domainUsers) {
            userDomainMap[du.uid] ||= [];
            userDomainMap[du.uid].push(du.domainId);
        }

        // 域信息
        const allDomainIds = Array.from(Object.values(userDomainMap).flat());
        const ddict = (allDomainIds.length
            ? await DomainModel.getMulti({ _id: { $in: allDomainIds } }).project({ _id: 1, name: 1 }).toArray()
            : []
        ).reduce((acc: any, d: any) => ({ ...acc, [d._id]: d.name }), {});

        Object.assign(this.response.body, {
            uids,
            udict,
            loginipDict,
            lastSubmitAtDict,
            userDomainMap,
            ddict,
            filterUidOrName: uidOrName,
            filterSchool: school,
            filterStudentId: studentId,
            filterPhone: phone,
            filterLoginAt: loginAt,
            banStatus,
            group,
            page,
            pageSize,
            total,
            totalPages: Math.ceil(total / pageSize),
            sortBy: normalizedSortBy,
            sortOrder: normalizedSortOrder,
        });
    }
}

// 用户编辑
export class UserEditHandler extends UserBaseHandler {
    current: any;

    @requireSudo
    @param('uid', Types.PositiveInt)
    async prepare(domainId: string, uid: number) {
        this.current = await UserModel.getById(domainId, uid);
        if (!this.current) throw new UserNotFoundError(uid);
        if (hasStore && !hasYsr && domainId !== 'system'
            && this.current.parentDomain !== domainId
            && this.current.parentDomain !== this.user._id) {
            throw new UserNotFoundError(uid);
        }
    }

    async get(args: { domainId: string }) {
        const { domainId } = args;
        this.response.template = 'userlist/user_edit.html';
        this.response.body = {
            routerName: this.context.routerName,
            category: 'account',
            current: this.current,
            settings: SettingModel.ACCOUNT_SETTINGS,
            hasRealname: !!SettingModel.ACCOUNT_SETTINGS.find((s: any) => s.key === 'realname'),
            page_name: domainId === 'system' ? 'manage_user_edit' : 'domain_user_edit',
        };

        if (domainId === 'system') {
            const dudict = await DomainModel.getDictUserByDomainId(this.current._id);
            const domainIds = Object.keys(dudict);
            const ddocs = await DomainModel.getMulti({ _id: { $in: domainIds } }).toArray();
            const filteredDdocs: any[] = [];
            const groupsMap: Record<string, string[]> = {};

            for (const ddoc of ddocs) {
                const du = dudict[ddoc._id];
                groupsMap[ddoc._id] = (await UserModel.listGroup(ddoc._id, this.current._id))
                    .map((g: any) => g.name)
                    .filter((n: string) => !+n);
                if (['default', 'guest'].includes(du.role)) {
                    delete dudict[ddoc._id];
                    continue;
                }
                filteredDdocs.push(ddoc);
            }

            this.response.body.ddocs = filteredDdocs;
            this.response.body.dudict = dudict;
            this.response.body.groups = groupsMap;
        }
    }

    async post(args: any) {
        const targetUser = await UserModel.getById('system', +args.uid);
        if (targetUser.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            throw new ForbiddenError('无法操作超级管理员账户。');
        }
        if (args.operation) return;

        const update: any = {};
        const booleanKeys = args.booleanKeys || {};
        delete args.booleanKeys;

        for (const key in args) {
            const val = parseSetting(SettingModel.SETTINGS_BY_KEY[key], key, args[key]);
            if (val !== undefined) update[key] = val;
        }
        for (const key in booleanKeys) {
            if (!args[key]) update[key] = false;
        }

        await UserModel.setById(+args.uid, update);
        this.back();
    }

    @param('uid', Types.Int)
    @param('password', Types.Password, true)
    async postResetPassword(domainId: string, uid: number, password = '123456') {
        if (!hasStore && !this.hasSystemPriv()) this.checkSystemWidePerm();
        await UserModel.setPassword(uid, password);
        await UserModel.setById(uid, {
            authenticators: [],
            tfa: false,
            requirePasswordChange: true,
        });
        this.back();
    }

    @param('uid', Types.Int)
    @param('displayName', Types.String)
    @param('targetDomain', Types.String, true)
    async postSetDisplayname(domainId: string, uid: number, displayName: string, targetDomain = '') {
        await DomainModel.setUserInDomain(targetDomain || domainId, uid, { displayName });
        this.back();
    }

    @param('uid', Types.Int)
    @param('uname', Types.Username)
    async postSetUsername(domainId: string, uid: number, uname: string) {
        this.checkSystemWidePerm();
        await UserModel.setUname(uid, uname);
        this.back();
    }

    @param('uid', Types.Int)
    @param('realname', Types.String, true)
    @param('mail', Types.Email, true)
    @param('phone', Types.String, true)
    async postSetInfo(args: any, uid: number, realname = '', mail = '', phone = '') {
        this.checkSystemWidePerm();
        const user = await UserModel.getById('system', uid);
        if (realname && user.realname !== realname) await UserModel.setById(uid, { realname });
        if (mail && user.mail !== mail) await UserModel.setById(uid, { mail });
        if (phone && user.phone !== phone) await UserModel.setById(uid, { phone });
        this.back();
    }

    @param('uid', Types.Int)
    @param('targetDomain', Types.String)
    @param('role', Types.String)
    async postSetRoleInDomain(args: any, uid: number, targetDomain: string, role: string) {
        if (!hasStore) this.checkSystemWidePerm();
        await DomainModel.setUserRole(targetDomain, uid, role);
        this.back();
    }

    @param('uid', Types.Int)
    async postBan(args: { domainId: string }, uid: number) {
        this.checkSystemWidePerm();
        const user = await UserModel.getById(args.domainId, uid);
        if (banMode === 'noLogin') {
            if (user.priv & PRIV.PRIV_USER_PROFILE) {
                await UserModel.setPriv(uid, user.priv - PRIV.PRIV_USER_PROFILE);
            } else {
                await UserModel.setPriv(uid, user.priv + PRIV.PRIV_USER_PROFILE);
            }
        } else if (user.priv) {
            await UserModel.ban(uid);
        } else {
            await UserModel.setPriv(uid, SystemModel.get('default.priv'));
        }
        this.back();
    }

    @param('uid', Types.Int)
    async postLogout(domainId: string, uid: number) {
        if (!hasStore) this.checkSystemWidePerm();
        await TokenModel.delByUid(uid);
        this.back();
    }
}

// 批量操作
export class UserBatchOperationHandler extends Handler {
    @requireSudo
    async prepare() {
        if (this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) return;
        if (hasUserListAdmin(this.user._id)) return;
        throw new PrivilegeError(PRIV.PRIV_EDIT_SYSTEM);
    }

    @param('uids', Types.NumericArray)
    @param('password', Types.String)
    async postResetPassword(domainId: string, uids: number[], password: string) {
        for (const uid of uids) {
            await UserModel.setPassword(uid, password);
            await UserModel.setById(uid, {
                authenticators: [],
                tfa: false,
                requirePasswordChange: true,
            });
        }
        this.response.body = { ok: 1 };
    }

    @param('uids', Types.NumericArray)
    async postLogout(domainId: string, uids: number[]) {
        for (const uid of uids) {
            await TokenModel.delByUid(uid);
        }
        this.response.body = { ok: 1 };
    }

    @param('uids', Types.NumericArray)
    async postBan(domainId: string, uids: number[]) {
        if (banMode === 'noLogin') {
            for (const uid of uids) {
                const user = await UserModel.getById('system', uid);
                if (user.priv & PRIV.PRIV_USER_PROFILE) {
                    await UserModel.setPriv(uid, user.priv - PRIV.PRIV_USER_PROFILE);
                }
            }
        } else {
            for (const uid of uids) {
                await UserModel.ban(uid);
            }
        }
        this.response.body = { ok: 1 };
    }

    @param('uids', Types.NumericArray)
    async postUnban(domainId: string, uids: number[]) {
        if (banMode === 'noLogin') {
            for (const uid of uids) {
                const user = await UserModel.getById('system', uid);
                if (!(user.priv & PRIV.PRIV_USER_PROFILE)) {
                    await UserModel.setPriv(uid, user.priv + PRIV.PRIV_USER_PROFILE);
                }
            }
        } else {
            for (const uid of uids) {
                await UserModel.setPriv(uid, SystemModel.get('default.priv'));
            }
        }
        this.response.body = { ok: 1 };
    }
}

// 设置显示名（API）
export class DisplayNameSetHandler extends Handler {
    @param('uid', Types.PositiveInt)
    @param('displayName', Types.String)
    async all(domainId: string, uid: number, displayName: string) {
        await DomainModel.setUserInDomain(domainId, uid, { displayName });
        this.response.body = { ok: 1 };
    }
}
