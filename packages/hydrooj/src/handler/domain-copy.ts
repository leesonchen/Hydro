/* eslint-disable no-await-in-loop */
import { ObjectId } from 'mongodb';
import { BadRequestError, ForbiddenError, ValidationError } from '../error';
import { ProblemDoc, Tdoc, TrainingDoc } from '../interface';
import { PERM, PRIV } from '../model/builtin';
import * as contest from '../model/contest';
import * as discussion from '../model/discussion';
import * as document from '../model/document';
import * as domain from '../model/domain';
import * as problem from '../model/problem';
import * as storage from '../model/storage';
import * as training from '../model/training';
import * as user from '../model/user';
import { Handler, param, Types } from '../service/server';

interface CopyProgress {
    current: number;
    total: number;
    stage: string;
    detail?: string;
}

interface CopyOptions {
    copyProblems: boolean;
    copyContests: boolean;
    copyTrainings: boolean;
    copyUsers: boolean;
    copyGroups: boolean;
    copyDiscussions: boolean;
    copyProblemSolutions: boolean;
    preserveIds: boolean;
    nameMapping: Record<string, string>;
}

class DomainCopyHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        this.response.template = 'domain_copy.html';
        this.response.body = {
            domains: await domain.getMulti().toArray(),
        };
    }

    async post({
        sourceDomainId,
        targetDomainId,
        targetDomainName,
        copyProblems = true,
        copyContests = true,
        copyTrainings = true,
        copyUsers = false,
        copyGroups = false,
        copyDiscussions = false,
        copyProblemSolutions = false,
        preserveIds = false,
        nameMapping = {},
    }: {
        sourceDomainId: string,
        targetDomainId: string,
        targetDomainName: string,
    } & Partial<CopyOptions>) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);

        // Validate inputs
        if (!sourceDomainId || !targetDomainId) {
            throw new BadRequestError('Source and target domain IDs are required');
        }
        if (sourceDomainId === targetDomainId) {
            throw new BadRequestError('Source and target domains cannot be the same');
        }

        const sourceDomain = await domain.get(sourceDomainId);
        if (!sourceDomain) {
            throw new BadRequestError('Source domain not found');
        }

        const existingTargetDomain = await domain.get(targetDomainId);
        if (existingTargetDomain) {
            throw new BadRequestError('Target domain already exists');
        }

        const options: CopyOptions = {
            copyProblems,
            copyContests,
            copyTrainings,
            copyUsers,
            copyGroups,
            copyDiscussions,
            copyProblemSolutions,
            preserveIds,
            nameMapping,
        };

        try {
            const result = await this.copyDomain(sourceDomainId, targetDomainId, targetDomainName, options);
            this.response.body = {
                success: true,
                message: 'Domain copied successfully',
                summary: result,
            };
        } catch (error) {
            this.response.body = {
                success: false,
                error: error.message,
            };
        }
    }

    private async copyDomain(
        sourceDomainId: string,
        targetDomainId: string,
        targetDomainName: string,
        options: CopyOptions,
    ) {
        const progress: CopyProgress = { current: 0, total: 0, stage: 'Initializing' };
        
        // Calculate total steps
        let totalSteps = 1; // Create domain
        if (options.copyProblems) totalSteps += 1;
        if (options.copyContests) totalSteps += 1;
        if (options.copyTrainings) totalSteps += 1;
        if (options.copyUsers) totalSteps += 1;
        if (options.copyGroups) totalSteps += 1;
        if (options.copyDiscussions) totalSteps += 1;
        if (options.copyProblemSolutions) totalSteps += 1;
        
        progress.total = totalSteps;

        const summary = {
            domain: false,
            problems: 0,
            contests: 0,
            trainings: 0,
            users: 0,
            groups: 0,
            discussions: 0,
            problemSolutions: 0,
        };

        try {
            // Step 1: Create target domain
            progress.stage = 'Creating target domain';
            this.sendProgress(progress);
            
            const sourceDomain = await domain.get(sourceDomainId);
            await domain.add(targetDomainId, this.user._id, {
                name: targetDomainName || sourceDomain.name,
                bulletin: sourceDomain.bulletin || '',
                roles: sourceDomain.roles || {},
                avatar: sourceDomain.avatar || '',
            });
            summary.domain = true;
            progress.current++;

            // Step 2: Copy problems
            if (options.copyProblems) {
                progress.stage = 'Copying problems';
                this.sendProgress(progress);
                
                const problemCount = await this.copyProblems(sourceDomainId, targetDomainId, options);
                summary.problems = problemCount;
                progress.current++;
            }

            // Step 3: Copy contests
            if (options.copyContests) {
                progress.stage = 'Copying contests';
                this.sendProgress(progress);
                
                const contestCount = await this.copyContests(sourceDomainId, targetDomainId, options);
                summary.contests = contestCount;
                progress.current++;
            }

            // Step 4: Copy trainings
            if (options.copyTrainings) {
                progress.stage = 'Copying trainings';
                this.sendProgress(progress);
                
                const trainingCount = await this.copyTrainings(sourceDomainId, targetDomainId, options);
                summary.trainings = trainingCount;
                progress.current++;
            }

            // Step 5: Copy users
            if (options.copyUsers) {
                progress.stage = 'Copying user permissions';
                this.sendProgress(progress);
                
                const userCount = await this.copyUsers(sourceDomainId, targetDomainId, options);
                summary.users = userCount;
                progress.current++;
            }

            // Step 6: Copy groups
            if (options.copyGroups) {
                progress.stage = 'Copying user groups';
                this.sendProgress(progress);
                
                const groupCount = await this.copyGroups(sourceDomainId, targetDomainId, options);
                summary.groups = groupCount;
                progress.current++;
            }

            // Step 7: Copy discussions
            if (options.copyDiscussions) {
                progress.stage = 'Copying discussions';
                this.sendProgress(progress);
                
                const discussionCount = await this.copyDiscussions(sourceDomainId, targetDomainId, options);
                summary.discussions = discussionCount;
                progress.current++;
            }

            // Step 8: Copy problem solutions
            if (options.copyProblemSolutions) {
                progress.stage = 'Copying problem solutions';
                this.sendProgress(progress);
                
                const solutionCount = await this.copyProblemSolutions(sourceDomainId, targetDomainId, options);
                summary.problemSolutions = solutionCount;
                progress.current++;
            }

            progress.stage = 'Completed';
            this.sendProgress(progress);

            return summary;
        } catch (error) {
            throw error;
        }
    }

    private async copyProblems(sourceDomainId: string, targetDomainId: string, options: CopyOptions): Promise<number> {
        const problems = await document.getMulti(sourceDomainId, document.TYPE_PROBLEM).toArray() as ProblemDoc[];
        let copiedCount = 0;

        for (const prob of problems) {
            try {
                // Copy problem basic info
                const newPid = options.preserveIds ? prob.pid : undefined;
                const newProblem = {
                    ...prob,
                    domainId: targetDomainId,
                    pid: newPid,
                    docId: undefined, // Let system assign new docId
                    _id: undefined,
                    nSubmit: 0,
                    nAccept: 0,
                    stats: {},
                };

                delete newProblem._id;
                delete newProblem.docId;

                const problemId = await document.add(
                    targetDomainId,
                    newProblem.content,
                    newProblem.owner,
                    document.TYPE_PROBLEM,
                    null,
                    null,
                    null,
                    newProblem,
                );

                // Copy problem files (testdata, additional files)
                if (prob.data && prob.data.length > 0) {
                    const newDataFiles = [];
                    for (const file of prob.data) {
                        try {
                            const sourceFile = await storage.get(file._id);
                            if (sourceFile) {
                                const newFileId = await storage.put(sourceFile, `${targetDomainId}/problem/${problemId}/testdata/${file.name}`);
                                newDataFiles.push({
                                    _id: newFileId,
                                    name: file.name,
                                    size: file.size,
                                });
                            }
                        } catch (fileError) {
                            // Log error but continue with other files
                            console.warn(`Failed to copy data file ${file.name}:`, fileError);
                        }
                    }
                    if (newDataFiles.length > 0) {
                        await document.set(targetDomainId, document.TYPE_PROBLEM, problemId, { data: newDataFiles });
                    }
                }

                if (prob.additional_file && prob.additional_file.length > 0) {
                    const newAdditionalFiles = [];
                    for (const file of prob.additional_file) {
                        try {
                            const sourceFile = await storage.get(file._id);
                            if (sourceFile) {
                                const newFileId = await storage.put(sourceFile, `${targetDomainId}/problem/${problemId}/additional/${file.name}`);
                                newAdditionalFiles.push({
                                    _id: newFileId,
                                    name: file.name,
                                    size: file.size,
                                });
                            }
                        } catch (fileError) {
                            console.warn(`Failed to copy additional file ${file.name}:`, fileError);
                        }
                    }
                    if (newAdditionalFiles.length > 0) {
                        await document.set(targetDomainId, document.TYPE_PROBLEM, problemId, { additional_file: newAdditionalFiles });
                    }
                }

                copiedCount++;
            } catch (problemError) {
                console.warn(`Failed to copy problem ${prob.pid}:`, problemError);
            }
        }

        return copiedCount;
    }

    private async copyContests(sourceDomainId: string, targetDomainId: string, options: CopyOptions): Promise<number> {
        const contests = await document.getMulti(sourceDomainId, document.TYPE_CONTEST).toArray() as Tdoc[];
        let copiedCount = 0;

        for (const contestDoc of contests) {
            try {
                const newContest = {
                    ...contestDoc,
                    domainId: targetDomainId,
                    docId: undefined,
                    _id: undefined,
                    attend: [], // Reset attendance
                };

                delete newContest._id;
                delete newContest.docId;

                // Map problem IDs if needed
                if (newContest.pids && options.nameMapping) {
                    newContest.pids = newContest.pids.map((pid: string) => options.nameMapping[pid] || pid);
                }

                await document.add(
                    targetDomainId,
                    newContest.content,
                    newContest.owner,
                    document.TYPE_CONTEST,
                    null,
                    null,
                    null,
                    newContest,
                );

                copiedCount++;
            } catch (contestError) {
                console.warn(`Failed to copy contest ${contestDoc.title}:`, contestError);
            }
        }

        return copiedCount;
    }

    private async copyTrainings(sourceDomainId: string, targetDomainId: string, options: CopyOptions): Promise<number> {
        const trainings = await document.getMulti(sourceDomainId, document.TYPE_TRAINING).toArray() as TrainingDoc[];
        let copiedCount = 0;

        for (const trainingDoc of trainings) {
            try {
                const newTraining = {
                    ...trainingDoc,
                    domainId: targetDomainId,
                    docId: undefined,
                    _id: undefined,
                    attend: 0, // Reset attendance count
                };

                delete newTraining._id;
                delete newTraining.docId;

                // Map problem IDs in DAG if needed
                if (newTraining.dag && options.nameMapping) {
                    newTraining.dag = newTraining.dag.map((node: any) => ({
                        ...node,
                        pids: node.pids?.map((pid: string) => options.nameMapping[pid] || pid),
                    }));
                }

                await document.add(
                    targetDomainId,
                    newTraining.content,
                    newTraining.owner,
                    document.TYPE_TRAINING,
                    null,
                    null,
                    null,
                    newTraining,
                );

                copiedCount++;
            } catch (trainingError) {
                console.warn(`Failed to copy training ${trainingDoc.title}:`, trainingError);
            }
        }

        return copiedCount;
    }

    private async copyUsers(sourceDomainId: string, targetDomainId: string, options: CopyOptions): Promise<number> {
        const domainUsers = await domain.getMultiUserInDomain(sourceDomainId).toArray();
        let copiedCount = 0;

        for (const domainUser of domainUsers) {
            try {
                await domain.setUserInDomain(targetDomainId, domainUser.uid, {
                    role: domainUser.role,
                    join: domainUser.join,
                    perm: domainUser.perm,
                });
                copiedCount++;
            } catch (userError) {
                console.warn(`Failed to copy user ${domainUser.uid}:`, userError);
            }
        }

        return copiedCount;
    }

    private async copyGroups(sourceDomainId: string, targetDomainId: string, options: CopyOptions): Promise<number> {
        const groups = await domain.listGroup(sourceDomainId);
        let copiedCount = 0;

        for (const group of groups) {
            try {
                await domain.addGroup(targetDomainId, group.name, group.uids);
                copiedCount++;
            } catch (groupError) {
                console.warn(`Failed to copy group ${group.name}:`, groupError);
            }
        }

        return copiedCount;
    }

    private async copyDiscussions(sourceDomainId: string, targetDomainId: string, options: CopyOptions): Promise<number> {
        const discussions = await document.getMulti(sourceDomainId, document.TYPE_DISCUSSION).toArray();
        let copiedCount = 0;

        for (const discussionDoc of discussions) {
            try {
                const newDiscussion = {
                    ...discussionDoc,
                    domainId: targetDomainId,
                    docId: undefined,
                    _id: undefined,
                };

                delete newDiscussion._id;
                delete newDiscussion.docId;

                await document.add(
                    targetDomainId,
                    newDiscussion.content,
                    newDiscussion.owner,
                    document.TYPE_DISCUSSION,
                    newDiscussion.parentType,
                    newDiscussion.parentId,
                    newDiscussion,
                );

                copiedCount++;
            } catch (discussionError) {
                console.warn(`Failed to copy discussion ${discussionDoc.title}:`, discussionError);
            }
        }

        return copiedCount;
    }

    private async copyProblemSolutions(sourceDomainId: string, targetDomainId: string, options: CopyOptions): Promise<number> {
        const solutions = await document.getMulti(sourceDomainId, document.TYPE_PROBLEM_SOLUTION).toArray();
        let copiedCount = 0;

        for (const solutionDoc of solutions) {
            try {
                const newSolution = {
                    ...solutionDoc,
                    domainId: targetDomainId,
                    docId: undefined,
                    _id: undefined,
                };

                delete newSolution._id;
                delete newSolution.docId;

                // Map parent problem ID if needed
                if (newSolution.parentId && options.nameMapping) {
                    newSolution.parentId = options.nameMapping[newSolution.parentId] || newSolution.parentId;
                }

                await document.add(
                    targetDomainId,
                    newSolution.content,
                    newSolution.owner,
                    document.TYPE_PROBLEM_SOLUTION,
                    newSolution.parentType,
                    newSolution.parentId,
                    newSolution,
                );

                copiedCount++;
            } catch (solutionError) {
                console.warn(`Failed to copy solution:`, solutionError);
            }
        }

        return copiedCount;
    }

    private sendProgress(progress: CopyProgress) {
        if (this.ctx.session.sockId) {
            this.ctx.send('progress', progress);
        }
    }
}

export class DomainCopyValidationHandler extends Handler {
    async get({ domainId }: { domainId: string }) {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        
        if (!domainId) {
            throw new BadRequestError('Domain ID is required');
        }

        const targetDomain = await domain.get(domainId);
        
        this.response.body = {
            exists: !!targetDomain,
            available: !targetDomain,
        };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('domain_copy', '/domain/copy', DomainCopyHandler);
    ctx.Route('domain_copy_validate', '/domain/copy/validate', DomainCopyValidationHandler);
}