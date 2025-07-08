#!/usr/bin/env node
/**
 * 域复制功能集成测试脚本
 * 
 * 用法:
 * node test-domain-copy.js --source=source_domain --target=target_domain [options]
 * 
 * 选项:
 * --source=<domain_id>     源域ID (必需)
 * --target=<domain_id>     目标域ID (必需)
 * --problems               复制题库
 * --contests               复制比赛
 * --trainings              复制训练计划  
 * --users                  复制用户权限
 * --groups                 复制用户分组
 * --discussions            复制讨论
 * --solutions              复制题解
 * --preserve-ids           保持题目ID不变
 * --cleanup                测试后清理数据
 * --dry-run                仅检查不执行
 */

import { MongoClient } from 'mongodb';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import * as db from '../service/db';
import * as domain from '../model/domain';
import * as document from '../model/document';
import { DomainCopyHandler } from '../handler/domain-copy';

interface TestOptions {
    source: string;
    target: string;
    problems?: boolean;
    contests?: boolean;
    trainings?: boolean;
    users?: boolean;
    groups?: boolean;
    discussions?: boolean;
    solutions?: boolean;
    preserveIds?: boolean;
    cleanup?: boolean;
    dryRun?: boolean;
}

class DomainCopyTester {
    private options: TestOptions;
    private testUserId = 999999; // Test user ID
    
    constructor(options: TestOptions) {
        this.options = options;
    }

    async run() {
        console.log('🚀 Starting Domain Copy Integration Test');
        console.log(`Source Domain: ${this.options.source}`);
        console.log(`Target Domain: ${this.options.target}`);
        console.log('');

        try {
            await db.start();
            
            if (this.options.dryRun) {
                await this.performDryRun();
            } else {
                await this.performActualCopy();
            }
            
            if (this.options.cleanup) {
                await this.cleanup();
            }
            
            console.log('✅ Test completed successfully');
        } catch (error) {
            console.error('❌ Test failed:', error.message);
            if (this.options.cleanup) {
                await this.cleanup();
            }
            process.exit(1);
        }
    }

    async performDryRun() {
        console.log('🔍 Performing dry run - checking source domain...');
        
        // Check source domain exists
        const sourceDomain = await domain.get(this.options.source);
        if (!sourceDomain) {
            throw new Error(`Source domain '${this.options.source}' not found`);
        }
        console.log(`✓ Source domain exists: ${sourceDomain.name}`);

        // Check target domain doesn't exist
        const targetDomain = await domain.get(this.options.target);
        if (targetDomain) {
            throw new Error(`Target domain '${this.options.target}' already exists`);
        }
        console.log(`✓ Target domain ID is available`);

        // Analyze source domain content
        const analysis = await this.analyzeSourceDomain(this.options.source);
        console.log('\n📊 Source Domain Analysis:');
        console.log(`  Problems: ${analysis.problems}`);
        console.log(`  Contests: ${analysis.contests}`);
        console.log(`  Trainings: ${analysis.trainings}`);
        console.log(`  Users: ${analysis.users}`);
        console.log(`  Groups: ${analysis.groups}`);
        console.log(`  Discussions: ${analysis.discussions}`);
        console.log(`  Problem Solutions: ${analysis.problemSolutions}`);

        // Estimate copy time and size
        const estimate = this.estimateCopyOperation(analysis);
        console.log('\n⏱️  Copy Operation Estimate:');
        console.log(`  Estimated time: ${estimate.timeMinutes} minutes`);
        console.log(`  Estimated data size: ${estimate.dataSizeMB} MB`);
        console.log(`  Number of operations: ${estimate.operations}`);

        console.log('\n✓ Dry run completed - ready for actual copy');
    }

