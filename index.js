import { ArgumentParser } from 'argparse';

const parser = new ArgumentParser({
    description: 'Argparse example'
  });
//parser.add_argument('deploy');
parser.add_argument('--region');
parser.add_argument('--accessKeyId');
parser.add_argument('--secretAccessKey');
const args = parser.parse_args();



import { Config } from './lib/config.js';
import { Lambda } from './lib/lambda.js';

try {
    const config = new Config(args);
    const lambda = new Lambda(config);
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
    await lambda.publishVersion();
    
} catch(e) {
    console.error(e.message);
}




