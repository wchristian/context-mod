import {Rule, RuleJSONConfig, RuleOptions, RuleResult} from "./index";
import {Listing, SearchOptions} from "snoowrap";
import Submission from "snoowrap/dist/objects/Submission";
import Comment from "snoowrap/dist/objects/Comment";
import {
    FAIL, formatNumber,
    isRepostItemResult,
    parseUsableLinkIdentifier,
    PASS, searchAndReplace, stringSameness, triggeredIndicator, windowToActivityWindowCriteria, wordCount
} from "../util";
import {
    ActivityWindow,
    ActivityWindowType, JoinOperands, RepostItem, RepostItemResult, SearchAndReplaceRegExp, SearchFacetType,
} from "../Common/interfaces";
import objectHash from "object-hash";
import {getActivities, getAttributionIdentifier} from "../Utils/SnoowrapUtils";
import Fuse from "fuse.js";
import leven from "leven";
import {YoutubeClient, commentsAsRepostItems} from "../Utils/ThirdParty/YoutubeClient";

const parseYtIdentifier = parseUsableLinkIdentifier();

export interface TextMatchOptions {
    /**
     * The percentage, as a whole number, of a repost title/comment that must match the title/comment being checked in order to consider both a match
     *
     * Note: Setting to 0 will make every candidate considered a match -- useful if you want to match if the URL has been reposted anywhere
     *
     * Defaults to `85` (85%)
     *
     * @default 85
     * @example [85]
     * */
    matchScore?: number

    /**
     * The minimum number of words in the activity being checked for which this rule will run on
     *
     * If the word count is below the minimum the rule fails
     *
     * Defaults to 2
     *
     * @default 2
     * @example [2]
     * */
    minWordCount?: number

    /**
     * Should text matching be case sensitive?
     *
     * Defaults to false
     *
     * @default false
     * @example [false]
     **/
    caseSensitive?: boolean
}

export interface TextTransformOptions {
    /**
     * A set of search-and-replace operations to perform on text values before performing a match. Transformations are performed in the order they are defined.
     *
     * * If `transformationsActivity` IS NOT defined then these transformations will be performed on BOTH the activity text (submission title or comment) AND the repost candidate text
     * * If `transformationsActivity` IS defined then these transformations are only performed on repost candidate text
     * */
    transformations?: SearchAndReplaceRegExp[]

    /**
     * Specify a separate set of transformations for the activity text (submission title or comment)
     *
     * To perform no transformations when `transformations` is defined set this to an empty array (`[]`)
     * */
    transformationsActivity?: SearchAndReplaceRegExp[]
}

export interface SearchFacetJSONConfig extends TextMatchOptions, TextTransformOptions, ActivityWindow {
    kind: SearchFacetType | SearchFacetType[]
}

export interface SearchFacet extends SearchFacetJSONConfig {
    kind: SearchFacetType
}

/**
 * A set of criteria used to find reposts
 *
 * Contains options and conditions used to define how candidate reposts are retrieved and if they are a match.
 *
 * */
export interface RepostCriteria extends ActivityWindow {
    /**
     * Define how to find candidate reposts
     *
     * * **title** -- search reddit for submissions with the same title
     * * **url** -- search reddit for submissions with the same url
     * * **external** -- WHEN ACTIVITY IS A COMMENT - tries to get comments from external source (youtube, twitter, etc...)
     * */
    searchOn?: (SearchFacetType | SearchFacetJSONConfig)[]

    criteria?: TextMatchOptions & TextTransformOptions

    /**
     * The maximum number of comments/submissions to check
     *
     * In both cases this list is gathered from sorting all submissions or all comments from all submission by number of votes and taking the "top" maximum specified
     *
     * For comment checks this is the number of comments cached
     *
     * @default 50
     * @example [50]
     * */
    maxRedditItems?: number

    /**
     * The maximum number of external items (youtube comments) to check (and cache for comment checks)
     *
     * @default 50
     * @example [50]
     * */
    maxExternalItems?: number
}

const parentSubmissionSearchFacetDefaults = {
    title: {
        matchScore: 85,
        minWordCount: 2
    },
    url: {
        matchScore: 0, // when looking for submissions to find repost comments on automatically include any with exact same url
    },
    duplicates: {
        matchScore: 0, // when looking for submissions to find repost comments on automatically include any that reddit thinks are duplicates
    },
    crossposts: {
        matchScore: 0, // when looking for submissions to find repost comments on automatically include any that reddit thinks are crossposts
    },
    external: {}
}