    async performActualCopy() {
        console.log('🏃‍♂️ Performing actual domain copy...');
        
        const handler = new DomainCopyHandler();
        
        // Mock handler properties
        handler.user = { _id: this.testUserId };
        handler.checkPriv = () => true;
        
        let progressCount = 0;
        handler.sendProgress = (progress) => {
            progressCount++;
            if (progressCount % 10 === 0 || progress.current === progress.total) {
                console.log(`  Progress: ${progress.stage} (${progress.current}/${progress.total})`);
            }
        };

        const startTime = Date.now();
        
        const result = await handler.copyDomain(
            this.options.source,
            this.options.target,
            `Copy of ${this.options.source}`,
            {
                copyProblems: this.options.problems || false,
                copyContests: this.options.contests || false,
                copyTrainings: this.options.trainings || false,
                copyUsers: this.options.users || false,
                copyGroups: this.options.groups || false,
                copyDiscussions: this.options.discussions || false,
                copyProblemSolutions: this.options.solutions || false,
                preserveIds: this.options.preserveIds || false,
                nameMapping: {}
            }
        );

        const duration = (Date.now() - startTime) / 1000;
        
        console.log('\n🎉 Copy completed!');
        console.log(`  Duration: ${duration.toFixed(2)} seconds`);
        console.log(`  Domain created: ${result.domain ? 'Yes' : 'No'}`);
        console.log(`  Problems copied: ${result.problems}`);
        console.log(`  Contests copied: ${result.contests}`);
        console.log(`  Trainings copied: ${result.trainings}`);
        console.log(`  Users copied: ${result.users}`);
        console.log(`  Groups copied: ${result.groups}`);
        console.log(`  Discussions copied: ${result.discussions}`);
        console.log(`  Problem solutions copied: ${result.problemSolutions}`);

        // Verify the copy
        await this.verifyCopy();
    }

    async analyzeSourceDomain(domainId: string) {
        const problems = await document.getMulti(domainId, document.TYPE_PROBLEM).toArray();
        const contests = await document.getMulti(domainId, document.TYPE_CONTEST).toArray();
        const trainings = await document.getMulti(domainId, document.TYPE_TRAINING).toArray();
        const discussions = await document.getMulti(domainId, document.TYPE_DISCUSSION).toArray();
        const problemSolutions = await document.getMulti(domainId, document.TYPE_PROBLEM_SOLUTION).toArray();
        
        const domainUsers = await domain.getMultiUserInDomain(domainId).toArray();
        const groups = await domain.listGroup(domainId);

        return {
            problems: problems.length,
            contests: contests.length,
            trainings: trainings.length,
            users: domainUsers.length,
            groups: groups.length,
            discussions: discussions.length,
            problemSolutions: problemSolutions.length,
            problemsWithFiles: problems.filter(p => p.data && p.data.length > 0).length
        };
    }

    estimateCopyOperation(analysis: any) {
        // Rough estimates based on content size
        let operations = 1; // Create domain
        let timeMinutes = 0.5; // Base time
        let dataSizeMB = 1; // Base size

        if (this.options.problems) {
            operations += analysis.problems;
            timeMinutes += analysis.problems * 0.1; // 0.1 min per problem
            dataSizeMB += analysis.problemsWithFiles * 5; // 5MB per problem with files
        }

        if (this.options.contests) {
            operations += analysis.contests;
            timeMinutes += analysis.contests * 0.05;
        }

        if (this.options.trainings) {
            operations += analysis.trainings;
            timeMinutes += analysis.trainings * 0.05;
        }

        if (this.options.users) {
            operations += analysis.users;
            timeMinutes += analysis.users * 0.01;
        }

        if (this.options.groups) {
            operations += analysis.groups;
            timeMinutes += analysis.groups * 0.02;
        }

        if (this.options.discussions) {
            operations += analysis.discussions;
            timeMinutes += analysis.discussions * 0.02;
        }

        if (this.options.solutions) {
            operations += analysis.problemSolutions;
            timeMinutes += analysis.problemSolutions * 0.02;
        }

        return {
            operations,
            timeMinutes: Math.ceil(timeMinutes * 10) / 10,
            dataSizeMB: Math.ceil(dataSizeMB)
        };
    }

