import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export class Config {

    constructor(args) {
        this.args = args;
        this.dir = process.cwd();
        
        const config = path.join(this.dir, args.config);

        if (!fs.existsSync(config)) {
            throw new Error(`not found ${args.config}.`);
        }

        this.doc = yaml.load(fs.readFileSync(args.config, 'utf8'));

        if (!this.doc.Service) {
            throw new Error(`Service is not defined.`);
        }
        if (!this.doc.Functions) {
            throw new Error(`Functions is not defined.`);
        }

        const functions = this.doc.Functions;
        for (const key in functions) {
            const func = functions[key];
            if (!func.FunctionName) {
                throw new Error(`Functions FunctionName is not defined.`);
            }
            if (!func.Role) {
                throw new Error(`Functions Role is not defined.`);
            }
        }

    }

    // 関数作成時に必要な設定情報を取得
    getFunctionCreateInfo(name) {
        
        const func = this.getFunctionInfo(name);
        const info = this.margeInfo({
            Publish: true,
            PackageType: 'Zip',
        }, func);

        return info;
    }


    // 関数更新時に必要な設定情報を取得
    getFunctionUpdateInfo(name) {

        const func = this.getFunctionInfo(name);
        return func;
    }

    // deploy.ymlの設定情報からLambdaの設定へ変換
    margeInfo(base, info) {
        return Object.assign(info, base);
    }

    getFunctionInfo(name) {
        for (const key in this.doc.Functions) {
            const func = this.doc.Functions[key];
            if (func.FunctionName === name) {
                return func;
            }
        }
        return null;
    }


}