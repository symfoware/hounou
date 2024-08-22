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
    DeleteFunctionCommand,

    ListLayerVersionsCommand,
    PublishLayerVersionCommand,
    DeleteLayerVersionCommand,

    ListAliasesCommand
} from "@aws-sdk/client-lambda";

export class Lambda {

    // -----------------------------------------------------------------------------
    // 引数、設定ファルの解析
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

        // 既存の関数が存在すれば上書き、存在しなければ新規作成
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
        
        // package.jsonからレイヤー識別用のハッシュ値を作成
        const hash = await this.calcLayerHash();

        // 初期値はレイヤー作成モード
        this.task.layer = {
            operation: 'create',
            hash: hash,
            arn: ''
        };

        // 最新のレイヤー情報を取得
        const input = {
            LayerName: layerName,
            MaxItems: 1
        };
        const command = new ListLayerVersionsCommand(input);

        try {
            const response = await this.client.send(command);
            // レイヤー情報なし
            if (response.LayerVersions.length == 0) {
                console.info(`${layerName} not found. create mode.`);
                return;
            }

            this.layerInfo = response.LayerVersions[0];
            // ハッシュ値が異なれば新規作成
            if (this.layerInfo.Description !== hash) {
                console.info(`${layerName} changed. create mode.`);
                return;
            }

            // Layer更新なし
            this.task.layer = {
                operation: 'same',
                hash: hash,
                arn: this.layerInfo.LayerVersionArn
            };

        } catch(e) {
            console.info(`${layerName} not found. create mode.`);
        }

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

        // レイヤー新規作成実行
        if (this.task.layer.operation === 'create') {
            console.info('Create Layer zip');
            const layerInfo = await this.createLayer(this.config.doc.service);
            // {layerZip:output, layerHash:layerHash};
            this.task.layer.hash = layerInfo.layerHash;
            this.task.layer.arn = layerInfo.layerArn;
        }

        console.info('Create Code zip');
        const codeZip = await this.createZipCode();

