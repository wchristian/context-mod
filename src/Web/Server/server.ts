import {addAsync, Router} from '@awaitjs/express';
import express, {Request, Response} from 'express';
import bodyParser from 'body-parser';
import {App} from "../../App";
import dayjs from 'dayjs';
import {Writable, Transform} from "stream";
import winston from 'winston';
import {Server as SocketServer} from 'socket.io';
import Submission from "snoowrap/dist/objects/Submission";
import EventEmitter from "events";
import {Strategy as JwtStrategy, ExtractJwt} from 'passport-jwt';
import passport from 'passport';
import tcpUsed from 'tcp-port-used';

import {
    boolToString, cacheStats,
    COMMENT_URL_ID, createCacheManager,
    filterLogBySubreddit,
    formatLogLineToHtml, formatNumber,
    isLogLineMinLevel,
    LogEntry, parseFromJsonOrYamlToObject,
    parseLinkIdentifier,
    parseSubredditLogName, parseSubredditName,
    pollingInfo, SUBMISSION_URL_ID
} from "../../util";
import {Manager} from "../../Subreddit/Manager";
import {getLogger} from "../../Utils/loggerFactory";
import LoggedError from "../../Utils/LoggedError";
import {OperatorConfig, ResourceStats, RUNNING, STOPPED, SYSTEM, USER} from "../../Common/interfaces";
import http from "http";
import SimpleError from "../../Utils/SimpleError";
import {booleanMiddle} from "../Common/middleware";
import is from "@sindresorhus/is";
import pEvent from "p-event";

const app = addAsync(express());
const router = Router();

app.use(router);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: false}));

const commentReg = parseLinkIdentifier([COMMENT_URL_ID]);
const submissionReg = parseLinkIdentifier([SUBMISSION_URL_ID]);

const availableLevels = ['error', 'warn', 'info', 'verbose', 'debug'];

declare module 'express-session' {
    interface SessionData {
        user: string,
        subreddits: string[],
        lastCheck?: number,
        limit?: number,
        sort?: string,
        level?: string,
    }
}

const subLogMap: Map<string, LogEntry[]> = new Map();

const emitter = new EventEmitter();
const winstonStream = new Transform({
    transform(chunk, encoding, callback) {
        callback(null, chunk);
    }
});
const logStream = new Transform({
    transform(chunk, encoding, callback) {
        callback(null, chunk);
    }
});

logStream.on('end', () => {
    console.log('log end');
});

