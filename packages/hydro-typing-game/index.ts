import { Context } from 'hydrooj';
import { PRIV } from 'hydrooj/src/model/builtin';
import * as TypingModel from './model/typing';
import MainHandler from './handler/main';
import PracticeHandler from './handler/practice';
import ContestHandler, { ContestCreateHandler, ContestDetailHandler } from './handler/contest';
import RankingHandler from './handler/ranking';

// 声明数据库集合
declare module 'hydrooj' {
    interface Collections {
        'typing.record': TypingModel.TypingRecord;
        'typing.contest': TypingModel.TypingContest;
        'typing.stats': TypingModel.TypingUserStats;
    }
    interface Model {
        typing: typeof TypingModel;
    }
}

export async function apply(ctx: Context) {
    // 注册模型
    ctx.model.typing = TypingModel;
    
    // 注册路由
    ctx.Route('typing_main', '/typing', MainHandler);
    ctx.Route('typing_practice', '/typing/practice/:mode', PracticeHandler);
    ctx.Route('typing_contest', '/typing/contest', ContestHandler);
    ctx.Route('typing_contest_create', '/typing/contest/create', ContestCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('typing_contest_detail', '/typing/contest/:cid', ContestDetailHandler);
    ctx.Route('typing_ranking', '/typing/ranking', RankingHandler);
    
    // 在用户菜单中添加入口
    ctx.injectUI('UserDropdown', 'typing_main', 
        () => ({ icon: 'keyboard', displayName: 'Typing Game' }),
        PRIV.PRIV_USER_PROFILE
    );
    
    // 在主导航中添加入口（可选）
    ctx.injectUI('Nav', 'typing_main',
        () => ({ displayName: 'Typing', prefix: 'typing' }),
        PRIV.PRIV_USER_PROFILE
    );
    
    // 加载翻译
    ctx.i18n.load('zh', {
        'Typing Game': '打字游戏',
        'Practice': '练习',
        'Contest': '比赛',
        'Ranking': '排行榜',
        'Words Per Minute': '每分钟字数',
        'Accuracy': '准确率',
        'Start Practice': '开始练习',
        'Join Contest': '参加比赛',
        'View Rankings': '查看排行榜',
        'Basic Keys': '基础键位',
        'Letters': '字母练习',
        'Words': '单词练习',
        'Sentences': '句子练习',
        'Code': '代码练习',
        'Time Limit': '时间限制',
        'Character Limit': '字符限制',
        'Your Score': '你的得分',
        'Best Score': '最高分',
        'Total Practice': '总练习次数',
        'Average WPM': '平均速度',
        'Average Accuracy': '平均准确率',
    });
}