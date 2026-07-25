import {
    DomainModel, Handler, param, PERM, PRIV, Types, UserModel, ValidationError,
} from '../../../plugin-api';

// 批量设置用户权限（域内）
export class BulkImportHandler extends Handler {
    async get() {
        this.response.body.users = [];
        this.response.template = 'userlist/domain_bulk_import.html';
    }

    @param('users', Types.Content)
    @param('draft', Types.Boolean)
    async postGroup(domainId: string, users: string, draft = false) {
        const lines = users.split('\n');
        const messages: string[] = [];
        const groupMap: Record<string, number[]> = {};
        const roleMap: Record<string, number[]> = {};

        for (const idx in lines) {
            const line = lines[idx];
            if (!line.trim()) continue;

            let [uname, role, group] = line.split(',').map((s) => s.trim());
            if (!role) {
                [uname, role, group] = line.split('\t').map((s) => s.trim());
            }

            if (uname && role) {
                if (!Types.Username[1](uname)) {
                    messages.push(`Line ${+idx + 1}: Invalid uname.`);
                } else if (!Types.Name[1](role)) {
                    messages.push(`Line ${+idx + 1}: Invalid role name.`);
                } else {
                    const udoc = await UserModel.getByUname(domainId, uname)
                        || await UserModel.getById(domainId, +uname)
                        || await UserModel.getByEmail(domainId, uname);
                    if (!udoc) {
                        messages.push(`Line ${+idx + 1}: User ${uname} not found.`);
                        continue;
                    }
                    roleMap[role] ||= [];
                    roleMap[role].push(udoc._id);
                    if (group) {
                        if (Types.Name[1](group)) {
                            groupMap[group] ||= [];
                            groupMap[group].push(udoc._id);
                        } else {
                            messages.push(`Line ${+idx + 1}: Invalid group name.`);
                        }
                    }
                }
            } else {
                messages.push(`Line ${+idx + 1}: Input invalid.`);
            }
        }

        // 验证角色存在
        const existingRoles = (await DomainModel.getRoles(domainId)).map((r: any) => r._id);
        for (const role of Object.keys(roleMap)) {
            if (existingRoles.includes(role)) {
                messages.push(`Domain ${domainId}: found ${roleMap[role].length} users to add role ${role}.`);
            } else {
                messages.push(`Domain ${domainId}: Role ${role} not found.`);
                delete roleMap[role];
            }
        }

        const allGroups = await UserModel.listGroup(domainId);
        const classGroupNames = new Set(
            allGroups.filter((existing: any) => existing.class).map((existing: any) => existing.name),
        );
        for (const group of Object.keys(groupMap)) {
            if (classGroupNames.has(group)) {
                messages.push(`Domain ${domainId}: Group ${group} conflicts with an existing class.`);
                delete groupMap[group];
                continue;
            }
            messages.push(`Domain ${domainId}: found ${groupMap[group].length} users to add group ${group}.`);
        }

        const completes: string[] = [];
        if (!draft) {
            // 设置角色
            for (const role of Object.keys(roleMap)) {
                for (const uid of roleMap[role]) {
                    await DomainModel.setUserRole(domainId, uid, role);
                }
                completes.push(`Roles:${domainId}/${role}`);
            }

            // 设置用户组
            const currentGroups = await UserModel.listGroup(domainId);
            for (const group of Object.keys(groupMap)) {
                const existingGroup = currentGroups.find((g: any) => g.name === group);
                if (existingGroup?.class) {
                    messages.push(`Domain ${domainId}: Group ${group} conflicts with an existing class.`);
                    continue;
                }
                const existing = existingGroup?.uids || [];
                const merged = [...new Set([...groupMap[group], ...existing])];
                try {
                    await UserModel.updateGroup(domainId, group, merged);
                } catch (error) {
                    if (!(error instanceof ValidationError)) throw error;
                    messages.push(`Domain ${domainId}: Group ${group} conflicts with an existing class.`);
                    continue;
                }
                completes.push(`Groups:${domainId}/${group}`);
            }
        }

        this.response.body.completes = completes;
        this.response.body.messages = messages;
    }

    @param('users', Types.Content)
    @param('draft', Types.Boolean)
    async postPassword(domainId: string, users: string, draft = false) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);

        const lines = users.split('\n');
        const messages: string[] = [];
        const completes: string[] = [];

        for (const idx in lines) {
            const line = lines[idx];
            if (!line.trim()) continue;

            let [uname, password] = line.split(',').map((s) => s.trim());
            if (!password) {
                [uname, password] = line.split('\t').map((s) => s.trim());
            }

            if (uname && password) {
                if (!Types.Username[1](uname)) {
                    messages.push(`Line ${+idx + 1}: Invalid uname.`);
                } else if (!Types.Password[1](password)) {
                    messages.push(`Line ${+idx + 1}: Invalid password.`);
                } else {
                    const udoc = await UserModel.getByUname(domainId, uname)
                        || await UserModel.getById(domainId, +uname)
                        || await UserModel.getByEmail(domainId, uname);
                    if (!udoc) {
                        messages.push(`Line ${+idx + 1}: User ${uname} not found.`);
                        continue;
                    }
                    if (!draft) {
                        await UserModel.setPassword(udoc._id, password);
                        messages.push(`Line ${+idx + 1}: User ${uname} password set.`);
                        completes.push(`Password:${domainId}/${uname}`);
                    }
                }
            } else {
                messages.push(`Line ${+idx + 1}: Input invalid.`);
            }
        }

        this.response.body.completes = completes;
        this.response.body.messages = messages;
    }
}
