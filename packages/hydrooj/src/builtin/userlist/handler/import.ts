import {
    BadRequestError, DomainModel, Handler, MessageModel, param, PERM, PRIV,
    Types, UserModel,
} from '../../../plugin-api';
import { UserBaseHandler, setHasStore } from './user';

let hasStore = false;

export function setImportHasStore(v: boolean) { hasStore = v; }

// 批量创建用户
async function bulkCreateUsers(
    ctx: any,
    domainId: string,
    users: any[],
    groupMap: Record<string, string[]>,
) {
    const uidByEmail: Record<string, number> = {};
    const errors: string[] = [];

    for (const u of users) {
        try {
            const uid = await UserModel.create(u.email, u.username, u.password);
            uidByEmail[u.email] = uid;

            const extra: any = {};
            if (u.displayName) {
                await DomainModel.setUserInDomain(domainId, uid, { displayName: u.displayName });
            }
            if (u.school) extra.school = u.school;
            if (u.studentId) extra.studentId = u.studentId;
            if (hasStore && domainId !== 'system') extra.parentDomain = domainId;
            if (domainId !== 'system') {
                extra.pinnedDomains = [domainId];
                await DomainModel.setUserInDomain(domainId, uid, { join: true, role: u.role || 'default' });
            }
            if (u.contestMode) extra.contestMode = true;
            if (Object.keys(extra).length) await UserModel.setById(uid, extra);
            await ctx.serial('user/import/create', uid, u);
        } catch (e: any) {
            errors.push(e.message);
        }
    }

    // 设置用户组
    const allGroups = await UserModel.listGroup(domainId);
    for (const group in groupMap) {
        const uids = groupMap[group].map((email) => uidByEmail[email]).filter((uid) => uid);
        const existing = allGroups.find((g: any) => g.name === group)?.uids || [];
        if (uids.length) {
            await UserModel.updateGroup(domainId, group, Array.from(new Set([...existing, ...uids])));
        }
    }

    return errors;
}

// 系统用户导入
export class UserlistSystemUserImportHandler extends UserBaseHandler {
    async prepare() {
        if (hasStore) {
            this.checkPerm(PERM.PERM_EDIT_DOMAIN);
        } else {
            this.checkSystemWidePerm('import');
        }
    }

    async get() {
        this.response.body.users = [];
        this.response.body.usersText = '';
        this.response.body.isDraft = false;
        this.response.template = 'userlist/manage_user_import.html';
    }

    @param('users', Types.String)
    @param('draft', Types.Boolean)
    async post(domainId: string, usersText: string, draft: boolean) {
        const lines = usersText.split('\n');
        const users: any[] = [];
        const messages: string[] = [];
        const groupMap: Record<string, string[]> = {};

        for (const idx in lines) {
            const line = lines[idx];
            if (!line.trim()) continue;

            let [email, username, password, displayName, extra] = line.split('\t').map((s) => s.trim());
            if (!email || !username || !password) {
                const parts = line.split(',').map((s) => s.trim());
                [email, username, password, displayName] = parts;
                if (parts.length > 5) extra = parts.slice(4).join(',');
                else [,,, , extra] = parts;
            }

            if (email && username && password) {
                if (!Types.Email[1](email)) {
                    messages.push(`Line ${+idx + 1}: Invalid email.`);
                } else if (!Types.Username[1](username)) {
                    messages.push(`Line ${+idx + 1}: Invalid username`);
                } else if (!Types.Password[1](password)) {
                    messages.push(`Line ${+idx + 1}: Invalid password`);
                } else if (users.find((u) => u.email === email) || await UserModel.getByEmail('system', email)) {
                    messages.push(`Line ${+idx + 1}: Email ${email} already exists.`);
                } else if (users.find((u) => u.username === username) || await UserModel.getByUname('system', username)) {
                    messages.push(`Line ${+idx + 1}: Username ${username} already exists.`);
                } else {
                    const parsed: any = {};
                    try {
                        const extraData = JSON.parse(extra);
                        if (extraData.group) {
                            for (const g of extraData.group.split(',')) {
                                if (/^[0-9]+$/.test(g)) {
                                    messages.push(`Line ${+idx + 1}: Invalid group ${g}.`);
                                    continue;
                                }
                                groupMap[g] ||= [];
                                groupMap[g].push(email);
                            }
                        }
                        if (extraData.role && !/^[a-zA-Z0-9]+$/.test(extraData.role)) {
                            messages.push(`Line ${+idx + 1}: Invalid role ${extraData.role}.`);
                            continue;
                        }
                        if (extraData.school && typeof extraData.school !== 'string') {
                            messages.push(`Line ${+idx + 1}: Invalid school ${extraData.school}.`);
                            continue;
                        }
                        if (extraData.studentId && typeof extraData.studentId !== 'string') {
                            messages.push(`Line ${+idx + 1}: Invalid studentId ${extraData.studentId}.`);
                            continue;
                        }
                        Object.assign(parsed, extraData);
                    } catch { /* ignore */ }

                    Object.assign(parsed, { email, username, password, displayName });
                    await this.ctx.serial('user/import/parse', parsed);
                    users.push(parsed);
                }
            } else {
                messages.push(`Line ${+idx + 1}: Input invalid.`);
            }
        }

        messages.push(`${users.length} users imported.`);
        if (users.length > 100) messages.push('Too many users, max 100 at a time');

        if (!draft) {
            if (hasStore) {
                if (messages.length > 1) throw new BadRequestError('Please first fix all warnings');
                const store = this.ctx.get('store') as any;
                if (!store) throw new BadRequestError('Cannot get store service');
                if (users.length > 100) throw new BadRequestError('Too many users');

                await store.addToCart(this.user._id, {
                    price: users.length * 100,
                    amount: 1,
                    args: [domainId, users, groupMap],
                    type: 'bulk_create_user',
                    name: `批量创建用户（${domainId}）`,
                }, `/d/${this.domain._id}/users`);
                this.response.redirect = '/store/checkout';
                return;
            }
            messages.push(...await bulkCreateUsers(this.ctx, domainId, users, groupMap));
        }

        this.response.body.users = users;
        this.response.body.messages = messages;
        this.response.body.usersText = draft ? usersText : '';
        this.response.body.isDraft = draft;
        this.response.template = 'userlist/manage_user_import.html';
    }
}

// 处理 store/purchase 事件
export function registerStorePurchaseHandler(ctx: any) {
    ctx.on('store/purchase', async (buyer: any, type: string, args: any[]) => {
        if (type !== 'bulk_create_user') return;
        const errors = await bulkCreateUsers(ctx, args[0], args[1], args[2]);
        if (errors.length) {
            await MessageModel.send(1, buyer._id, `批量创建时遇到了以下错误：\n${errors.join('\n')}`);
        } else {
            await MessageModel.send(1, buyer._id, `批量创建用户成功，共创建 ${args[1].length} 个用户。`);
        }
    });
}
