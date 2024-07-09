import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { Writable } from 'node:stream';
import { setTimeout } from 'node:timers/promises';
import archiver from 'archiver';

import {
    LambdaClient,
    CreateFunctionCommand,
    UpdateFunctionCodeCommand,
    UpdateFunctionConfigurationCommand,
    PublishVersionCommand,
    GetFunctionConfigurationCommand,
    ListVersionsByFunctionCommand,

    ListLayerVersionsCommand,
    GetLayerVersionCommand,
    PublishLayerVersionCommand,
    DeleteLayerVersionCommand,

    ListAliasesCommand
} from "@aws-sdk/client-lambda";

export class Lambda {

    constructor(config) {
        this.config = config;

        const aws = {};
        if (config.args.region) {
            aws['region'] = config.args.region;
        }
        if (config.args.accessKeyId && config.args.secretAccessKey) {
            aws['credentials'] = {
                accessKeyId: config.args.accessKeyId,
                secretAccessKey: config.args.secretAccessKey
            };
        }

        this.client = new LambdaClient(aws);
        this.functionInfo = {};
        this.layerInfo = {};

        this.task = {
            functions: {},
            layer: {
                operation: 'none',
                hash: '',
                arn: ''
            }
        };
        
    }

    // -----------------------------------------------------------------------------
    // タスクの確定
    async makeTask() {
        await Promise.all([
            this.collectFunctionsInfo(),
            this.collectCurrentLayerInfo(this.config.doc.service)
        ]);

    }

    // 設定ファイルで指定された関数の情報取得
    async collectFunctionsInfo() {
        const functions = this.config.doc.functions;
        const wait = [];
        for (const key in functions) {
            const func = functions[key];
            wait.push(this.collectFunctionInfo(func.name));
        }
        await Promise.all(wait);

    }


    // Lambda関数情報取得
    async collectFunctionInfo(name) {
        const input = {
            FunctionName: name
        };
        const command = new GetFunctionConfigurationCommand(input);
        try {
            const response = await this.client.send(command);
            this.functionInfo[name] = response;
            this.task.functions[name] = 'update';

        } catch(e) {
            // function not exists
            this.task.functions[name] = 'create';
            return;
        };
    }

    // Lambdaレイヤー情報取得
    async collectCurrentLayerInfo(layerName) {
        // package.jsonが存在しない場合はnpm未使用
        // レイヤーは作成しない
        if (!fs.existsSync('package.json')) {
            return;
        }

        const hash = await this.calcLayerHash();
        const input = {
            LayerName: layerName,
            MaxItems: 1
        };
        const command = new ListLayerVersionsCommand(input);

        try {
            const response = await this.client.send(command);
            this.layerInfo = response.LayerVersions[0];
            if (this.layerInfo.Description === hash) {
                this.task.layer = {
                    operation: 'same',
                    hash: hash,
                    arn: this.layerInfo.LayerVersionArn
                };

            } else {
                this.task.layer = {
                    operation: 'create',
                    hash: hash,
                    arn: ''
                };
            }

        } catch(e) {
            console.info(`${layerName} not found.`);
            this.task.layer = {
                operation: 'create',
                hash: hash,
                arn: ''
            };
        }

        /*
        const input = {
            LayerName: layerName,
            VersionNumber: 2,
        };
        const command = new GetLayerVersionCommand(input);
        const response = await this.client.send(command);
        console.log(response);
        */
        /*
        CodeSize: 5076264,
        CodeSha256: '/Al/lUeVbQz0drSiMmq9eBBSPykrENUZmeFvJ41ZM88=',
        */
    }

    // package.jsonに記載されているdependenciesの内容からhash値を生成
    async calcLayerHash() {
        const packageInfo = JSON.parse(fs.readFileSync('package.json'));
        const keys = [];
        for (const key in packageInfo.dependencies) {
            keys.push(key+packageInfo.dependencies[key]);
        }
        
        const hash = crypto.createHash('sha256').update(keys.join()).digest('base64')
        return hash;
    }


