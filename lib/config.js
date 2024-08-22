import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export class Config {

    constructor(args, configFile='deploy.yml') {
        this.args = args;
        this.dir = process.cwd();
        
        const config = path.join(this.dir, configFile);

        if (!fs.existsSync(config)) {
            throw new Error(`not found ${configFile}.`);
        }

        this.doc = yaml.load(fs.readFileSync(configFile, 'utf8'));

        if (!this.doc.service) {
            throw new Error(`service is not defined.`);
        }
        if (!this.doc.functions) {
            throw new Error(`functions is not defined.`);
        }

        const functions = this.doc.functions;
        for (const key in functions) {
            const func = functions[key];
            if (!func.name) {
                throw new Error(`functions name is not defined.`);
            }
            if (!func.role) {
                throw new Error(`functions role is not defined.`);
            }
        }

    }

    // 関数作成時に必要な設定情報を取得
    getFunctionCreateInfo(name) {
        
        const func = this.getFunctionInfo(name);
        const info = this.margeInfo({
            FunctionName: name, // required
            Role: func.role, // required
            Publish: true,
            PackageType: 'Zip',
        }, func);

        return info;
    }


    // 関数更新時に必要な設定情報を取得
    getFunctionUpdateInfo(name) {

        const func = this.getFunctionInfo(name);
        const info = this.margeInfo({
            FunctionName: name, // required
            Role: func.role, // required
        }, func);

        return info;
    }

    // deploy.ymlの設定情報からLambdaの設定へ変換
    margeInfo(base, info) {

        const map = {
            handler: 'Handler',
            description: 'Description',
            runtime: 'Runtime',
            memorySize: 'MemorySize',
            timeout: 'Timeout'
        };

        for (const key in map) {
            if (!info[key]) {
                continue;
            }
            base[map[key]] = info[key];
        }

        // 環境変数指定あり
        if (info['environment']) {
            base['Environment'] = {
                Variables: info['environment']
            }
        }

        // VPC設定あり
        if (info['vpc']) {
            base['VpcConfig'] = {};

            if (info['vpc']['subnetIds']) {
                base['VpcConfig']['SubnetIds'] = info['vpc']['subnetIds'];
            }
            if (info['vpc']['securityGroupIds']) {
                base['VpcConfig']['SecurityGroupIds'] = info['vpc']['securityGroupIds'];
            }
        }

        return base;
    }

    getFunctionInfo(name) {
        for (const key in this.doc.functions) {
            const func = this.doc.functions[key];
            if (func.name === name) {
                return func;
            }
        }
        return null;
    }


}