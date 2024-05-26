import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { Writable } from 'node:stream';
import archiver from 'archiver';

import {
    LambdaClient,
    CreateFunctionCommand,
    UpdateFunctionCodeCommand,
    UpdateFunctionConfigurationCommand,
    PublishVersionCommand,
    GetFunctionConfigurationCommand,

    ListLayerVersionsCommand,
    GetLayerVersionCommand,
    PublishLayerVersionCommand,
    DeleteLayerVersionCommand
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
        
    }

    async getFunctionsInfo() {
        const functions = this.config.doc.functions;
        const wait = [];
        for (const key in functions) {
            const func = functions[key];
            wait.push(this.getFunctionInfo(func.name));
        }
        await Promise.all(wait);

    }

    async getFunctionInfo(name) {
        const input = {
            FunctionName: name
        };
        const command = new GetFunctionConfigurationCommand(input);
        try {
            const response = await this.client.send(command);
            this.functionInfo[name] = response;
            console.log(response);

        } catch(e) {
            // function not exists
            return;
        };

        // レイヤー情報が存在したら情報取得


    }


    async createLayers() {
        const functions = this.config.doc.functions;
        const wait = [];
        for (const key in functions) {
            const func = functions[key];
            wait.push(this.createLayer(func.name));
        }
        await Promise.all(wait);
    }

    async createLayer(name) {
        console.log(name);

        const copyFiles = [];
        if (fs.existsSync('package.json')) {
            copyFiles.push('package.json');
        } else {
            // package.jsonがなければレイヤーを作成しない
            return;
        }
        
        if (fs.existsSync('package-lock.json')) {
            copyFiles.push('package-lock.json');
        }
        
        const tempdir = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-'));
        console.log(tempdir);
        
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

        const zipArchive = async targetDir => {
            const zipPath = `test.zip`;
            //const output = fs.createWriteStream(zipPath);
            const output = new WriteStream();
          
            const archive = archiver('zip', {
                zlib: { level: 9 }
            });
          
            archive.pipe(output);
            archive.directory(targetDir, false);
          
            await archive.finalize();

            return output;
          }
          
        
        const output = await zipArchive(tempdir);
        const layerHash = await this.calcLayerHash();
        
        //fs.writeFileSync('debug.zip', output.blob, 'binary');
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

        //const h = crypto.createHash('sha256').update(output.blob).digest('base64')
        //console.log(h);
        //console.log(output.blob.length);
        /*
          CreatedDate: '2024-05-26T08:44:58.939+0000',
  Description: '',
  LayerArn: 'arn:aws:lambda:ap-northeast-1:265923412663:layer:debug',
  LayerVersionArn: 'arn:aws:lambda:ap-northeast-1:265923412663:layer:debug:2',
  Version: 2
        */
        
        console.log('end');

    }


    async getLayer() {
        /*
        const input = {
            LayerName: 'debug'
        };
        const command = new ListLayerVersionsCommand(input);
        const response = await this.client.send(command);
        console.log(response);

        */

        const input = {
            LayerName: 'debug',
            VersionNumber: 2,
        };
        const command = new GetLayerVersionCommand(input);
        const response = await this.client.send(command);
        console.log(response);
        /*
        CodeSize: 5076264,
        CodeSha256: '/Al/lUeVbQz0drSiMmq9eBBSPykrENUZmeFvJ41ZM88=',
        */
    }

    async calcLayerHash() {
        const packageInfo = JSON.parse(fs.readFileSync('package.json'));
        const keys = [];
        for (const key in packageInfo.dependencies) {
            keys.push(key+packageInfo.dependencies[key]);
        }
        
        const h = crypto.createHash('sha256').update(keys.join()).digest('base64')
        return h;
    }


    // create or update function
    async update() {
        const zipArchive = async targetDir => {
            const zipPath = `test.zip`;
            //const output = fs.createWriteStream(zipPath);
            const output = new WriteStream();
          
            const archive = archiver('zip', {
                zlib: { level: 9 }
            });
          
            archive.pipe(output);
            archive.glob('**/*', {
                cwd: this.config.dir,
                ignore: ['node_modules/**']
            });
          
            await archive.finalize();

            return output;
          }
          
        
        const output = await zipArchive('');
        //fs.writeFileSync('function.zip', output.blob, 'binary');

        /*
const input = { // CreateFunctionRequest
    FunctionName: "debug", // required
    Runtime: "nodejs20.x",
    Role: "arn:aws:iam::265923412663:role/LambdaRole", // required
    Handler: "index.handler",

    Code: {
      //ZipFile: new Uint8Array(), // e.g. Buffer.from("") or new TextEncoder().encode("")
      ZipFile: zipdata
    },
    Description: "debug Description",
    Timeout: 50,
    MemorySize: 256,
    Publish: true,
    PackageType: "Zip",
    //},
    //Layers: [ // LayerList
    //  "STRING_VALUE",
    //],
};
const command = new CreateFunctionCommand(input);
const response = await client.send(command);
console.log(response);
*/

        const input = {
            FunctionName: "debug", // required
            ZipFile: output.blob
        };

        const command = new UpdateFunctionCodeCommand(input);
        const response = await this.client.send(command);
        console.log(response);


    }

    async publishVersion() {
        const input = {
            FunctionName: "debug", // required
            Description: 'Description'
        };

        const command = new PublishVersionCommand(input);
        const response = await this.client.send(command);
        console.log(response);
        
    }

    async test() {
        const h = await this.calcLayerHash();
        console.log(h);
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