import { STATUS } from '@hydrooj/utils/lib/status';

export function normalize(key: string) {
    return key.toUpperCase().replace(/ /g, '_');
}

export const VERDICT = new Proxy<Record<string, STATUS>>({
    RUNTIME_ERROR: STATUS.STATUS_RUNTIME_ERROR,
    WRONG_ANSWER: STATUS.STATUS_WRONG_ANSWER,
    OK: STATUS.STATUS_ACCEPTED,
    COMPILING: STATUS.STATUS_COMPILING,
    TIME_LIMIT_EXCEEDED: STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    MEMORY_LIMIT_EXCEEDED: STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
    IDLENESS_LIMIT_EXCEEDED: STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    ACCEPTED: STATUS.STATUS_ACCEPTED,
    PRESENTATION_ERROR: STATUS.STATUS_WRONG_ANSWER,
    OUTPUT_LIMIT_EXCEEDED: STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED,
    EXTRA_TEST_PASSED: STATUS.STATUS_ACCEPTED,
    COMPILE_ERROR: STATUS.STATUS_COMPILE_ERROR,
    'RUNNING_&_JUDGING': STATUS.STATUS_JUDGING,
    QUEUING: STATUS.STATUS_WAITING,
    RUNNING: STATUS.STATUS_JUDGING,

    // Codeforces
    'HAPPY_NEW_YEAR!': STATUS.STATUS_ACCEPTED,

    // Vjudge
    QUEUEING: STATUS.STATUS_COMPILING,
    PENDING: STATUS.STATUS_COMPILING,
    SUBMITTED: STATUS.STATUS_COMPILING,
    JUDGING: STATUS.STATUS_JUDGING,
    AC: STATUS.STATUS_ACCEPTED,
    WA: STATUS.STATUS_WRONG_ANSWER,
    RE: STATUS.STATUS_RUNTIME_ERROR,
    CE: STATUS.STATUS_COMPILE_ERROR,
    PE: STATUS.STATUS_WRONG_ANSWER,
    TLE: STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    MLE: STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
    OLE: STATUS.STATUS_WRONG_ANSWER,
    FAILED_OTHER: STATUS.STATUS_SYSTEM_ERROR,
    SUBMIT_FAILED_PERM: STATUS.STATUS_SYSTEM_ERROR,
    SUBMIT_FAILED_TEMP: STATUS.STATUS_SYSTEM_ERROR,

    // YACS
    正在评测: STATUS.STATUS_JUDGING,
    答案正确: STATUS.STATUS_ACCEPTED,
    编译失败: STATUS.STATUS_COMPILE_ERROR,
    部分正确: STATUS.STATUS_WRONG_ANSWER,
    运行超时: STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    内存超出: STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
    暂未公布: STATUS.STATUS_SYSTEM_ERROR,
    评测机故障: STATUS.STATUS_SYSTEM_ERROR,

    // HustOJ
    WAITING: STATUS.STATUS_WAITING,
    等待: STATUS.STATUS_WAITING,
    运行并评判: STATUS.STATUS_JUDGING,
    正在评测中: STATUS.STATUS_JUDGING,
    编译成功: STATUS.STATUS_JUDGING,
    RUNNING_JUDGING: STATUS.STATUS_JUDGING,
    正确: STATUS.STATUS_ACCEPTED,
    格式错误: STATUS.STATUS_WRONG_ANSWER,
    答案错误: STATUS.STATUS_WRONG_ANSWER,
    OUTPUT_LIMIT_EXCEED: STATUS.STATUS_WRONG_ANSWER,
    输出超限: STATUS.STATUS_WRONG_ANSWER,
    运行时错误: STATUS.STATUS_RUNTIME_ERROR,
    DANGEROUS_SYSCALL: STATUS.STATUS_RUNTIME_ERROR,
    TIME_LIMIT_EXCEED: STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    时间超限: STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    MEMORY_LIMIT_EXCEED: STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
    内存超限: STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
    COMPILATION_ERROR: STATUS.STATUS_COMPILE_ERROR,
    编译错误: STATUS.STATUS_COMPILE_ERROR,
    RF: STATUS.STATUS_SYSTEM_ERROR,
    SYSTEM_ERROR: STATUS.STATUS_SYSTEM_ERROR,
    SE: STATUS.STATUS_SYSTEM_ERROR,
    未知错误: STATUS.STATUS_SYSTEM_ERROR,
}, {
    get(self, key) {
        if (typeof key === 'symbol') return null;
        key = normalize(key);
        if (typeof STATUS[key] === 'number') return STATUS[key];
        if (typeof self[key] === 'number') return self[key];
        return null;
    },
});