        const functions = this.config.doc.functions;
        for (const key in functions) {
            const func = functions[key];
            let mode = '';
            // 関数の新規作成
            if (this.task.functions[func.name] === 'create') {
                await this.createFunction(func.name, codeZip);
                mode = 'Create';

            // 内容の更新
            } else {
                // コード更新
                await this.updateFunction(func.name, codeZip);
                mode = 'Update';

            }

            // バージョンの発行
             await this.publishVersion(func.name);

             console.info(`${mode} Function ${func.name}`);
        }
        
    }

    // 関数の新規作成
    async createFunction(name, codeZip) {
        // 関数作成用の設定情報取得
        const inputConfig = this.config.getFunctionCreateInfo(name);

        inputConfig['Code'] = {
            ZipFile: codeZip
        };

        if (this.task.layer.operation !== 'none') {
            if (!inputConfig.Layers) {
                inputConfig.Layers = [this.task.layer.arn];
            } else {
                inputConfig.Layers.push(this.task.layer.arn);
            }
        }

        const command = new CreateFunctionCommand(inputConfig);
        const response = await this.client.send(command);

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

        // 関数更新待ち
        await this.waitFunctionUpdate(name);

        // 設定情報更新用の内容を取得
        const inputConfig = this.config.getFunctionUpdateInfo(name);

        if (this.task.layer.operation !== 'none') {
            if (!inputConfig.Layers) {
                inputConfig.Layers = [this.task.layer.arn];
            } else {
                inputConfig.Layers.push(this.task.layer.arn);
            }
        }

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

    // レイヤーのzip作成とレイヤーの作成
    async createLayer(name) {
        const copyFiles = ['package.json'];
        if (fs.existsSync('package-lock.json')) {
            copyFiles.push('package-lock.json');
        }
        
        // npmで作成した一時領域にパッケージを取得
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

        // 一時領域に取得したパッケージをzip圧縮
        const output = new WriteStream();
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });
        
        archive.pipe(output);
        archive.directory(tempdir, false);
        
        await archive.finalize();
        
        // レイヤーのハッシュ値を取得
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
        console.info(`Create Layer: ${response.LayerVersionArn}`);

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
            if (response.LastUpdateStatus === 'Successful') {
                return;

            } else if (response.LastUpdateStatus === 'Failed') {
                throw Error(`Function ${name} update failed.`);
            } else {
                console.info('Waiting Update...');
            }

            await setTimeout(1000);
        }

        throw Error(`WaitFunctionUpdate ${name} time out.`);
    }


    // -----------------------------------------------------------------------------
    // 不要なバージョン削除
    async clean() {

        // 設定ファイル必須項目チェック
        const prune = this.config.doc.custom?.prune;
        if (!prune) {
            return;
        }

        if (!prune.number) {
            return;
        }

        // 未削除とした関数のバージョン情報
        let leaveVersions = [];          

        // 各関数ごとに削除可能なバージョン検索
        const functions = this.config.doc.functions;
        for (const key in functions) {
            const func = functions[key];
            
            // 使用/未使用な関数バージョンを取得
            const [usedVersions, unusedVersions] = await this.getFunctionVersionUnused(func.name);

            // 未使用関数の削除実行
            while(unusedVersions.length > prune.number) {
                const unused = unusedVersions.shift();
                await this.deleteFunction(func.name, unused.version);
            }

            // 未削除となったバージョンと削除不可バージョンの情報退避
            leaveVersions = leaveVersions.concat(unusedVersions);
            leaveVersions = leaveVersions.concat(usedVersions);

        }

        // レイヤーも削除する設定かチェック
        if (!prune.includeLayers) {
            return;
        }

        // 使用しているレイヤーArnを退避
        const leaveLayerArn = new Set();
        for (const v of leaveVersions) {
            for (const layer of v.layers) {
                leaveLayerArn.add(layer);
            }
        }
        //console.log(leaveLayerArn);

        // レイヤー情報取得
        const layerName = this.config.doc.service;
        const layerList = await this.getLayerList(layerName);
        
        // 未使用レイヤーの削除実行
        while(layerList.length > prune.number) {
            const unused = layerList.shift();
            // 使用中なら削除スキップ
            if (leaveLayerArn.has(unused.arn)) {
                continue;
            }

            await this.deleteLayer(layerName, unused.version)
        }

    }



    // -----------------------------------------------------------------------------
    // 削除可能な関数情報の取得
    async getFunctionVersionUnused(name) {
        const [ versions, aliaseVersions ] = await Promise.all([
            this.getFunctionVersionList(name),
            this.getAliasesVersionList(name)
        ]);

        // $LATESTも削除禁止に追加
        aliaseVersions.push('$LATEST');

        // エイリアスとして指定されているバージョンにマーク
        const usedversions = [];
        const unusedversions = [];
        // 使用/未使用バージョンに振り分け
        for (const v of versions) {
            // 使用バージョン
            if (aliaseVersions.includes(v.version)) {
                usedversions.push(v);
            } else {
                unusedversions.push(v);
            }
        }
        
        return [usedversions, unusedversions];

    }

    // 関数バージョン情報取得
    async getFunctionVersionList(name) {

        // 関数に存在するバージョン情報取得
        // ここからはどのバージョンにエイリアスが設定されているかは特定できない
        const input = {
            FunctionName: name
        };
        const command = new ListVersionsByFunctionCommand(input);
        const response = await this.client.send(command);
        
        const versions = [];
        for (const v of response.Versions) {
            // $LASTESTを含むバージョン情報
            const layers = [];
            if (v.Layers) {
                for (const l of v.Layers) {
                    // 使用しているレイヤーArn
                    // ここに含まれていないレイヤーは削除可能判定
                    layers.push(l.Arn);
                }
            }
            versions.push({
                version: v.Version,
                layers: layers
            });
        }

        return versions;
    }

    // エイリアス情報取得
    async getAliasesVersionList(name) {
        const input = {
            FunctionName: name
        };
        const command = new ListAliasesCommand(input);
        const response = await this.client.send(command);

        const versions = [];
        for (const aliase of response.Aliases) {
            // このバージョンはエイリアスで使用されているので削除禁止
            versions.push(aliase.FunctionVersion);
        }

        return versions;
    }


    // レイヤー情報取得
    async getLayerList(layerName) {
        const input = {
            LayerName: layerName
        };
        const command = new ListLayerVersionsCommand(input);
        const response = await this.client.send(command);

        const layers = [];
        for (const layer of response.LayerVersions) {
            // 最新の情報から取得なので、逆順で追加
            layers.unshift({
                arn: layer.LayerVersionArn,
                version: layer.Version
            });
        }
        return layers;
    }


    // 指定関数バージョンの削除
    async deleteFunction(name, version) {
        const input = {
            FunctionName: `${name}:${version}`
        };
        
        const command = new DeleteFunctionCommand(input)
        const response = await this.client.send(command);
    }

    // 指定レイヤーバージョンの削除
    async deleteLayer(layerName, version) {
        DeleteLayerVersionCommand
        const input = { // DeleteLayerVersionRequest
            LayerName: layerName, // required
            VersionNumber: version, // required
        };
        const command = new DeleteLayerVersionCommand(input);
        const response = await this.client.send(command);
        
    }

}




// -----------------------------------------------------------------------------
// Zipストリーム作成
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