    async verifyCopy() {
        console.log('\n🔍 Verifying copy integrity...');
        
        const targetDomain = await domain.get(this.options.target);
        if (!targetDomain) {
            throw new Error('Target domain was not created');
        }
        console.log('✓ Target domain exists');

        if (this.options.problems) {
            const sourceProblems = await document.getMulti(this.options.source, document.TYPE_PROBLEM).toArray();
            const targetProblems = await document.getMulti(this.options.target, document.TYPE_PROBLEM).toArray();
            
            if (sourceProblems.length !== targetProblems.length) {
                console.warn(`⚠️  Problem count mismatch: source=${sourceProblems.length}, target=${targetProblems.length}`);
            } else {
                console.log(`✓ All ${targetProblems.length} problems copied`);
            }
        }

        if (this.options.contests) {
            const sourceContests = await document.getMulti(this.options.source, document.TYPE_CONTEST).toArray();
            const targetContests = await document.getMulti(this.options.target, document.TYPE_CONTEST).toArray();
            
            if (sourceContests.length !== targetContests.length) {
                console.warn(`⚠️  Contest count mismatch: source=${sourceContests.length}, target=${targetContests.length}`);
            } else {
                console.log(`✓ All ${targetContests.length} contests copied`);
            }
        }

        if (this.options.trainings) {
            const sourceTrainings = await document.getMulti(this.options.source, document.TYPE_TRAINING).toArray();
            const targetTrainings = await document.getMulti(this.options.target, document.TYPE_TRAINING).toArray();
            
            if (sourceTrainings.length !== targetTrainings.length) {
                console.warn(`⚠️  Training count mismatch: source=${sourceTrainings.length}, target=${targetTrainings.length}`);
            } else {
                console.log(`✓ All ${targetTrainings.length} trainings copied`);
            }
        }

        if (this.options.users) {
            const sourceUsers = await domain.getMultiUserInDomain(this.options.source).toArray();
            const targetUsers = await domain.getMultiUserInDomain(this.options.target).toArray();
            
            if (sourceUsers.length !== targetUsers.length) {
                console.warn(`⚠️  User count mismatch: source=${sourceUsers.length}, target=${targetUsers.length}`);
            } else {
                console.log(`✓ All ${targetUsers.length} users copied`);
            }
        }

        if (this.options.groups) {
            const sourceGroups = await domain.listGroup(this.options.source);
            const targetGroups = await domain.listGroup(this.options.target);
            
            if (sourceGroups.length !== targetGroups.length) {
                console.warn(`⚠️  Group count mismatch: source=${sourceGroups.length}, target=${targetGroups.length}`);
            } else {
                console.log(`✓ All ${targetGroups.length} groups copied`);
            }
        }

        console.log('✓ Copy verification completed');
    }

    async cleanup() {
        console.log('\n🧹 Cleaning up test data...');
        
        try {
            await domain.del(this.options.target);
            await document.coll.deleteMany({ domainId: this.options.target });
            await db.collection('domain.user').deleteMany({ domainId: this.options.target });
            console.log('✓ Cleanup completed');
        } catch (error) {
            console.warn('⚠️  Cleanup failed:', error.message);
        }
    }
}

// CLI Interface
async function main() {
    const argv = await yargs(hideBin(process.argv))
        .option('source', {
            alias: 's',
            type: 'string',
            demandOption: true,
            description: 'Source domain ID'
        })
        .option('target', {
            alias: 't',
            type: 'string',
            demandOption: true,
            description: 'Target domain ID'
        })
        .option('problems', {
            type: 'boolean',
            default: false,
            description: 'Copy problems and test data'
        })
        .option('contests', {
            type: 'boolean',
            default: false,
            description: 'Copy contests and homework'
        })
        .option('trainings', {
            type: 'boolean',
            default: false,
            description: 'Copy training plans'
        })
        .option('users', {
            type: 'boolean',
            default: false,
            description: 'Copy user permissions'
        })
        .option('groups', {
            type: 'boolean',
            default: false,
            description: 'Copy user groups'
        })
        .option('discussions', {
            type: 'boolean',
            default: false,
            description: 'Copy discussions'
        })
        .option('solutions', {
            type: 'boolean',
            default: false,
            description: 'Copy problem solutions'
        })
        .option('preserve-ids', {
            type: 'boolean',
            default: false,
            description: 'Preserve original problem IDs'
        })
        .option('cleanup', {
            type: 'boolean',
            default: false,
            description: 'Clean up test data after completion'
        })
        .option('dry-run', {
            type: 'boolean',
            default: false,
            description: 'Perform dry run without actual copy'
        })
        .help()
        .argv;

    const tester = new DomainCopyTester(argv);
    await tester.run();
}

if (require.main === module) {
    main().catch(console.error);
}

// Plugin export for Hydro
export default {
    apply() {
        // This is just a CLI tool, not a plugin
        // Empty apply method to satisfy plugin system
    }
};

export { DomainCopyTester };