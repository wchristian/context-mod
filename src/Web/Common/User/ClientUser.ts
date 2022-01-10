import {BotInstance, CMInstance} from "../../interfaces";
import CMUser from "./CMUser";
import {intersect} from "../../../util";

class ClientUser extends CMUser<CMInstance,BotInstance> {

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

}

export default ClientUser;
