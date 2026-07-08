import Schema from 'schemastery';
import {
    Context, PERM, PRIV, SettingModel, SystemModel,
} from '../../plugin-api';
import {
    DisplayNameSetHandler, setBanMode, setHasStore, setHasYsr, UserBatchOperationHandler,
    UserEditHandler, UserListHandler,
} from './handler/user';
import { BulkImportHandler } from './handler/bulkimport';
import { registerStorePurchaseHandler, setImportHasStore, UserlistSystemUserImportHandler } from './handler/import';

export const name = 'userlist';
export const Config = Schema.object({
    banMode: Schema.union(['allPrivilege', 'noLogin']).default('allPrivilege'),
});

export async function apply(ctx: Context, config: any) {
    // 加载中文翻译
    ctx.i18n.load('zh', {
        'User List': '用户列表',
        'Import User': '导入用户',
        'Edit User Password': '批量修改密码',
        'Import Group': '导入用户组',
        Phone: '手机',
        'Display Name': '显示名',
        School: '学校',
        'Student ID': '学号',
        'Edit Profile': '编辑资料',
        'Save All Changes': '保存所有更改',
        Edit: '编辑',
        Visit: '访问',
        Manage: '管理',
        Name: '名称',
        ID: 'ID',
        Role: '角色',
        Group: '用户组',
        Action: '操作',
        Preview: '预览',
        Submit: '提交',
        'Last Login Time': '上次登录时间',
        'Last Login IP': '上次登录IP',
        Domains: '所属域',
        'Bulk Import': '批量导入',
        '(Not changed)': '（未更改）',
        manage_users_list: '用户列表管理',
        manage_users_import: '导入用户',
        domain_users_list: '用户列表管理',
        domain_bulk_import: '批量导入',
        course_users_list: '用户列表管理',
        Search: '搜索',
        User: '用户',
        Email: '邮箱',
        'Last Submit Time': '上次提交',
        'Joined Domains': '所属域',
        Ban: '封禁',
        'By Username or UID': '由用户名或 UID',
        'UID / Username / Email': 'UID / 用户名 / 邮箱',
        'By School': '根据学校',
        'By Student ID': '根据学号',
        'By Phone': '手机号',
        'Login Time': '登录时间',
        'Within 1 Day': '1 天内',
        'Within 1 Week': '1 周内',
        'Within 1 Month': '1 个月内',
        'Within 6 Months': '6 个月内',
        'More than 1 Day': '超过 1 天',
        'More than 1 Week': '超过 1 周',
        'More than 1 Month': '超过 1 个月',
        'More than 6 Months': '超过 6 个月',
        'Ban Status': '封禁状态',
        Active: '未封禁',
        Banned: '已封禁',
        'Bulk Reset Password': '批量重置密码',
        'Full Screen': '全屏',
        'Exit Full Screen': '退出全屏',
        'Bulk Force Logout': '批量强制登出',
        'Bulk Ban': '批量封禁',
        'Bulk Unban': '批量解封',
        'Previous Page': '上一页',
        'Next Page': '下一页',
        'No data. Please input filter conditions and click search.': '暂无数据，请输入搜索条件后点击搜索。',
        'Please input new password for {0}:': '请输入 {0} 的新密码：',
        'Please input a unified new password for selected users:': '请输入选定用户的统一新密码：',
        'Reset succeeded.': '重置成功',
        'Reset failed: {0}': '重置失败：{0}',
        'Batch operation succeeded.': '批量操作成功',
        'Operation failed: {0}': '操作失败：{0}',
        'Unknown error': '未知错误',
        '{0} records, Page {1}/{2}': '共 {0} 条记录，第 {1}/{2} 页',
    });

    // 设置配置（供 handler 使用）
    setBanMode(config.banMode as 'allPrivilege' | 'noLogin');

    // 注册设置项
    ctx.inject(['setting'], (c) => {
        c.setting.SystemSetting(
            SettingModel.Setting('setting_system', 'user-list.defaultFields', '_id,uname,mail,displayName,school,studentId,phone,domains', 'text', 'user-list.defaultFields', '用户列表默认显示字段（逗号分隔）'),
            SettingModel.Setting('setting_system', 'user-list.admin', '', 'text', 'user-list.admin', '用户列表管理员 UID（逗号分隔）'),
            SettingModel.Setting('setting_system', 'user-list.import', '', 'text', 'user-list.import', '用户导入权限 UID（逗号分隔）'),
        );
        c.setting.AccountSetting(
            SettingModel.Setting('setting_info', 'parentDomain', '', 'text', 'parentDomain', '所属域', SettingModel.FLAG_HIDDEN),
        );
    });

    // 基本路由（始终注册）
    ctx.Route('manage_users_list', '/manage/users', UserListHandler);
    ctx.Route('manage_users_import', '/manage/users/import', UserlistSystemUserImportHandler);
    ctx.Route('manage_user_edit', '/manage/user/:uid/edit', UserEditHandler);
    ctx.Route('manage_user_batch_operation', '/manage/users/batch_operation', UserBatchOperationHandler);

    // UI 注入（控制面板、用户下拉菜单）
    ctx.injectUI('ControlPanel', 'manage_users_list', { domainId: 'system' });
    ctx.injectUI('DomainManage', 'manage_users_import', { family: 'Access Control', icon: 'user' });
    ctx.injectUI('UserDropdown', 'manage_users_list', {
        family: 'Moderate',
        icon: 'user',
        domainId: 'system',
    }, (h) => h.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
        || `,${SystemModel.get('user-list.admin') || ''},`.includes(`,${h.user._id},`));

    // 检测 store 插件并启用相关功能
    ctx.inject(['store'], (c) => {
        setHasStore(true);
        setImportHasStore(true);

        // 域显示名设置 API
        c.Route('domain_displayname_set', '/set_displayname', DisplayNameSetHandler, PERM.PERM_EDIT_DOMAIN);

        // 注册 store 购买事件处理器
        registerStorePurchaseHandler(c);

        // 清理回调
        c.onDispose(() => {
            setHasStore(false);
            setImportHasStore(false);
        });
    });

    // 检测 ysr 插件并启用相关功能
    ctx.inject(['ysr'], (c) => {
        setHasYsr(true);

        // 清理回调
        c.onDispose(() => {
            setHasYsr(false);
        });
    });

    // NOTE: 不再注入域管理侧边栏菜单，仅保留系统级用户列表管理入口。
}
