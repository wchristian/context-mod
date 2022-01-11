import {BotInstance, CMInstance} from "../../interfaces";
import CMUser from "./CMUser";
import {intersect} from "../../../util";

class ClientUser extends CMUser<CMInstance, BotInstance, string> {

    isInstanceOperator(val: CMInstance): boolean {
        return val.operators.includes(this.name);
    }

    canAccessInstance(val: CMInstance): boolean {
        return this.isInstanceOperator(val) || intersect(this.subreddits, val.subreddits).length > 0;
    }

    canAccessBot(val: BotInstance): boolean {
        return this.isInstanceOperator(val.instance) || intersect(this.subreddits, val.subreddits).length > 0;
    }

    canAccessSubreddit(val: BotInstance, name: string): boolean {
        return this.isInstanceOperator(val.instance) || this.subreddits.includes(name);
    }

    accessibleBots(bots: BotInstance[]): BotInstance[] {
        if (bots.length === 0) {
            return bots;
        }
        return bots.filter(x => {
            if (this.isInstanceOperator(x.instance)) {
                return true;
            }
            return intersect(this.subreddits, x.subreddits).length > 0
        });
    }

    accessibleSubreddits(bot: BotInstance): string[] {
        return this.isInstanceOperator(bot.instance) ? bot.subreddits : intersect(this.subreddits, bot.subreddits);
    }

}

export default ClientUser;