const isSearchFacetType = (val: any): val is SearchFacetType => {
    if (typeof val === 'string') {
        return ['title', 'url', 'duplicates', 'crossposts', 'external'].includes(val);
    }
    return false;
}

const generateSearchFacet = (val: SearchFacetType | SearchFacetJSONConfig): SearchFacet[] => {
    let facets: SearchFacet[] = [];
    if (isSearchFacetType(val)) {
        facets.push({
            kind: val
        });
    } else if (Array.isArray(val.kind)) {
        facets.concat(val.kind.map(x => ({...val, kind: x})));
    } else {
        facets.push(val as SearchFacet);
    }

    return facets.map(x => {
        return {
            ...parentSubmissionSearchFacetDefaults[x.kind],
            ...x,
        }
    });
}

export class RepostRule extends Rule {
    criteria: RepostCriteria[]
    condition: JoinOperands;

    submission?: Submission;

    constructor(options: RepostRuleOptions) {
        super(options);
        const {
            criteria = [{}],
            condition = 'OR'
        } = options || {};
        if (criteria.length < 1) {
            throw new Error('Must provide at least one RepostCriteria');
        }
        this.criteria = criteria;
        this.condition = condition;
    }

    getKind(): string {
        return 'Repost';
    }

    protected getSpecificPremise(): object {
        return {
            criteria: this.criteria,
            condition: this.condition
        }
    }

    // @ts-ignore
    protected async getSubmission(item: Submission | Comment) {
        if (item instanceof Comment) {
            // @ts-ignore
            return await this.client.getSubmission(item.link_id).fetch();
        }
        return item;
    }