    // -----------------------------------------------------------------------------
    // 更新処理
    async deploy() {
        // 関数の更新とレイヤーの作成は並行して行える
        if (this.task.layer.operation === 'create') {
            console.info('create layer zip');
            const layerInfo = await this.createLayer(this.config.doc.service);
            // {layerZip:output, layerHash:layerHash};
            this.task.layer.hash = layerInfo.layerHash;
            this.task.layer.arn = layerInfo.layerArn;
        }

        console.info('create code zip');
        const codeZip = await this.createZipCode();

        const functions = this.config.doc.functions;
        for (const key in functions) {
            const func = functions[key];
            // 関数の新規作成
            if (this.task.functions[func.name] === 'create') {

            // 内容の更新
            } else {
                // コード更新
                await this.updateFunction(func.name, codeZip);
            }

            // バージョンの発行
             await this.publishVersion(func.name);
        }
        
    }

    // 関数の新規作成
    async createFunction(name, codeZip) {
        const input = { // CreateFunctionRequest
            FunctionName: name, // required
            Runtime: "nodejs20.x",
            Role: "arn:aws:iam::265923412663:role/LambdaRole", // required
            Handler: "index.handler",
        
            Code: {
              ZipFile: codeZip
            },
            Description: "debug Description",
            Timeout: 50,
            MemorySize: 256,
            Publish: true,
            PackageType: "Zip",
            //Layers: [ // LayerList
            //  "STRING_VALUE",
            //],
        };
        const command = new CreateFunctionCommand(input);
        const response = await client.send(command);

        await this.waitFunctionUpdate(name);
    }

    // 関数のコード更新
    async updateFunction(name, codeZip) {
        const input = {
            FunctionName: name, // required
            ZipFile: codeZip
        };

        const command = new UpdateFunctionCodeCommand(input);
        const response = await this.client.send(command);

        await this.waitFunctionUpdate(name);

        const inputConfig = {
            FunctionName: name, // required
        }

        if (this.task.layer.operation !== 'none') {
            if (!inputConfig.Layers) {
                inputConfig.Layers = [this.task.layer.arn];
            } else {
                inputConfig.Layers.push(this.task.layer.arn);
            }
        }
        console.log(inputConfig);

        const commandConfig = new UpdateFunctionConfigurationCommand(inputConfig);
        const responseConfig = await this.client.send(commandConfig);

        await this.waitFunctionUpdate(name);

    }

    // バージョン発行
    async publishVersion(name) {
        const input = {
            FunctionName: name, // required
            Description: '',
        };

        const command = new PublishVersionCommand(input);
        const response = await this.client.send(command);
        
    }


