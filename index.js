import { ArgumentParser } from 'argparse';
import { Config } from './lib/config.js';
import { Lambda } from './lib/lambda.js';

const main = async () => {
    const parser = new ArgumentParser({
        description: 'AWS Lambda Deploy Tool Hounou'
    });
    
    parser.add_argument('--region');
    parser.add_argument('--accessKeyId');
    parser.add_argument('--secretAccessKey');
    parser.add_argument('--config', {default: 'deploy.yml'});
    const args = parser.parse_args();

    try {
        const config = new Config(args);
        const lambda = new Lambda(config);
        
        // 処理フロー
        // 変更が必要な内容を確定
        await lambda.makeTask();

        // 変更実施
        await lambda.deploy();

        // 不要なバージョン、レイヤーを削除
        await lambda.clean();
        
    } catch(e) {
        console.error(e.message);
        console.error(e);
    }

};


export default main;