    protected async process(item: Submission | Comment): Promise<[boolean, RuleResult]> {

        let criteriaResults: RepostItemResult[] = [];
        let ytClient: YoutubeClient | undefined = undefined;
        let criteriaMatchedResults: RepostItemResult[] = [];
        let totalSubs = 0;
        let totalCommentSubs = 0;
        let totalComments = 0;
        let totalExternal = new Map<string,number>();
        let fromCache = false;
        let andFail = false;

        for (const rCriteria of this.criteria) {
            criteriaMatchedResults = [];
            const {
                searchOn = (item instanceof Submission ? ['title', 'url', 'duplicates', 'crossposts'] : ['external', 'title', 'url', 'duplicates', 'crossposts']),
                criteria = {},
                maxRedditItems = 50,
                maxExternalItems = 50,
                window = 20,
            } = rCriteria;

            const searchFacets = searchOn.map(x => generateSearchFacet(x)).flat(1) as SearchFacet[];

            const includeCrossposts = searchFacets.some(x => x.kind === 'crossposts');

            // in getDuplicate() options add "crossposts_only=1" to get only crossposts https://www.reddit.com/r/redditdev/comments/b4t5g4/get_all_the_subreddits_that_a_post_has_been/
            // if a submission is a crosspost it has "crosspost_parent" attribute https://www.reddit.com/r/redditdev/comments/l46y2l/check_if_post_is_a_crosspost/

            const strongWindow = windowToActivityWindowCriteria(window);

            const candidateHash = `repostItems-${item instanceof Submission ? item.id : item.link_id}-${objectHash.sha1({
                window,
                searchOn
            })}`;
            let items: (RepostItem|RepostItemResult)[] = [];
            let cacheRes = undefined;
            if (item instanceof Comment) {
                cacheRes = await this.resources.cache.get(candidateHash) as ((RepostItem|RepostItemResult)[] | undefined | null);
            }

            if (cacheRes === undefined || cacheRes === null) {

                const sub = await this.getSubmission(item);
                let dups: (Submission[] | undefined) = undefined;

                for (const sf of searchFacets) {

                    const {
                        matchScore = 85,
                        minWordCount = 2,
                        transformations = [],
                    } = sf;

                    if (sf.kind === 'external') {
                        const attribution = getAttributionIdentifier(sub);
                        switch (attribution.provider) {
                            case 'YouTube':
                                const ytCreds = this.resources.getThirdPartyCredentials('youtube')
                                if (ytCreds === undefined) {
                                    throw new Error('Cannot extract comments from Youtube because a Youtube Data API key was not provided in configuration');
                                }
                                if (ytClient === undefined) {
                                    ytClient = new YoutubeClient(ytCreds.apiKey);
                                }
                                const ytComments = commentsAsRepostItems(await ytClient.getVideoTopComments(sub.url, maxExternalItems));
                                items = items.concat(ytComments)
                                totalExternal.set('Youtube comments', (totalExternal.get('Youtube comments') ?? 0) + ytComments.length);
                                break;
                            default:
                                if (attribution.provider === undefined) {
                                    this.logger.debug('Unable to determine external provider');
                                    continue;
                                } else {
                                    this.logger.debug(`External parsing of ${attribution} is not supported yet.`);
                                    continue;
                                }
                        }
                    } else {
                        let subs: Submission[];

                        if (['title', 'url'].includes(sf.kind)) {
                            let query: string;
                            let searchFunc: (limit: number) => Promise<Listing<Submission | Comment>>;
                            if (sf.kind === 'title') {
                                query = (await this.getSubmission(item)).title;
                                searchFunc = (limit: number) => {
                                    let opts: SearchOptions = {
                                        query,
                                        limit,
                                        sort: 'relevance'
                                    };
                                    if (strongWindow.subreddits?.include !== undefined && strongWindow.subreddits?.include.length > 0) {
                                        opts.restrictSr = true;
                                        opts.subreddit = strongWindow.subreddits?.include.join('+');
                                    }
                                    return this.client.search(opts);
                                }
                            } else {
                                const attr = getAttributionIdentifier(sub);
                                if (attr.provider === 'YouTube') {
                                    const ytId = parseYtIdentifier(sub.url);
                                    query = `url:https://youtu.be/${ytId}`;
                                } else {
                                    query = `url:${sub.url}`;
                                }
                                searchFunc = (limit: number) => {
                                    let opts: SearchOptions = {
                                        query,
                                        limit,
                                        sort: 'top'
                                    };
                                    if (strongWindow.subreddits?.include !== undefined && strongWindow.subreddits?.include.length > 0) {
                                        opts.restrictSr = true;
                                        opts.subreddit = strongWindow.subreddits?.include.join('+');
                                    }
                                    return this.client.search(opts);
                                }
                            }
                            subs = await getActivities(searchFunc, {window: strongWindow}) as Submission[];
                        } else {

                            if (dups === undefined) {
                                let searchFunc: (limit: number) => Promise<Listing<Submission | Comment>> = (limit: number) => {
                                    // this does not work correctly
                                    // see https://github.com/not-an-aardvark/snoowrap/issues/320
                                    // searchFunc = (limit: number) => {
                                    //     return sub.getDuplicates({crossposts_only: 0, limit});
                                    // };
                                    return this.client.oauthRequest({
                                        uri: `duplicates/${sub.id}`,
                                        qs: {
                                            limit,
                                        }
                                    }).then(x => {
                                        return Promise.resolve(x.comments) as Promise<Listing<Submission>>
                                    });
                                };
                                subs = await getActivities(searchFunc, {window: strongWindow}) as Submission[];
                                dups = subs;
                            } else {
                                subs = dups;
                            }

                            if (sf.kind === 'duplicates') {
                                // @ts-ignore
                                subs = subs.filter(x => x.crosspost_parent === undefined)
                            } else {
                                // @ts-ignore
                                subs = subs.filter(x => x.crosspost_parent !== undefined && x.crosspost_parent === sub.id)
                            }
                        }

                        // filter by minimum word count
                        subs = subs.filter(x => wordCount(x.title) > minWordCount);

                        items = items.concat(subs.map(x => ({
                            value: searchAndReplace(x.title, transformations),
                            createdOn: x.created,
                            source: 'reddit',
                            sourceUrl: x.permalink,
                            score: x.score,
                            itemType: 'submission',
                            acquisitionType: sf.kind,
                            sourceObj: x,
                            reqSameness: matchScore,
                        })));

                    }
                }

                if (!includeCrossposts) {
                    const sub = await this.getSubmission(item);
                    // remove submissions if they are official crossposts of the submission being checked and searchOn did not include 'crossposts'
                    items = items.filter(x => x.itemType !== 'submission' || !(x.sourceObj.crosspost_parent !== undefined && x.sourceObj.crosspost_parent === sub.id))
                }

                let sourceTitle = searchAndReplace(sub.title, criteria.transformationsActivity ?? []);

                // do submission scoring BEFORE pruning duplicates bc...
                // might end up in a situation where we get same submission for both title and url
                // -- url is always a repost but title is not guaranteed and we if remove the url item but not the title we could potentially filter the title submission out and miss this repost
                items = items.reduce((acc: (RepostItem|RepostItemResult)[], x) => {
                    if(x.itemType === 'submission') {
                        totalSubs++;
                        const sf = searchFacets.find(y => y.kind === x.acquisitionType) as SearchFacet;

                        let cleanTitle = x.value;
                        if (!(sf.caseSensitive ?? false)) {
                            cleanTitle = cleanTitle.toLowerCase();
                        }
                        const [distance, sameness] = stringSameness(sourceTitle, cleanTitle);
                        if(sameness >= (x.reqSameness as number)) {
                            return acc.concat({
                                ...x,
                                sameness,
                            });
                        }
                        return acc;
                    }
                    return acc.concat(x);
                }, []);

                // now remove duplicate submissions
                items = items.reduce((acc: RepostItem[], curr) => {
                    if(curr.itemType !== 'submission') {
                        return acc.concat(curr);
                    }
                    const subId = curr.sourceObj.id;
                    if (sub.id !== subId && !acc.some(x => x.itemType === 'submission' && x.sourceObj.id === subId)) {
                        return acc.concat(curr);
                    }
                    return acc;
                }, []);


                if (item instanceof Comment) {
                    // we need to gather comments from submissions

                    // first cut down the number of submissions to retrieve because we don't care about have ALL submissions,
                    // just most popular comments (which will be in the most popular submissions)
                    let subs = items.filter(x => x.itemType === 'submission').map(x => x.sourceObj) as Submission[];
                    totalCommentSubs += subs.length;

                    const nonSubItems = items.filter(x => x.itemType !== 'submission');

                    subs.sort((a, b) => a.score - b.score).reverse();
                    // take top 10 submissions
                    subs = subs.slice(0, 10);

                    let comments: Comment[] = [];
                    for (const sub of subs) {

                        const commFunc = (limit: number) => {
                            return this.client.oauthRequest({
                                uri: `${sub.subreddit_name_prefixed}/comments/${sub.id}`,
                                // get ONLY top-level comments, sorted by Top
                                qs: {
                                    sort: 'top',
                                    depth: 0,
                                    limit,
                                }
                            }).then(x => {
                                return x.comments as Promise<Listing<Comment>>
                            });
                        }
                        // and return the top 20 most popular
                        const subComments = await getActivities(commFunc, {window: {count: 20}, skipReplies: true}) as Listing<Comment>;
                        comments = comments.concat(subComments);
                    }

                    // sort by highest scores
                    comments.sort((a, b) => a.score - b.score).reverse();
                    // filter out all comments with fewer words than required (prevent false negatives)
                    comments.filter(x => wordCount(x.body) > (criteria.minWordCount ?? 2));
                    totalComments += Math.min(comments.length, maxRedditItems);

                    // and take the user-defined maximum number of items
                    items = nonSubItems.concat(comments.slice(0, maxRedditItems).map(x => ({
                        value: searchAndReplace(x.body, criteria.transformations ?? []),
                        createdOn: x.created,
                        source: 'reddit',
                        sourceUrl: x.permalink,
                        score: x.score,
                        itemType: 'comment',
                        acquisitionType: 'comment'
                    })));
                }

                // cache items for 20 minutes
                await this.resources.cache.set(candidateHash, items, {ttl: 1200});
            } else {
                items = cacheRes;
                totalExternal = items.reduce((acc, curr) => {
                    if(curr.acquisitionType === 'external') {
                        acc.set(`${curr.source} comments`, (acc.get(`${curr.source} comments`) ?? 0 ) + 1);
                        return acc;
                    }
                    return acc;
                }, new Map<string, number>());
                //totalSubs = items.filter(x => x.itemType === 'submission').length;
                //totalCommentSubs = totalSubs;
                totalComments = items.filter(x => x.itemType === 'comment' && x.source === 'reddit').length;
                fromCache = true;
            }

            if(item instanceof Submission) {
                // we've already done difference calculations in the searchFacet phase
                // and when the check is for a sub it means we are only checking if the submissions has been reposted which means either:
                // * very similar title (default sameness of 85% or more)
                // * duplicate/same URL -- which is a repost, duh
                // so just add all items to critMatches at this point
                criteriaMatchedResults = criteriaMatchedResults.concat(items.filter(x => "sameness" in x) as RepostItemResult[]);
            } else {
                const {
                    matchScore = 85,
                    caseSensitive = false,
                    transformations = [],
                    transformationsActivity = transformations,
                } = criteria;

                let sourceContent = searchAndReplace(item.body, transformationsActivity);
                if (!caseSensitive) {
                    sourceContent = sourceContent.toLowerCase();
                }

                for (const i of items) {
                    const itemContent = !caseSensitive ? i.value.toLowerCase() : i.value;
                    const [distance, sameness] = stringSameness(sourceContent, itemContent);
                    if(sameness >= matchScore) {
                        criteriaMatchedResults.push({
                          ...i,
                          reqSameness: sameness,
                          sameness
                        });
                    }
                }
            }

            if (criteriaMatchedResults.length === 0 && this.condition === 'AND') {
                andFail = true;
                break;
            }
            if (criteriaMatchedResults.length > 0) {
                criteriaResults = criteriaResults.concat(criteriaMatchedResults);
                if (this.condition === 'OR') {
                    break;
                }
            }
        }
        criteriaResults.sort((a, b) => a.sameness - b.sameness).reverse();
        const foundRepost = criteriaResults.length > 0;


        let avgSameness = null;
        let searchCandidateSummary = '';

        if(item instanceof Comment) {
            searchCandidateSummary = `Searched top ${totalComments} comments in top 10 ${fromCache ? '' : `of ${totalCommentSubs} `}most popular submissions`;
            if(totalExternal.size > 0) {
                searchCandidateSummary += ", ";
                const extSumm: string[] = [];
                totalExternal.forEach((v, k) => {
                    extSumm.push(`${v} ${k}`);
                });
                searchCandidateSummary += extSumm.join(', ');
            }
        } else {
            searchCandidateSummary = `Searched ${totalSubs}`
        }

        let summary = `${searchCandidateSummary} and found ${criteriaResults.length} reposts.`;

        if(criteriaResults.length > 0) {
            avgSameness = formatNumber(criteriaResults.reduce((acc, curr) => acc + curr.sameness, 0) / criteriaResults.length);
            const closest = criteriaResults[0];
            summary += ` --- Closest Match => >> ${closest.value} << from ${closest.source} (${closest.sourceUrl}) with ${formatNumber(closest.sameness)}% sameness.`
            if(criteriaResults.length > 1) {
                summary += ` Avg ${formatNumber(avgSameness)}%`;
            }

            if(andFail) {
                summary += ' BUT at least one criteria failed to find reposts so the rule fails (AND condition)';
            }
        }

        const passed = foundRepost && !andFail;

        const result = `${passed ? PASS : FAIL} ${summary}`;
        this.logger.verbose(result);

        return [passed, this.getResult(passed, {
            result,
            data: criteriaResults
        })];
    }
}

interface RepostConfig {
    /**
     * A list of Regular Expressions and conditions under which tested Activity(ies) are matched
     * @minItems 1
     * @examples [{"regex": "/reddit/", "matchThreshold": "> 3"}]
     * */
    criteria?: RepostCriteria[]
    /**
     * * If `OR` then any set of Criteria that pass will trigger the Rule
     * * If `AND` then all Criteria sets must pass to trigger the Rule
     *
     * @default "OR"
     * */
    condition?: 'AND' | 'OR'
}

export interface RepostRuleOptions extends RepostConfig, RuleOptions {
}

/**
 * Search for reposts of a Submission or Comment
 *
 * * For submissions the title or URL can searched and matched against
 * * For comments, candidate comments are gathered from similar reddit submissions and/or external sources (youtube, twitter, etc..) and then matched against
 *
 * */
export interface RepostRuleJSONConfig extends RepostConfig, RuleJSONConfig {
    /**
     * @examples ["repost"]
     * */
    kind: 'repost'
}
