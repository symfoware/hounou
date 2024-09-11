# hounou
Command line tool deploy code to AWS Lambda.

# 設定ファイル
デフォルトで同じ階層にあるhounou.ymlを設定ファイルとして読み込みます。

hounou.ymlの形式

`Service:` サービスの名称 レイヤー名として採用します

`Functions:` 関数の定義  
Functions内に複数の関数定義を持つため、関数に識別用の名称を設定。
識別用の名称内に関数の具体的な定義を記載します。

関数の設定定義は、そのまま関数の作成(CreateFunctionCommand)や更新(UpdateFunctionCodeCommand)に渡されます。  
関数のドキュメントに記載されている内容がそのまま指定可能です。  
https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/lambda/command/CreateFunctionCommand/  
https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/lambda/command/UpdateFunctionCodeCommand/  

`Custom:` 関数の設定以外の指定  
`Prune:Number:` 未使用の関数バージョンをいくつ残すか 指定以上の古いバージョンを削除します。  
`Prune:IncludeLayers:` 関数バージョンに加えてNumberに指定した以上の古いレイヤーを削除します。  

`Package:` Lambdaにアップロードするファイルに関しての指定  
`Ignore:` 指定したファイル、パスはLambdaへのアップロードから除外します。  


hounou.ymlのサンプル

```
Service: debug
Functions:
  Test:
    FunctionName: debug # require
    Role: arn:aws:iam::012345678901:role/LambdaRole # require
    Handler: index.handler
    Description: 'debug description'
    Runtime: nodejs20.x
    MemorySize: 256
    Timeout: 75
    Environment:
      Variables:
        awsConfig: '{"region": "ap-northeast-1"}'

  Test2:
    FunctionName: debug2 # require
    Role: arn:aws:iam::012345678901:role/LambdaRole # require
    Handler: index.handler
    Description: 'debug2 description'
    Runtime: nodejs20.x
    MemorySize: 128
    Timeout: 15
    Environment:
      Variables:
        awsConfig: '{"region": "ap-northeast-1"}'

Custom:
  Prune:
    IncludeLayers: true
    Number: 5

# Exclude files from deployment
Package:
  Ignore:
    - 'test/**'
    - 'package.json'
    - 'package-lock.json'
    - 'deploy.yml'
```

# 実行方法
AWS CLI が設定済の場合  
`$ npx hounou`

APIキーを指定する場合  
`$ npx hounou --region=ap-northeast-1 --accessKeyId=[AccessKeyId] --secretAccessKey=[SecretAccessKey]`

deploy.yml以外の設定ファイルを指定する場合  
`$ npx hounou --config mydeploy.yml`