    // ソースコードをzip圧縮
    async createZipCode() {
        let ignore = [];
        if (this.config.doc.package && this.config.doc.package.ignore) {
            ignore = this.config.doc.package.ignore;
        }
        ignore.push('node_modules/**');

        const output = new WriteStream();
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });
      
        archive.pipe(output);
        archive.glob('**/*', {
            cwd: this.config.dir,
            ignore: ignore
        });
        await archive.finalize();

        return output.blob;
    }

    // レイヤーのzip作成
    async createLayer(name) {
        const copyFiles = ['package.json'];
        if (fs.existsSync('package-lock.json')) {
            copyFiles.push('package-lock.json');
        }
        
        const tempdir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-'));
        console.info(tempdir);
        
        for (const copyFile of copyFiles) {
            fs.copyFileSync(copyFile, path.join(tempdir, copyFile));
        }
        
        // node_modulesを取得
        // ここはPromiseにしないといけない
        const child = spawn('npm', 
            ['install', '--omit=dev', `--prefix=${tempdir}`, '--cpu=x86_64', '--os=linux'],
            { shell: true, stdio: 'inherit' }
        );

        const exitCode = await new Promise( (resolve, reject) => {
            child.on('close', resolve);
        });
    
        if(exitCode) {
            throw new Error( `subprocess error exit ${exitCode}`);
        }

        const output = new WriteStream();
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });
        
        archive.pipe(output);
        archive.directory(tempdir, false);
        
        await archive.finalize();
        
        const layerHash = await this.calcLayerHash();

        // tmpディレクトリ削除
        await fs.promises.rm(tempdir, { recursive: true, force: true })

        // layer作成
        const input = { // PublishLayerVersionRequest
            LayerName: name, // required
            Description: layerHash,
            Content: { // LayerVersionContentInput
              ZipFile: output.blob,
            }
        };
        const command = new PublishLayerVersionCommand(input);
        const response = await this.client.send(command);
        console.log(response);

        return {layerArn:response.LayerVersionArn, layerHash:layerHash};
    }


    // 関数が更新されるのを待機
    async waitFunctionUpdate(name) {
        const input = {
            FunctionName: name
        };
        const command = new GetFunctionConfigurationCommand(input);
        
        for (let i = 0; i < 100; i++) {
            const response = await this.client.send(command);
            console.log(response.LastUpdateStatus);
            if (response.LastUpdateStatus === 'Successful') {
                return;

            } else if (response.LastUpdateStatus === 'Failed') {
                throw Error(`Function ${name} update failed.`);
            }

            await setTimeout(1000);
        }

        throw Error(`WaitFunctionUpdate ${name} time out.`);
    }


    // -----------------------------------------------------------------------------
    // 不要なバージョン削除
    async clean() {
        // functionの未使用バージョン削除
        // layerの未使用バージョン削除
        //await this.getFunctionVersionList();

        

        //const layerList = await this.getLayerList(this.config.doc.service);
        //console.log(layerList);
        const input = {
            FunctionName: 'debug'
        };
        const command = new ListAliasesCommand(input);
        const response = await this.client.send(command);

        for (const a of response.Aliases) {
            // このバージョンはエイリアスで使用されているので削除禁止
            console.log(a.FunctionVersion);
        }

        console.log(response);
        
    }



    // -----------------------------------------------------------------------------
    // 関数バージョン情報取得
    async getFunctionVersionList() {

        // 関数に存在するバージョン情報取得
        // ここからはどのバージョンにエイリアスが設定されているかは特定できない
        const input = {
            FunctionName: 'debug'
        };
        const command = new ListVersionsByFunctionCommand(input);
        const response = await this.client.send(command);
        for (const v of response.Versions) {
            // $LASTESTを含むバージョン情報
            console.log(v.Version);
            if (!v.Layers) {
                continue;
            }
            for (const l of v.Layers) {
                // 使用しているレイヤーArn
                // ここに含まれていないレイヤーは削除可能判定
                console.log(l.Arn);
            }

        }
    }


    // レイヤー情報取得
    async getLayerList(layerName) {
        const input = {
            LayerName: layerName
        };
        const command = new ListLayerVersionsCommand(input);
        const response = await this.client.send(command);
        console.log(response);
    }










    async test() {
        const inputConfig = {
            FunctionName: 'debug', // required
        }

        inputConfig.Layers = ['arn:aws:lambda:ap-northeast-1:265923412663:layer:debug:3'];

        const commandConfig = new UpdateFunctionConfigurationCommand(inputConfig);
        const responseConfig = await this.client.send(commandConfig);
    }



}


class WriteStream extends Writable {
    _construct(callback) {
        this.blob = Buffer.alloc(0);
        this.chunks = [];
        callback();
    }
    _write(chunk, encoding, callback) {
        this.chunks.push(chunk);
        if (2048 < this.chunks.length) {
            this.blob = Buffer.concat([this.blob, ...this.chunks]);
            this.chunks = [];
        }
        callback();
    }
    _destroy(err, callback) {
        if (this.chunks.length) {
            this.blob = Buffer.concat([this.blob, ...this.chunks]);
            this.chunks = [];
        }
        callback();
    }
} 