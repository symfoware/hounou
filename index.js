import { ArgumentParser } from 'argparse';
import { Config } from './lib/config.js';
import { Lambda } from './lib/lambda.js';

const main = async () => {
    const parser = new ArgumentParser({
        description: 'Argparse example'
      });
    //parser.add_argument('deploy');
    parser.add_argument('--region');
    parser.add_argument('--accessKeyId');
    parser.add_argument('--secretAccessKey');
    const args = parser.parse_args();
    
    try {
        const config = new Config(args);
        const lambda = new Lambda(config);

        // 処理フロー
        // 変更が必要な内容を確定
        await lambda.makeTask();

        // 変更実施
        // バージョン発行

        // 不要なバージョン、レイヤーを削除







        // 指定された関数情報取得
        //await lambda.getFunctionsInfo();
        
        // レイヤー作成
        //await lambda.createLayers();
    
        // レイヤー情報取得
        //await lambda.getLayer();
        //await lambda.test();
    
        // 本体関数更新
        //await lambda.update();
        // バージョン発行
        //await lambda.publishVersion();
        
    } catch(e) {
        console.error(e.message);
        console.error(e);
    }

};


export default main;

