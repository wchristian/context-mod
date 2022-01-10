import {BotInstance, CMInstance} from "../../interfaces";
import CMUser from "./CMUser";
import {intersect} from "../../../util";
import {App} from "../../../App";
import Bot from "../../../Bot";

class ServerUser extends CMUser<App,Bot> {

    isInstanceOperator(val: App): boolean {
        return this.isOperator;
    }

    canAccessInstance(val: App): boolean {
        return this.isOperator || val.bots.filter(x => intersect(this.subreddits, x.subManagers.map(y => y.subreddit.display_name))).length > 0;
    }

    canAccessBot(val: Bot): boolean {
        return this.isOperator || intersect(this.subreddits, val.subManagers.map(y => y.subreddit.display_name)).length > 0;
    }

    canAccessSubreddit(val: Bot, name: string): boolean {
        return this.isOperator || this.subreddits.includes(name) && val.subManagers.some(y => y.subreddit.display_name === name);
    }

}

export default ServerUser;
