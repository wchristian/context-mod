import {IUser} from "../interfaces";

abstract class CMUser<Instance, Bot> implements IUser {
    protected constructor(public name: string, public subreddits: string[], public machine: boolean, public isOperator: boolean) {

    }

    public abstract isInstanceOperator(val: Instance): boolean;
    public abstract canAccessInstance(val: Instance): boolean;
    public abstract canAccessBot(val: Bot): boolean;
    public abstract canAccessSubreddit(val: Bot, name: string): boolean;
}

export default CMUser;
