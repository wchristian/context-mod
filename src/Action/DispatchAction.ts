import {ActionJson, ActionConfig, ActionOptions} from "./index";
import Action from "./index";
import Snoowrap, {Comment, Submission} from "snoowrap";
import {RuleResult} from "../Rule";
import {activityIsRemoved} from "../Utils/SnoowrapUtils";
import {ActionProcessResult, ActionTarget, ActivityDispatchConfig} from "../Common/interfaces";
import dayjs from "dayjs";
import {isSubmission, parseDurationValToDuration, randomId} from "../util";

export class DispatchAction extends Action {
    dispatchData: ActivityDispatchConfig;
    targets: ActionTarget[];

    getKind() {
        return 'Dispatch';
    }

    constructor(options: DispatchOptions) {
        super(options);
        const {
            identifier,
            cancelIfQueued = false,
            goto,
            delay,
            target = ['self']
        } = options;
        this.dispatchData = {
            identifier: identifier,
            cancelIfQueued,
            goto,
            delay,
        }
        this.targets = !Array.isArray(target) ? [target] : target;
    }

    async process(item: Comment | Submission, ruleResults: RuleResult[], runtimeDryrun?: boolean): Promise<ActionProcessResult> {
        const dryRun = runtimeDryrun || this.dryRun;

        const realTargets = isSubmission(item) ? ['self'] : this.targets;
        if (this.targets.includes('parent') && isSubmission(item)) {
            if (this.targets.includes('self')) {
                this.logger.warning(`Cannot use 'parent' as target because Activity is a Submission. Reverted to 'self'`);
            } else {
                return {
                    dryRun,
                    success: false,
                    result: `Cannot use 'parent' as target because Activity is a Submission.`,
                }
            }
        }

        const {delay, ...restDispatchData} = this.dispatchData;
        const dispatchPayload = {
            ...restDispatchData,
            delay,
            queuedAt: dayjs().unix(),
            duration: parseDurationValToDuration(delay),
            processing: false,
        };

        const dispatchActivitiesHints = [];
        for (const target of realTargets) {
            let act = item;
            let actHint = `Comment's parent Submission (${(item as Comment).link_id})`;
            if (target !== 'self') {
                if (!dryRun) {
                    act = await this.resources.getActivity(this.client.getSubmission((item as Comment).link_id));
                } else {
                    // don't need to spend api call to get submission if we won't actually do anything with it
                    // @ts-ignore
                    act = await this.resources.client.getSubmission((item as Comment).link_id);
                }
            } else {
                actHint = `This Activity (${item.name})`;
            }

            const existing = this.resources.delayedItems.filter(x => {
                const matchedActivityId = x.activity.name === act.name;
                const matchDispatchIdentifier = dispatchPayload.identifier === undefined ? true : dispatchPayload.identifier === x.identifier;
                return matchedActivityId && matchDispatchIdentifier;
            });

            if (existing.length > 0) {
                let existingRes = `Dispatch activities (${existing.map((x, index) => `[${index + 1}] Queued At ${dayjs.unix(x.queuedAt).format('YYYY-MM-DD HH:mm:ssZ')} for ${x.duration.humanize()}`).join(' ')}}) already exist for ${actHint}`;
                if (this.dispatchData.onExistingFound === 'skip') {
                    existingRes += ` and existing behavior is SKIP so nothing queued`;
                    continue;
                } else if (this.dispatchData.onExistingFound === 'replace') {
                    existingRes += ` and existing behavior is REPLACE so replaced existing`;
                    const existingIds = existing.map(x => x.id);
                    this.resources.delayedItems = this.resources.delayedItems.filter(x => !existingIds.includes(x.id));
                } else {
                    existingRes += ` but existing behavior is IGNORE so adding new dispatch activity anyway`;
                }
                dispatchActivitiesHints.push(existingRes);
            } else {
                dispatchActivitiesHints.push(actHint);
            }

            if (!dryRun) {
                this.resources.delayedItems.push({
                    ...dispatchPayload,
                    activity: act,
                    id: randomId(),
                    action: this.getActionUniqueName()
                });
            }
        }
        let dispatchBehaviors = [];
        if (dispatchPayload.identifier !== undefined) {
            dispatchBehaviors.push(`Identifier: ${dispatchPayload.identifier}`);
        }
        if (dispatchPayload.goto !== undefined) {
            dispatchBehaviors.push(`Goto: ${dispatchPayload.goto}`);
        }
        let result = `Delay: ${dispatchPayload.duration.humanize()}${dispatchBehaviors.length > 0 ? ` | ${dispatchBehaviors.join(' | ')}` : ''} | Dispatch Results: ${dispatchActivitiesHints.join(' <<>> ')}`;

        this.logger.verbose(result);
        return {
            dryRun,
            success: true,
            result,
        }
    }
}

export interface DispatchOptions extends DispatchActionConfig, ActionOptions {
}

export interface DispatchActionConfig extends ActionConfig, ActivityDispatchConfig {
    target: ActionTarget | ActionTarget[]
}

/**
 * Remove the Activity
 * */
export interface DispatchActionJson extends DispatchActionConfig, ActionJson {
    kind: 'dispatch'

}
