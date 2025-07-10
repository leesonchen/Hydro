/* eslint-disable no-unused-expressions */
import { ObjectId } from 'mongodb';
import { expect } from 'chai';
import { Context } from '../context';
import * as db from '../service/db';
import * as domain from '../model/domain';
import * as document from '../model/document';
import * as problem from '../model/problem';
import * as contest from '../model/contest';
import * as training from '../model/training';
import * as storage from '../model/storage';
import { DomainCopyHandler } from '../handler/domain-copy';

describe('Domain Copy Functionality', () => {
    let ctx: Context;
    let sourceDomainId: string;
    let targetDomainId: string;
    let testUserId: number;
    let problemIds: number[] = [];
    let contestIds: number[] = [];
    let trainingIds: number[] = [];

    before(async function() {
        this.timeout(30000);
        
        // Initialize test context
        ctx = new Context();
        await db.start();
        
        // Create test user
        testUserId = 10001;
        
        // Create source domain
        sourceDomainId = 'test-source-domain';
        targetDomainId = 'test-target-domain';
        
        // Clean up any existing test domains
        await cleanupTestDomains();
        
        // Create source domain with test data
        await setupSourceDomain();
    });

    after(async function() {
        this.timeout(30000);
        await cleanupTestDomains();
    });

    async function cleanupTestDomains() {
        try {
            // Remove test domains and their data
            await domain.del(sourceDomainId);
            await domain.del(targetDomainId);
            
            // Clean up documents
            await document.coll.deleteMany({ 
                domainId: { $in: [sourceDomainId, targetDomainId] } 
            });
            
            // Clean up domain users
            await db.collection('domain.user').deleteMany({ 
                domainId: { $in: [sourceDomainId, targetDomainId] } 
            });
        } catch (e) {
            // Ignore cleanup errors
        }
    }

    async function setupSourceDomain() {
        // Create source domain
        await domain.add(sourceDomainId, testUserId, {
            name: 'Test Source Domain',
            bulletin: 'This is a test domain for copying',
            roles: {
                'default': 'Student',
                'admin': 'Administrator'
            }
        });

        // Create test problems
        const problem1Id = await document.add(
            sourceDomainId,
            'Problem 1 content',
            testUserId,
            document.TYPE_PROBLEM,
            null,
            null,
            null,
            {
                pid: 'P1001',
                title: 'Test Problem 1',
                tag: ['math', 'easy'],
                difficulty: 1,
                config: 'type: default',
                hidden: false
            }
        );
        problemIds.push(problem1Id as number);

        const problem2Id = await document.add(
            sourceDomainId,
            'Problem 2 content',
            testUserId,
            document.TYPE_PROBLEM,
            null,
            null,
            null,
            {
                pid: 'P1002',
                title: 'Test Problem 2',
                tag: ['algorithm', 'medium'],
                difficulty: 3,
                config: 'type: default',
                hidden: false
            }
        );
        problemIds.push(problem2Id as number);

        // Create test contest
        const contestId = await document.add(
            sourceDomainId,
            'Test contest content',
            testUserId,
            document.TYPE_CONTEST,
            null,
            null,
            null,
            {
                title: 'Test Contest',
                beginAt: new Date('2024-01-01'),
                endAt: new Date('2024-01-02'),
                pids: ['P1001', 'P1002'],
                rule: 'acm',
                attend: []
            }
        );
        contestIds.push(contestId as number);

        // Create test training
        const trainingId = await document.add(
            sourceDomainId,
            'Test training content',
            testUserId,
            document.TYPE_TRAINING,
            null,
            null,
            null,
            {
                title: 'Test Training',
                description: 'A test training plan',
                dag: [
                    {
                        _id: new ObjectId(),
                        title: 'Basic Problems',
                        pids: ['P1001'],
                        requireNids: []
                    },
                    {
                        _id: new ObjectId(),
                        title: 'Advanced Problems',
                        pids: ['P1002'],
                        requireNids: []
                    }
                ]
            }
        );
        trainingIds.push(trainingId as number);

        // Add domain users
        await domain.setUserInDomain(sourceDomainId, testUserId, {
            role: 'admin',
            join: true
        });

        // Add test groups
        await domain.addGroup(sourceDomainId, 'Test Group 1', [testUserId]);
    }

    describe('Domain Creation and Basic Copy', () => {
        it('should successfully copy domain basic information', async function() {
            this.timeout(10000);
            
            const handler = new DomainCopyHandler();
            // Mock handler context
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            const result = await handler.copyDomain(sourceDomainId, targetDomainId, 'Test Target Domain', {
                copyProblems: false,
                copyContests: false,
                copyTrainings: false,
                copyUsers: false,
                copyGroups: false,
                copyDiscussions: false,
                copyProblemSolutions: false,
                preserveIds: false,
                nameMapping: {}
            });

            expect(result.domain).to.be.true;
            
            // Verify target domain exists
            const targetDomain = await domain.get(targetDomainId);
            expect(targetDomain).to.exist;
            expect(targetDomain.name).to.equal('Test Target Domain');
            expect(targetDomain.owner).to.equal(testUserId);
        });
    });

    describe('Problem Copy', () => {
        it('should copy problems with all metadata', async function() {
            this.timeout(15000);
            
            const handler = new DomainCopyHandler();
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            const problemCount = await handler.copyProblems(sourceDomainId, targetDomainId, {
                copyProblems: true,
                copyContests: false,
                copyTrainings: false,
                copyUsers: false,
                copyGroups: false,
                copyDiscussions: false,
                copyProblemSolutions: false,
                preserveIds: true,
                nameMapping: {}
            });

            expect(problemCount).to.equal(2);
            
            // Verify problems were copied
            const targetProblems = await document.getMulti(targetDomainId, document.TYPE_PROBLEM).toArray();
            expect(targetProblems).to.have.length(2);
            
            const problem1 = targetProblems.find(p => p.pid === 'P1001');
            const problem2 = targetProblems.find(p => p.pid === 'P1002');
            
            expect(problem1).to.exist;
            expect(problem1.title).to.equal('Test Problem 1');
            expect(problem1.tag).to.deep.equal(['math', 'easy']);
            expect(problem1.difficulty).to.equal(1);
            
            expect(problem2).to.exist;
            expect(problem2.title).to.equal('Test Problem 2');
            expect(problem2.tag).to.deep.equal(['algorithm', 'medium']);
            expect(problem2.difficulty).to.equal(3);
        });

        it('should handle problem ID mapping', async function() {
            this.timeout(10000);
            
            // Clean target domain first
            await domain.del(targetDomainId);
            await document.coll.deleteMany({ domainId: targetDomainId });
            
            // Recreate target domain
            await domain.add(targetDomainId, testUserId, {
                name: 'Test Target Domain',
            });
            
            const handler = new DomainCopyHandler();
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            const nameMapping = {
                'P1001': 'P2001',
                'P1002': 'P2002'
            };
            
            const problemCount = await handler.copyProblems(sourceDomainId, targetDomainId, {
                copyProblems: true,
                copyContests: false,
                copyTrainings: false,
                copyUsers: false,
                copyGroups: false,
                copyDiscussions: false,
                copyProblemSolutions: false,
                preserveIds: false,
                nameMapping
            });

            expect(problemCount).to.equal(2);
            
            // Verify problems have new IDs
            const targetProblems = await document.getMulti(targetDomainId, document.TYPE_PROBLEM).toArray();
            expect(targetProblems).to.have.length(2);
            
            const mappedProblems = targetProblems.map(p => p.pid);
            expect(mappedProblems).to.include.members(['P2001', 'P2002']);
        });
    });

    describe('Contest Copy', () => {
        it('should copy contests with problem mappings', async function() {
            this.timeout(10000);
            
            const handler = new DomainCopyHandler();
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            const nameMapping = {
                'P1001': 'P2001',
                'P1002': 'P2002'
            };
            
            const contestCount = await handler.copyContests(sourceDomainId, targetDomainId, {
                copyProblems: false,
                copyContests: true,
                copyTrainings: false,
                copyUsers: false,
                copyGroups: false,
                copyDiscussions: false,
                copyProblemSolutions: false,
                preserveIds: false,
                nameMapping
            });

            expect(contestCount).to.equal(1);
            
            // Verify contest was copied
            const targetContests = await document.getMulti(targetDomainId, document.TYPE_CONTEST).toArray();
            expect(targetContests).to.have.length(1);
            
            const contest = targetContests[0];
            expect(contest.title).to.equal('Test Contest');
            expect(contest.pids).to.deep.equal(['P2001', 'P2002']);
            expect(contest.rule).to.equal('acm');
            expect(contest.attend).to.be.empty;
        });
    });

    describe('Training Copy', () => {
        it('should copy training plans with DAG structure', async function() {
            this.timeout(10000);
            
            const handler = new DomainCopyHandler();
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            const nameMapping = {
                'P1001': 'P2001',
                'P1002': 'P2002'
            };
            
            const trainingCount = await handler.copyTrainings(sourceDomainId, targetDomainId, {
                copyProblems: false,
                copyContests: false,
                copyTrainings: true,
                copyUsers: false,
                copyGroups: false,
                copyDiscussions: false,
                copyProblemSolutions: false,
                preserveIds: false,
                nameMapping
            });

            expect(trainingCount).to.equal(1);
            
            // Verify training was copied
            const targetTrainings = await document.getMulti(targetDomainId, document.TYPE_TRAINING).toArray();
            expect(targetTrainings).to.have.length(1);
            
            const training = targetTrainings[0];
            expect(training.title).to.equal('Test Training');
            expect(training.dag).to.have.length(2);
            
            const basicNode = training.dag.find(node => node.title === 'Basic Problems');
            const advancedNode = training.dag.find(node => node.title === 'Advanced Problems');
            
            expect(basicNode.pids).to.deep.equal(['P2001']);
            expect(advancedNode.pids).to.deep.equal(['P2002']);
        });
    });

    describe('User and Group Copy', () => {
        it('should copy user permissions', async function() {
            this.timeout(10000);
            
            const handler = new DomainCopyHandler();
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            const userCount = await handler.copyUsers(sourceDomainId, targetDomainId, {
                copyProblems: false,
                copyContests: false,
                copyTrainings: false,
                copyUsers: true,
                copyGroups: false,
                copyDiscussions: false,
                copyProblemSolutions: false,
                preserveIds: false,
                nameMapping: {}
            });

            expect(userCount).to.equal(1);
            
            // Verify user was copied
            const targetDomainUser = await domain.getDomainUser(targetDomainId, testUserId);
            expect(targetDomainUser).to.exist;
            expect(targetDomainUser.role).to.equal('admin');
            expect(targetDomainUser.join).to.be.true;
        });

        it('should copy user groups', async function() {
            this.timeout(10000);
            
            const handler = new DomainCopyHandler();
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            const groupCount = await handler.copyGroups(sourceDomainId, targetDomainId, {
                copyProblems: false,
                copyContests: false,
                copyTrainings: false,
                copyUsers: false,
                copyGroups: true,
                copyDiscussions: false,
                copyProblemSolutions: false,
                preserveIds: false,
                nameMapping: {}
            });

            expect(groupCount).to.equal(1);
            
            // Verify group was copied
            const targetGroups = await domain.listGroup(targetDomainId);
            expect(targetGroups).to.have.length(1);
            expect(targetGroups[0].name).to.equal('Test Group 1');
            expect(targetGroups[0].uids).to.include(testUserId);
        });
    });

    describe('Full Domain Copy Integration', () => {
        it('should perform complete domain copy with all options', async function() {
            this.timeout(30000);
            
            // Clean target domain first
            await domain.del(targetDomainId);
            await document.coll.deleteMany({ domainId: targetDomainId });
            await db.collection('domain.user').deleteMany({ domainId: targetDomainId });
            
            const handler = new DomainCopyHandler();
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            const result = await handler.copyDomain(sourceDomainId, targetDomainId, 'Complete Test Domain', {
                copyProblems: true,
                copyContests: true,
                copyTrainings: true,
                copyUsers: true,
                copyGroups: true,
                copyDiscussions: false,
                copyProblemSolutions: false,
                preserveIds: true,
                nameMapping: {}
            });

            // Verify all components were copied
            expect(result.domain).to.be.true;
            expect(result.problems).to.equal(2);
            expect(result.contests).to.equal(1);
            expect(result.trainings).to.equal(1);
            expect(result.users).to.equal(1);
            expect(result.groups).to.equal(1);
            
            // Verify target domain structure
            const targetDomain = await domain.get(targetDomainId);
            expect(targetDomain.name).to.equal('Complete Test Domain');
            
            const targetProblems = await document.getMulti(targetDomainId, document.TYPE_PROBLEM).toArray();
            expect(targetProblems).to.have.length(2);
            
            const targetContests = await document.getMulti(targetDomainId, document.TYPE_CONTEST).toArray();
            expect(targetContests).to.have.length(1);
            
            const targetTrainings = await document.getMulti(targetDomainId, document.TYPE_TRAINING).toArray();
            expect(targetTrainings).to.have.length(1);
            
            const targetGroups = await domain.listGroup(targetDomainId);
            expect(targetGroups).to.have.length(1);
        });
    });

    describe('Error Handling', () => {
        it('should handle missing source domain', async function() {
            const handler = new DomainCopyHandler();
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            try {
                await handler.copyDomain('non-existent-domain', 'test-target-2', 'Test', {
                    copyProblems: false,
                    copyContests: false,
                    copyTrainings: false,
                    copyUsers: false,
                    copyGroups: false,
                    copyDiscussions: false,
                    copyProblemSolutions: false,
                    preserveIds: false,
                    nameMapping: {}
                });
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error).to.exist;
            }
        });

        it('should handle existing target domain', async function() {
            const handler = new DomainCopyHandler();
            handler.user = { _id: testUserId };
            handler.checkPriv = () => true;
            handler.sendProgress = () => {};
            
            try {
                await handler.copyDomain(sourceDomainId, targetDomainId, 'Test', {
                    copyProblems: false,
                    copyContests: false,
                    copyTrainings: false,
                    copyUsers: false,
                    copyGroups: false,
                    copyDiscussions: false,
                    copyProblemSolutions: false,
                    preserveIds: false,
                    nameMapping: {}
                });
                expect.fail('Should have thrown an error');
            } catch (error) {
                expect(error).to.exist;
            }
        });
    });
});

describe('Domain Copy Handler API', () => {
    let ctx: Context;
    
    before(async function() {
        ctx = new Context();
        await db.start();
    });

    describe('Validation Endpoint', () => {
        it('should validate domain availability', async function() {
            // This would test the validation endpoint
            // Implementation depends on your test framework setup
        });
    });
});