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

}