const rcbServer = function (options: OperatorConfig): ([() => Promise<void>, App]) {

    const {
        credentials: {
            clientId,
            clientSecret,
            redirectUri
        },
        operator: {
            name,
            display,
        },
        api: {
            secret: secret,
            port
        }
    } = options;

    const opNames = name.map(x => x.toLowerCase());
    let bot: App;
    let botSubreddits: string[] = [];

    winstonStream._write = (chunk, encoding, next) => {
        // remove newline (\n) from end of string since we deal with it with css/html
        const logLine = chunk.toString().slice(0, -1);
        const now = Date.now();
        const logEntry: LogEntry = [now, logLine];

        const subName = parseSubredditLogName(logLine);
        if (subName !== undefined && (botSubreddits.length === 0 || botSubreddits.includes(subName))) {
            const subLogs = subLogMap.get(subName) || [];
            subLogs.unshift(logEntry);
            subLogMap.set(subName, subLogs.slice(0, 200 + 1));
        } else {
            const appLogs = subLogMap.get('app') || [];
            appLogs.unshift(logEntry);
            subLogMap.set('app', appLogs.slice(0, 200 + 1));
        }

        emitter.emit('log', logLine);
        logStream.write(logLine);
        next();
    }

    const streamTransport = new winston.transports.Stream({
        stream: winstonStream,
    });

    const logger = getLogger({...options.logging, additionalTransports: [streamTransport]})

    // need to return App to main so that we can handle app shutdown on SIGTERM and discriminate between normal shutdown and crash on error
    bot = new App(options);

    const serverFunc = async function () {

        if (await tcpUsed.check(port)) {
            throw new SimpleError(`Specified port for API (${port}) is in use or not available. Cannot start API.`);
        }

        let server: http.Server,
            io: SocketServer;

        try {
            server = await app.listen(port);
            io = new SocketServer(server);
        } catch (err) {
            logger.error('Error occurred while initializing web or socket.io server', err);
            err.logged = true;
            throw err;
        }

        logger.info(`API started => localhost:${port}`);


        botSubreddits = bot.subManagers.map(x => x.displayLabel);
        // TODO potentially prune subLogMap of user keys? shouldn't have happened this early though

        const authUserCheck = (userRequired = true) => async (req: express.Request, res: express.Response, next: Function) => {
            if (req.isAuthenticated()) {
                if(userRequired && req.user.machine === true) {
                    return res.status(403).json({message: 'Must be authenticated as a user to access this route'});
                }
                next();
            } else {
                res.status(401).json('Must be authenticated to access this route');
            }
        }

        passport.use(new JwtStrategy({
            secretOrKey: secret,
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
        }, function (jwtPayload, done) {
            const {name, subreddits = [], machine = true} = jwtPayload.data;
            if(machine) {
                return done(null, {machine});
            }
            const isOperator = opNames.includes(name.toLowerCase());
            const moderatedManagers = bot.subManagers.filter(x => subreddits.includes(x.subreddit.display_name)).map(x => x.displayLabel);

            return done(null, {
                name,
                subreddits,
                isOperator,
                moderatedManagers,
                realManagers: isOperator ? bot.subManagers.map(x => x.displayLabel) : moderatedManagers
            });
        }));

        router.use('/*', passport.authenticate('jwt', {session: false}));
        router.use('/^(?!\\/heartbeat).*$/', authUserCheck(true));

        app.getAsync('/heartbeat', authUserCheck(false), (req: Request, res: Response) => {
            const heartbeatData = {
                subreddits: bot.subManagers.map(x => x.subreddit.display_name),
                operators: name,
                operatorDisplay: display,
                friendly: bot.botName,
                running: bot.heartBeating,
                nanny: bot.nannyMode,
                botName: bot.botName,
                botLink: bot.botLink,
            };
            return res.json(heartbeatData);
        });

        app.getAsync('/logs', booleanMiddle([{
            name: 'stream',
            defaultVal: false
        }]), async (req: Request, res: Response) => {
            const {name: userName, realManagers = [], isOperator} = req.user as Express.User;
            const {level = 'verbose', stream, limit = 200, sort = 'descending'} = req.query;
            if (stream) {
                const userStream = new Transform({
                    transform(chunk, encoding, callback) {
                        const log = chunk.toString();
                        if (isLogLineMinLevel(log, level as string)) {
                            const subName = parseSubredditLogName(log);
                            if (isOperator || (subName !== undefined && (realManagers.includes(subName) || subName.includes(userName)))) {
                                callback(null, `${chunk}\r\n`);
                            } else {
                                callback(null);
                            }
                        } else {
                            callback(null);
                        }
                    }
                });
                try {
                    userStream.on('end', () => {
                        console.log('user end');
                    });

                    logStream.pipe(userStream, {end: false});

                    userStream.pipe(res, {end: false});
                    await pEvent(req, 'close');
                    console.log('Request closed detected with "close" listener');
                    userStream.end();
                    res.destroy();
                    return;
                } catch (e) {

                    if (e.code !== 'ECONNRESET') {
                        logger.error(e);
                    }
                } finally {
                    userStream.end();
                    res.destroy();
                }
            } else {
                const logs = filterLogBySubreddit(subLogMap, realManagers, {
                    level: (level as string),
                    operator: isOperator,
                    user: userName,
                    sort: sort as 'descending' | 'ascending',
                    limit: Number.parseInt((limit as string))
                });
                const subArr: any = [];
                logs.forEach((v: string[], k: string) => {
                    subArr.push({name: k, logs: v.join('')});
                });
                return res.json(subArr);
            }
        });

        app.getAsync('/stats', async (req: Request, res: Response) => {
            return res.json(opStats(bot));
        });

        app.getAsync('/status', async (req: Request, res: Response) => {
            const {
                //subreddits = [],
                //user: userVal,
                limit = 200,
                level = 'verbose',
                sort = 'descending',
                lastCheck
            } = req.query;
            const { name: userName, realManagers = [], isOperator } = req.user as Express.User;
            const user = userName as string;
            const subreddits = realManagers;
            //const isOperator = opNames.includes(user.toLowerCase())

            if (realManagers.length === 0) {
                return res.json({});
                //return res.render('noSubs', {operatorDisplay: display});
            }

            const logs = filterLogBySubreddit(subLogMap, realManagers, {
                level: (level as string),
                operator: isOperator,
                user,
                // @ts-ignore
                sort,
                limit: Number.parseInt((limit as string))
            });

            const subManagerData = [];
            for (const s of subreddits) {
                const m = bot.subManagers.find(x => x.displayLabel === s) as Manager;
                const sd = {
                    name: s,
                    //linkName: s.replace(/\W/g, ''),
                    logs: logs.get(s) || [], // provide a default empty value in case we truly have not logged anything for this subreddit yet
                    botState: m.botState,
                    eventsState: m.eventsState,
                    queueState: m.queueState,
                    indicator: 'gray',
                    queuedActivities: m.queue.length(),
                    runningActivities: m.queue.running(),
                    maxWorkers: m.queue.concurrency,
                    subMaxWorkers: m.subMaxWorkers || bot.maxWorkers,
                    globalMaxWorkers: bot.maxWorkers,
                    validConfig: boolToString(m.validConfigLoaded),
                    dryRun: boolToString(m.dryRun === true),
                    pollingInfo: m.pollOptions.length === 0 ? ['nothing :('] : m.pollOptions.map(pollingInfo),
                    checks: {
                        submissions: m.submissionChecks === undefined ? 0 : m.submissionChecks.length,
                        comments: m.commentChecks === undefined ? 0 : m.commentChecks.length,
                    },
                    wikiLocation: m.wikiLocation,
                    wikiHref: `https://reddit.com/r/${m.subreddit.display_name}/wiki/${m.wikiLocation}`,
                    wikiRevisionHuman: m.lastWikiRevision === undefined ? 'N/A' : `${dayjs.duration(dayjs().diff(m.lastWikiRevision)).humanize()} ago`,
                    wikiRevision: m.lastWikiRevision === undefined ? 'N/A' : m.lastWikiRevision.local().format('MMMM D, YYYY h:mm A Z'),
                    wikiLastCheckHuman: `${dayjs.duration(dayjs().diff(m.lastWikiCheck)).humanize()} ago`,
                    wikiLastCheck: m.lastWikiCheck.local().format('MMMM D, YYYY h:mm A Z'),
                    stats: await m.getStats(),
                    startedAt: 'Not Started',
                    startedAtHuman: 'Not Started',
                    delayBy: m.delayBy === undefined ? 'No' : `Delayed by ${m.delayBy} sec`,
                };
                // TODO replace indicator data with js on client page
                let indicator;
                if (m.botState.state === RUNNING && m.queueState.state === RUNNING && m.eventsState.state === RUNNING) {
                    indicator = 'green';
                } else if (m.botState.state === STOPPED && m.queueState.state === STOPPED && m.eventsState.state === STOPPED) {
                    indicator = 'red';
                } else {
                    indicator = 'yellow';
                }
                sd.indicator = indicator;
                if (m.startedAt !== undefined) {
                    const dur = dayjs.duration(dayjs().diff(m.startedAt));
                    sd.startedAtHuman = `${dur.humanize()} ago`;
                    sd.startedAt = m.startedAt.local().format('MMMM D, YYYY h:mm A Z');

                    if (sd.stats.cache.totalRequests > 0) {
                        const minutes = dur.asMinutes();
                        if (minutes < 10) {
                            sd.stats.cache.requestRate = formatNumber((10 / minutes) * sd.stats.cache.totalRequests, {
                                toFixed: 0,
                                round: {enable: true, indicate: true}
                            });
                        } else {
                            sd.stats.cache.requestRate = formatNumber(sd.stats.cache.totalRequests / (minutes / 10), {
                                toFixed: 0,
                                round: {enable: true, indicate: true}
                            });
                        }
                    } else {
                        sd.stats.cache.requestRate = 0;
                    }
                }
                subManagerData.push(sd);
            }
            const totalStats = subManagerData.reduce((acc, curr) => {
                return {
                    checks: {
                        submissions: acc.checks.submissions + curr.checks.submissions,
                        comments: acc.checks.comments + curr.checks.comments,
                    },
                    eventsCheckedTotal: acc.eventsCheckedTotal + curr.stats.eventsCheckedTotal,
                    checksRunTotal: acc.checksRunTotal + curr.stats.checksRunTotal,
                    checksTriggeredTotal: acc.checksTriggeredTotal + curr.stats.checksTriggeredTotal,
                    rulesRunTotal: acc.rulesRunTotal + curr.stats.rulesRunTotal,
                    rulesCachedTotal: acc.rulesCachedTotal + curr.stats.rulesCachedTotal,
                    rulesTriggeredTotal: acc.rulesTriggeredTotal + curr.stats.rulesTriggeredTotal,
                    actionsRunTotal: acc.actionsRunTotal + curr.stats.actionsRunTotal,
                    maxWorkers: acc.maxWorkers + curr.maxWorkers,
                    subMaxWorkers: acc.subMaxWorkers + curr.subMaxWorkers,
                    globalMaxWorkers: acc.globalMaxWorkers + curr.globalMaxWorkers,
                    runningActivities: acc.runningActivities + curr.runningActivities,
                    queuedActivities: acc.queuedActivities + curr.queuedActivities,
                };
            }, {
                checks: {
                    submissions: 0,
                    comments: 0,
                },
                eventsCheckedTotal: 0,
                checksRunTotal: 0,
                checksTriggeredTotal: 0,
                rulesRunTotal: 0,
                rulesCachedTotal: 0,
                rulesTriggeredTotal: 0,
                actionsRunTotal: 0,
                maxWorkers: 0,
                subMaxWorkers: 0,
                globalMaxWorkers: 0,
                runningActivities: 0,
                queuedActivities: 0,
            });
            const {
                checks,
                maxWorkers,
                globalMaxWorkers,
                subMaxWorkers,
                runningActivities,
                queuedActivities,
                ...rest
            } = totalStats;

            let cumRaw = subManagerData.reduce((acc, curr) => {
                Object.keys(curr.stats.cache.types as ResourceStats).forEach((k) => {
                    acc[k].requests += curr.stats.cache.types[k].requests;
                    acc[k].miss += curr.stats.cache.types[k].miss;
                    acc[k].identifierAverageHit += Number.parseFloat(curr.stats.cache.types[k].identifierAverageHit);
                    acc[k].averageTimeBetweenHits += curr.stats.cache.types[k].averageTimeBetweenHits === 'N/A' ? 0 : Number.parseFloat(curr.stats.cache.types[k].averageTimeBetweenHits)
                });
                return acc;
            }, cacheStats());
            cumRaw = Object.keys(cumRaw).reduce((acc, curr) => {
                const per = acc[curr].miss === 0 ? 0 : formatNumber(acc[curr].miss / acc[curr].requests) * 100;
                // @ts-ignore
                acc[curr].missPercent = `${formatNumber(per, {toFixed: 0})}%`;
                acc[curr].identifierAverageHit = formatNumber(acc[curr].identifierAverageHit);
                acc[curr].averageTimeBetweenHits = formatNumber(acc[curr].averageTimeBetweenHits)
                return acc;
            }, cumRaw);
            const cacheReq = subManagerData.reduce((acc, curr) => acc + curr.stats.cache.totalRequests, 0);
            const cacheMiss = subManagerData.reduce((acc, curr) => acc + curr.stats.cache.totalMiss, 0);
            const aManagerWithDefaultResources = bot.subManagers.find(x => x.resources !== undefined && x.resources.cacheSettingsHash === 'default');
            let allManagerData: any = {
                name: 'All',
                linkName: 'All',
                indicator: 'green',
                maxWorkers,
                globalMaxWorkers,
                subMaxWorkers,
                runningActivities,
                queuedActivities,
                botState: {
                    state: RUNNING,
                    causedBy: SYSTEM
                },
                dryRun: boolToString(bot.dryRun === true),
                logs: logs.get('all'),
                checks: checks,
                softLimit: bot.softLimit,
                hardLimit: bot.hardLimit,
                stats: {
                    ...rest,
                    cache: {
                        currentKeyCount: aManagerWithDefaultResources !== undefined ? await aManagerWithDefaultResources.resources.getCacheKeyCount() : 'N/A',
                        isShared: false,
                        totalRequests: cacheReq,
                        totalMiss: cacheMiss,
                        missPercent: `${formatNumber(cacheMiss === 0 || cacheReq === 0 ? 0 : (cacheMiss / cacheReq) * 100, {toFixed: 0})}%`,
                        types: {
                            ...cumRaw,
                        }
                    }
                },
            };
            if (allManagerData.logs === undefined) {
                // this should happen but saw an edge case where potentially did
                logger.warn(`Logs for 'all' were undefined found but should always have a default empty value`);
            }
            // if(isOperator) {
            allManagerData.startedAt = bot.startedAt.local().format('MMMM D, YYYY h:mm A Z');
            allManagerData.heartbeatHuman = dayjs.duration({seconds: bot.heartbeatInterval}).humanize();
            allManagerData.heartbeat = bot.heartbeatInterval;
            allManagerData = {...allManagerData, ...opStats(bot)};
            //}

            const botDur = dayjs.duration(dayjs().diff(bot.startedAt))
            if (allManagerData.stats.cache.totalRequests > 0) {
                const minutes = botDur.asMinutes();
                if (minutes < 10) {
                    allManagerData.stats.cache.requestRate = formatNumber((10 / minutes) * allManagerData.stats.cache.totalRequests, {
                        toFixed: 0,
                        round: {enable: true, indicate: true}
                    });
                } else {
                    allManagerData.stats.cache.requestRate = formatNumber(allManagerData.stats.cache.totalRequests / (minutes / 10), {
                        toFixed: 0,
                        round: {enable: true, indicate: true}
                    });
                }
            } else {
                allManagerData.stats.cache.requestRate = 0;
            }

            const data = {
                userName: user,
                system: {
                    startedAt: bot.startedAt.local().format('MMMM D, YYYY h:mm A Z'),
                    ...opStats(bot),
                },
                subreddits: [allManagerData, ...subManagerData],
                // show: 'All',
                // botName: bot.botName,
                // botLink: bot.botLink,
                //operatorDisplay: display,
                // isOperator,
                // operators: opNames.length === 0 ? 'None Specified' : name.join(', '),
                // logSettings: {
                //     //limit: [10, 20, 50, 100, 200].map(x => `<a class="capitalize ${limit === x ? 'font-bold no-underline pointer-events-none' : ''}" data-limit="${x}" href="logs/settings/update?limit=${x}">${x}</a>`).join(' | '),
                //     limitSelect: [10, 20, 50, 100, 200].map(x => `<option ${limit === x ? 'selected' : ''} class="capitalize ${limit === x ? 'font-bold' : ''}" data-value="${x}">${x}</option>`).join(' | '),
                //     //sort: ['ascending', 'descending'].map(x => `<a class="capitalize ${sort === x ? 'font-bold no-underline pointer-events-none' : ''}" data-sort="${x}" href="logs/settings/update?sort=${x}">${x}</a>`).join(' | '),
                //     sortSelect: ['ascending', 'descending'].map(x => `<option ${sort === x ? 'selected' : ''} class="capitalize ${sort === x ? 'font-bold' : ''}" data-value="${x}">${x}</option>`).join(' '),
                //     //level: availableLevels.map(x => `<a class="capitalize log-${x} ${level === x ? `font-bold no-underline pointer-events-none` : ''}" data-log="${x}" href="logs/settings/update?level=${x}">${x}</a>`).join(' | '),
                //     levelSelect: availableLevels.map(x => `<option ${level === x ? 'selected' : ''} class="capitalize log-${x} ${level === x ? `font-bold` : ''}" data-value="${x}">${x}</option>`).join(' '),
                // },
            };
            // if (req.query.sub !== undefined) {
            //     const encoded = encodeURI(req.query.sub as string).toLowerCase();
            //     const shouldShow = data.subreddits.find(x => x.name.toLowerCase() === encoded);
            //     if (shouldShow !== undefined) {
            //         data.show = shouldShow.name;
            //     }
            // }

            return res.json(data);
            //res.render('status', data);
        });

        app.getAsync('/logs/settings/update', async function (req, res) {
            const e = req.query;
            for (const [setting, val] of Object.entries(req.query)) {
                switch (setting) {
                    case 'limit':
                        req.session.limit = Number.parseInt(val as string);
                        break;
                    case 'sort':
                        req.session.sort = val as string;
                        break;
                    case 'level':
                        req.session.level = val as string;
                        break;
                }
            }
            const {limit = 200, level = 'verbose', sort = 'descending', user} = req.session;

            res.send('OK');

            const subMap = filterLogBySubreddit(subLogMap, req.session.subreddits, {
                level,
                operator: opNames.includes((user as string).toLowerCase()),
                user,
                limit,
                sort: (sort as 'descending' | 'ascending'),
            });
            const subArr: any = [];
            subMap.forEach((v: string[], k: string) => {
                subArr.push({name: k, logs: v.join('')});
            });
            io.emit('logClear', subArr);
        });

        app.getAsync('/config', async (req, res) => {
            const {subreddit} = req.query as any;
            const { name: userName, realManagers = [], isOperator } = req.user as Express.User;
            if (!isOperator && !realManagers.includes(subreddit)) {
                return res.status(400).send('Cannot retrieve config for subreddit you do not manage or is not run by the bot')
            }
            const manager = bot.subManagers.find(x => x.displayLabel === subreddit);
            if (manager === undefined) {
                return res.status(400).send('Cannot retrieve config for subreddit you do not manage or is not run by the bot')
            }

            // @ts-ignore
            const wiki = await manager.subreddit.getWikiPage(manager.wikiLocation).fetch();
            return res.send(wiki.content_md);
        });

        app.getAsync('/action', [booleanMiddle(['force'])], async (req: express.Request, res: express.Response) => {
            const {type, action, subreddit, force = false} = req.query as any;
            const { name: userName, realManagers = [], isOperator } = req.user as Express.User;
            let subreddits: string[] = [];
            if (subreddit === 'All') {
                subreddits = realManagers;
            } else if (realManagers.includes(subreddit)) {
                subreddits = [subreddit];
            }

            for (const s of subreddits) {
                const manager = bot.subManagers.find(x => x.displayLabel === s);
                if (manager === undefined) {
                    logger.warn(`Manager for ${s} does not exist`, {subreddit: `/u/${userName}`});
                    continue;
                }
                const mLogger = manager.logger;
                mLogger.info(`/u/${userName} invoked '${action}' action for ${type} on ${manager.displayLabel}`);
                try {
                    switch (action) {
                        case 'start':
                            if (type === 'bot') {
                                await manager.start('user');
                            } else if (type === 'queue') {
                                manager.startQueue('user');
                            } else {
                                await manager.startEvents('user');
                            }
                            break;
                        case 'stop':
                            if (type === 'bot') {
                                await manager.stop('user');
                            } else if (type === 'queue') {
                                await manager.stopQueue('user');
                            } else {
                                manager.stopEvents('user');
                            }
                            break;
                        case 'pause':
                            if (type === 'queue') {
                                await manager.pauseQueue('user');
                            } else {
                                manager.pauseEvents('user');
                            }
                            break;
                        case 'reload':
                            const prevQueueState = manager.queueState.state;
                            const newConfig = await manager.parseConfiguration('user', force);
                            if (newConfig === false) {
                                mLogger.info('Config was up-to-date');
                            }
                            if (newConfig && prevQueueState === RUNNING) {
                                await manager.startQueue(USER);
                            }
                            break;
                        case 'check':
                            if (type === 'unmoderated') {
                                const activities = await manager.subreddit.getUnmoderated({limit: 100});
                                for (const a of activities.reverse()) {
                                    manager.queue.push({
                                        checkType: a instanceof Submission ? 'Submission' : 'Comment',
                                        activity: a,
                                    });
                                }
                            } else {
                                const activities = await manager.subreddit.getModqueue({limit: 100});
                                for (const a of activities.reverse()) {
                                    manager.queue.push({
                                        checkType: a instanceof Submission ? 'Submission' : 'Comment',
                                        activity: a,
                                    });
                                }
                            }
                            break;
                    }
                } catch (err) {
                    if (!(err instanceof LoggedError)) {
                        mLogger.error(err, {subreddit: manager.displayLabel});
                    }
                }
            }
            res.send('OK');
        });

        app.use('/check', [booleanMiddle(['dryRun'])]);
        app.getAsync('/check', async (req, res) => {
            const {url, dryRun, subreddit} = req.query as any;
            const { name: userName, realManagers = [], isOperator } = req.user as Express.User;

            let a;
            const commentId = commentReg(url);
            if (commentId !== undefined) {
                // @ts-ignore
                a = await bot.client.getComment(commentId);
            }
            if (a === undefined) {
                const submissionId = submissionReg(url);
                if (submissionId !== undefined) {
                    // @ts-ignore
                    a = await bot.client.getSubmission(submissionId);
                }
            }

            if (a === undefined) {
                logger.error('Could not parse Comment or Submission ID from given URL', {subreddit: `/u/${userName}`});
                return res.send('OK');
            } else {
                // @ts-ignore
                const activity = await a.fetch();
                const sub = await activity.subreddit.display_name;

                let manager = subreddit === 'All' ? bot.subManagers.find(x => x.subreddit.display_name === sub) : bot.subManagers.find(x => x.displayLabel === subreddit);

                if (manager === undefined || (!realManagers.includes(manager.displayLabel))) {
                    let msg = 'Activity does not belong to a subreddit you moderate or the bot runs on.';
                    if (subreddit === 'All') {
                        msg = `${msg} If you want to test an Activity against a Subreddit\'s config it does not belong to then switch to that Subreddit's tab first.`
                    }
                    logger.error(msg, {subreddit: `/u/${req.session.user}`});
                    return res.send('OK');
                }

                // will run dryrun if specified or if running activity on subreddit it does not belong to
                const dr: boolean | undefined = (dryRun || manager.subreddit.display_name !== sub) ? true : undefined;
                manager.logger.info(`/u/${userName} running${dr === true ? ' DRY RUN ' : ' '}check on${manager.subreddit.display_name !== sub ? ' FOREIGN ACTIVITY ' : ' '}${url}`);
                await manager.runChecks(activity instanceof Submission ? 'Submission' : 'Comment', activity, {dryRun: dr})
            }
            res.send('OK');
        });
    }

    return [serverFunc, bot];
};

const opStats = (bot: App) => {
    const limitReset = dayjs(bot.client.ratelimitExpiration);
    const nextHeartbeat = bot.nextHeartbeat !== undefined ? bot.nextHeartbeat.local().format('MMMM D, YYYY h:mm A Z') : 'N/A';
    const nextHeartbeatHuman = bot.nextHeartbeat !== undefined ? `in ${dayjs.duration(bot.nextHeartbeat.diff(dayjs())).humanize()}` : 'N/A'
    return {
        startedAtHuman: `${dayjs.duration(dayjs().diff(bot.startedAt)).humanize()}`,
        nextHeartbeat,
        nextHeartbeatHuman,
        apiLimit: bot.client.ratelimitRemaining,
        apiAvg: formatNumber(bot.apiRollingAvg),
        nannyMode: bot.nannyMode || 'Off',
        apiDepletion: bot.apiEstDepletion === undefined ? 'Not Calculated' : bot.apiEstDepletion.humanize(),
        limitReset,
        limitResetHuman: `in ${dayjs.duration(limitReset.diff(dayjs())).humanize()}`,
    }
}

export default rcbServer;

