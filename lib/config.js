import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export class Config {
    constructor(args, configFile='deploy.yml') {
        //this.dir = path.dirname(url.fileURLToPath(import.meta.url));
        this.args = args;

        this.dir = process.cwd();
        const config = path.join(this.dir, configFile);

        if (!fs.existsSync(config)) {
            throw new Error(`not found ${configFile}.`);
        }

        this.doc = yaml.load(fs.readFileSync(configFile, 'utf8'));
    }

}