import {Request, Response} from 'express';
import {boolToString, cacheStats, filterLogBySubreddit, formatNumber, LogEntry, pollingInfo} from "../../../../../util";
import {Manager} from "../../../../../Subreddit/Manager";
import dayjs from "dayjs";
import {ResourceStats, RUNNING, STOPPED, SYSTEM} from "../../../../../Common/interfaces";
import {BotStatusResponse} from "../../../../Common/interfaces";
import winston from "winston";
import {opStats} from "../../../../Common/util";
import {authUserCheck, botRoute} from "../../../middleware";

const status = (subLogMap: Map<string, LogEntry[]>) => {

    const middleware = [
        authUserCheck(),
        botRoute(),
    ];

    const response = async (req: Request, res: Response) => {
        const {
            //subreddits = [],
            //user: userVal,
            limit = 200,
            level = 'verbose',
            sort = 'descending',
            lastCheck
        } = req.query;

        const bot = req.serverBot;

        if (bot === undefined) {
            return res.status(500).send('Bot is offline');
        }
        const {name: userName, realManagers = [], isOperator} = req.user as Express.User;
        const user = userName as string;
        const subreddits = realManagers;
        //const isOperator = opNames.includes(user.toLowerCase())

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
                // @ts-ignore
                acc[k].identifierAverageHit += (typeof curr.stats.cache.types[k].identifierAverageHit === 'string' ? Number.parseFloat(curr.stats.cache.types[k].identifierAverageHit) : curr.stats.cache.types[k].identifierAverageHit);
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
            status: 'ONLINE',
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
            winston.loggers.get('default').warn(`Logs for 'all' were undefined found but should always have a default empty value`);
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

        const data: BotStatusResponse = {
            system: {
                startedAt: bot.startedAt.local().format('MMMM D, YYYY h:mm A Z'),
                online: true,
                ...opStats(bot),
            },
            subreddits: [allManagerData, ...subManagerData],
        };

        return res.json(data);
    };

    return [...middleware, response];
}

export default status;
