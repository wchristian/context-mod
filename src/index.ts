import winston from 'winston';
import 'winston-daily-rotate-file';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import dduration from 'dayjs/plugin/duration.js';
import relTime from 'dayjs/plugin/relativeTime.js';
import {Manager} from "./Subreddit/Manager";
import {Command} from 'commander';
import {checks, getUniversalOptions, limit} from "./Utils/CommandConfig";
import {App} from "./App";
import Submission from "snoowrap/dist/objects/Submission";
import {COMMENT_URL_ID, parseLinkIdentifier, SUBMISSION_URL_ID} from "./util";

dayjs.extend(utc);
dayjs.extend(dduration);
dayjs.extend(relTime);

const commentReg = parseLinkIdentifier([COMMENT_URL_ID]);
const submissionReg = parseLinkIdentifier([SUBMISSION_URL_ID]);

const program = new Command();
for (const o of getUniversalOptions()) {
    program.addOption(o);
}

(async function () {
    try {

        program
            .command('run')
            .description('Runs bot normally')
            .action(async (run, command) => {
                const app = new App(program.opts());
                await app.buildManagers();
                await app.runManagers();
            });

        program
            .command('check <activityIdentifier> [type]')
            .description('Run check(s) on a specific activity', {
                activityIdentifier: 'Either a permalink URL or the ID of the Comment or Submission',
                type: `If activityIdentifier is not a permalink URL then the type of activity ('comment' or 'submission'). May also specify 'submission' type when using a permalink to a comment to get the Submission`,
            })
            .addOption(checks)
            .action(async (activityIdentifier, type, commandOptions = {}) => {
                const {checks = []} = commandOptions;
                const app = new App(program.opts());

                let a;
                const commentId = commentReg(activityIdentifier);
                if (commentId !== undefined) {
                    if (type !== 'submission') {
                        // @ts-ignore
                        a = await app.client.getComment(commentId);
                    } else {
                        // @ts-ignore
                        a = await app.client.getSubmission(submissionReg(activityIdentifier) as string);
                    }
                }
                if (a === undefined) {
                    const submissionId = submissionReg(activityIdentifier);
                    if (submissionId !== undefined) {
                        if (type === 'comment') {
                            throw new Error(`Detected URL was for a submission but type was 'comment', cannot get activity`);
                        } else {
                            // @ts-ignore
                            a = await app.client.getSubmission(submissionId);
                        }
                    }
                }

                if (a === undefined) {
                    // if we get this far then probably not a URL
                    if (type === undefined) {
                        throw new Error(`activityIdentifier was not a valid Reddit URL and type was not specified`);
                    }
                    if (type === 'comment') {
                        // @ts-ignore
                        a = await app.client.getComment(activityIdentifier);
                    } else {
                        // @ts-ignore
                        a = await app.client.getSubmission(activityIdentifier);
                    }
                }

                // @ts-ignore
                const activity = await a.fetch();
                const sub = await activity.subreddit.display_name;
                await app.buildManagers([sub]);
                if (app.subManagers.length > 0) {
                    const manager = app.subManagers.find(x => x.subreddit.display_name === sub) as Manager;
                    await manager.runChecks(type === 'comment' ? 'Comment' : 'Submission', activity, checks);
                }
            });

        program.command('unmoderated <subreddits...>')
            .description('Run checks on all unmoderated activity in the modqueue', {
                subreddits: 'The list of subreddits to run on. If not specified will run on all subreddits the account has moderation access to.'
            })
            .addOption(checks)
            .addOption(limit)
            .action(async (subreddits = [], commandOptions = {}) => {
                const {checks = [], limit = 100} = commandOptions;
                const app = new App(program.opts());

                await app.buildManagers(subreddits);

                for(const manager of app.subManagers) {
                    const activities = await manager.subreddit.getUnmoderated({limit});
                    for(const a of activities.reverse()) {
                        await manager.runChecks(a instanceof Submission ? 'Submission' : 'Comment', a, checks);
                    }
                }
            });


        await program.parseAsync();

    } catch (err) {
        const logger = winston.loggers.get('default');
        if (err.name === 'StatusCodeError' && err.response !== undefined) {
            const authHeader = err.response.headers['www-authenticate'];
            if (authHeader !== undefined && authHeader.includes('insufficient_scope')) {
                logger.error('Reddit responded with a 403 insufficient_scope, did you choose the correct scopes?');
            }
        }
        console.log(err);
    }
}());
